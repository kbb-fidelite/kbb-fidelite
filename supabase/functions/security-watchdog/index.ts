// Supabase Edge Function — security-watchdog
//
// Surveillance anti-fraude automatique. Exécutée chaque nuit à 4h via pg_cron.
// Envoie une notification push récapitulative au patron UNIQUEMENT si anomalie(s).
// Résultats loggés dans watchdog_logs à chaque exécution.
//
// Contrôles :
//   1. Cagnottes incohérentes (cagnotte > points_cumul)
//   2. Variations anormales de cagnotte (>100 pts en 24h)
//   3. Commandes fantômes (en_attente > 24h)
//   4. (Manuel) Écart Stripe vs base — non implémenté, vérification manuelle mensuelle
//   5. Tentatives d'intrusion (>10 verrouillages PIN en 24h)
//
// Authentification :
//   - internal_secret (appel inter-fonctions via pg_cron / invoke)
//   - emp_token avec rôle patron (appel manuel depuis dashboard)
//
// Secrets requis :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injectés)
//   EMP_TOKEN_SECRET (pour auth + appel send-push-notification)
//   WATCHDOG_TEL (téléphone du patron pour la notification push)
//
// Déploiement : supabase functions deploy security-watchdog

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function verifyEmpToken(token: string, secret: string): Promise<{ role: string } | null> {
  try {
    const dot = token.lastIndexOf('.');
    if (dot === -1) return null;
    const data   = token.slice(0, dot);
    const sigB64 = token.slice(dot + 1);
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const sig   = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(data));
    if (!valid) return null;
    const payload = JSON.parse(atob(data));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

// Masque un téléphone : 0612345678 → …5678
function mask(tel: string): string {
  return '…' + String(tel).slice(-4);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const body = await req.json().catch(() => ({}));
    const { emp_token, internal_secret } = body as Record<string, string>;

    // ── Authentification ──────────────────────────────────────────
    const empSecret = Deno.env.get('EMP_TOKEN_SECRET') ?? 'kbb-default-secret-change-me';
    const isInternal = typeof internal_secret === 'string' && internal_secret === empSecret;

    let isPatron = false;
    if (!isInternal && emp_token) {
      const payload = await verifyEmpToken(emp_token, empSecret);
      isPatron = payload?.role === 'patron';
    }

    if (!isInternal && !isPatron) {
      return json({ error: 'Non autorisé — rôle patron ou internal_secret requis' }, 401);
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const alertes: string[] = [];
    const detail: Record<string, unknown> = {};
    const now = new Date();
    const cutoff24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

    // ═══════════════════════════════════════════════════════════════
    // CONTRÔLE 1 — Cagnottes incohérentes (cagnotte > points_cumul)
    // ═══════════════════════════════════════════════════════════════
    const { data: c1Rows, error: c1Err } = await supabase
      .from('clients')
      .select('telephone, cagnotte, points_cumul')
      .gt('cagnotte', supabase.rpc ? 0 : 0); // fallback — on filtre en JS

    if (c1Err) {
      console.error('[watchdog] C1 erreur:', c1Err.message);
      detail.c1_error = c1Err.message;
    } else {
      const suspects = (c1Rows ?? []).filter(
        (r: { cagnotte: number; points_cumul: number }) =>
          parseFloat(String(r.cagnotte)) > parseFloat(String(r.points_cumul))
      );
      if (suspects.length > 0) {
        alertes.push(`⚠️ ${suspects.length} client(s) avec cagnotte suspecte (cagnotte > cumul)`);
        detail.c1_suspects = suspects.map(
          (r: { telephone: string; cagnotte: number; points_cumul: number }) => ({
            tel: mask(r.telephone),
            cagnotte: r.cagnotte,
            points_cumul: r.points_cumul,
          })
        );
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // CONTRÔLE 2 — Variations anormales de cagnotte (>100 pts/24h)
    //   Compare avec snapshot de la veille dans snapshots_fidelite
    // ═══════════════════════════════════════════════════════════════

    // Charger les cagnottes actuelles
    const { data: allClients, error: acErr } = await supabase
      .from('clients')
      .select('telephone, cagnotte, points_cumul');

    if (acErr) {
      console.error('[watchdog] C2 lecture clients:', acErr.message);
      detail.c2_error = acErr.message;
    } else {
      const clients = allClients ?? [];

      // Charger le dernier snapshot
      const { data: lastSnaps } = await supabase
        .from('snapshots_fidelite')
        .select('telephone, cagnotte, points_cumul')
        .gte('snapshot_date', cutoff24h);

      const snapMap = new Map<string, { cagnotte: number; points_cumul: number }>();
      for (const s of (lastSnaps ?? [])) {
        snapMap.set(s.telephone, { cagnotte: s.cagnotte, points_cumul: s.points_cumul });
      }

      const anomalies: { tel: string; avant: number; apres: number; delta: number }[] = [];
      for (const c of clients) {
        const prev = snapMap.get(c.telephone);
        if (prev) {
          const delta = parseFloat(String(c.cagnotte)) - parseFloat(String(prev.cagnotte));
          if (delta > 100) {
            anomalies.push({
              tel: mask(c.telephone),
              avant: prev.cagnotte,
              apres: parseFloat(String(c.cagnotte)),
              delta: Math.round(delta),
            });
          }
        }
      }

      if (anomalies.length > 0) {
        alertes.push(`🚨 ${anomalies.length} client(s) avec variation cagnotte >100 pts en 24h`);
        detail.c2_anomalies = anomalies;
      }

      // ── Sauvegarder le snapshot du jour ──────────────────────────
      const today = now.toISOString().slice(0, 10); // YYYY-MM-DD
      const snapRows = clients.map(
        (c: { telephone: string; cagnotte: number; points_cumul: number }) => ({
          telephone: c.telephone,
          cagnotte: parseFloat(String(c.cagnotte)),
          points_cumul: parseFloat(String(c.points_cumul)),
          snapshot_date: today,
        })
      );

      if (snapRows.length > 0) {
        // Supprimer les anciens snapshots du même jour (idempotence si relancé)
        await supabase
          .from('snapshots_fidelite')
          .delete()
          .eq('snapshot_date', today);

        // Insérer par lots de 500
        for (let i = 0; i < snapRows.length; i += 500) {
          const batch = snapRows.slice(i, i + 500);
          const { error: snapErr } = await supabase
            .from('snapshots_fidelite')
            .insert(batch);
          if (snapErr) {
            console.error('[watchdog] snapshot insert batch', i, ':', snapErr.message);
          }
        }

        // Purger les snapshots > 7 jours
        const purgeDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
          .toISOString().slice(0, 10);
        await supabase
          .from('snapshots_fidelite')
          .delete()
          .lt('snapshot_date', purgeDate);
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // CONTRÔLE 3 — Commandes fantômes (en_attente > 24h)
    // ═══════════════════════════════════════════════════════════════
    const { data: c3Rows, error: c3Err } = await supabase
      .from('commandes')
      .select('id, created_at, montant')
      .eq('statut', 'en_attente')
      .lt('created_at', cutoff24h);

    if (c3Err) {
      console.error('[watchdog] C3 erreur:', c3Err.message);
      detail.c3_error = c3Err.message;
    } else {
      const fantomes = c3Rows ?? [];
      if (fantomes.length > 0) {
        alertes.push(`👻 ${fantomes.length} commande(s) fantôme(s) en attente >24h`);
        detail.c3_fantomes = fantomes.map(
          (c: { id: string; created_at: string; montant: number }) => ({
            id: c.id, created_at: c.created_at, montant: c.montant,
          })
        );
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // CONTRÔLE 4 — Écart Stripe vs base
    //   Non implémenté : l'API Stripe nécessite une clé secrète et
    //   une pagination complexe. Vérification manuelle mensuelle
    //   recommandée via le dashboard Stripe.
    // ═══════════════════════════════════════════════════════════════
    detail.c4_note = 'Vérification manuelle mensuelle via dashboard Stripe';

    // ═══════════════════════════════════════════════════════════════
    // CONTRÔLE 5 — Tentatives d'intrusion (>10 verrouillages/24h)
    // ═══════════════════════════════════════════════════════════════
    const { count: c5Count, error: c5Err } = await supabase
      .from('pin_attempts')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', cutoff24h);

    if (c5Err) {
      console.error('[watchdog] C5 erreur:', c5Err.message);
      detail.c5_error = c5Err.message;
    } else {
      const total = c5Count ?? 0;
      if (total > 10) {
        alertes.push(`🔒 Activité suspecte sur les accès : ${total} tentatives en 24h`);
        detail.c5_attempts = total;
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // Résultat — log + notification push si alertes
    // ═══════════════════════════════════════════════════════════════
    const logEntry = {
      run_date: now.toISOString(),
      alertes_count: alertes.length,
      detail: JSON.stringify(detail),
      alertes_resume: alertes.length > 0 ? alertes.join(' | ') : null,
    };

    const { error: logErr } = await supabase
      .from('watchdog_logs')
      .insert(logEntry);
    if (logErr) {
      console.error('[watchdog] log insert:', logErr.message);
    }

    console.log(`[security-watchdog] run terminé — ${alertes.length} alerte(s)`);

    // ── Notification push au patron si anomalie(s) ────────────────
    if (alertes.length > 0) {
      const patronTel = Deno.env.get('WATCHDOG_TEL');
      if (patronTel) {
        const title = `🛡️ KBB Sécurité : ${alertes.length} alerte(s)`;
        const pushBody = alertes.join('\n');
        const supaUrl = Deno.env.get('SUPABASE_URL')!;

        try {
          await fetch(`${supaUrl}/functions/v1/send-push-notification`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              client_tel: patronTel,
              title,
              body: pushBody,
              internal_secret: empSecret,
            }),
          });
          console.log(`[security-watchdog] push envoyée au patron (…${patronTel.slice(-4)})`);
        } catch (pushErr) {
          console.warn('[security-watchdog] push échouée (non bloquant):', pushErr);
        }
      } else {
        console.warn('[security-watchdog] WATCHDOG_TEL non configuré — push ignorée');
      }
    }

    return json({
      ok: true,
      alertes_count: alertes.length,
      alertes,
      detail,
    });

  } catch (err) {
    console.error('[security-watchdog] erreur fatale:', (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});
