// Supabase Edge Function — create-facture
//
// Remplace les appels directs supaReq() pour getNextFactureNumber(),
// saveFacture(), findFactureByCommandeId() depuis index.html.
//
// Actions :
//   find   — cherche une facture par commande_id (idempotence)
//   create — crée une facture de façon atomique (check unicité + numéro + insert)
//
// Authentification :
//   - action=create avec commande_id : vérifie que la commande existe et est payée
//     (statut != 'pending_payment') — utilisé après paiement Stripe par le client
//   - action=create avec emp_token   : employé peut créer sans commande_id (paiement sur place)
//   - action=find avec commande_id   : libre (idempotence check par le client)
//   - action=find avec emp_token     : accès employé
//
// Idempotence : commande_id est une clé unique sur factures — pas de doublon possible.
//
// Secrets requis : EMP_TOKEN_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

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

async function verifyEmpToken(token: string, secret: string): Promise<boolean> {
  try {
    const dot = token.lastIndexOf('.');
    if (dot === -1) return false;
    const data   = token.slice(0, dot);
    const sigB64 = token.slice(dot + 1);
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const sig   = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(data));
    if (!valid) return false;
    const payload = JSON.parse(atob(data));
    return !(!payload.exp || payload.exp < Date.now());
  } catch { return false; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const body = await req.json();
    const { action, emp_token, commande_id, data: factureData } = body;

    if (!action) return json({ error: 'action requise' }, 400);

    const secret = Deno.env.get('EMP_TOKEN_SECRET') ?? 'kbb-default-secret-change-me';
    const isEmp = emp_token ? await verifyEmpToken(emp_token, secret) : false;

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY'))!
    );

    // ── FIND ──────────────────────────────────────────────────────────────
    if (action === 'find') {
      if (!commande_id) return json({ error: 'commande_id requis' }, 400);

      const { data: rows, error } = await supabase
        .from('factures')
        .select('*')
        .eq('commande_id', String(commande_id))
        .limit(1);

      if (error) {
        console.error('[create-facture] find:', error.message);
        return json({ error: 'Erreur base de données' }, 500);
      }
      return json({ facture: (rows ?? [])[0] ?? null });
    }

    // ── CREATE ─────────────────────────────────────────────────────────────
    if (action === 'create') {
      if (!factureData || typeof factureData !== 'object') {
        return json({ error: 'data requis' }, 400);
      }

      // ── Auth : emp_token OU commande payée (statut != pending_payment) ──
      if (!isEmp) {
        if (!commande_id) {
          return json({ error: 'emp_token ou commande_id requis' }, 401);
        }
        // Vérifier que la commande existe et est payée
        const { data: cmdRows, error: cmdErr } = await supabase
          .from('commandes')
          .select('id, statut')
          .eq('id', String(commande_id))
          .limit(1);

        if (cmdErr) return json({ error: 'Erreur base de données' }, 500);
        const cmd = (cmdRows ?? [])[0];
        if (!cmd) return json({ error: 'Commande introuvable' }, 404);
        if (cmd.statut === 'pending_payment') {
          return json({ error: 'Paiement non confirmé' }, 402);
        }
      }

      // ── Idempotence : chercher facture existante ──────────────────────────
      if (commande_id) {
        const { data: existing } = await supabase
          .from('factures')
          .select('*')
          .eq('commande_id', String(commande_id))
          .limit(1);
        if (existing && existing.length > 0) {
          console.log(`[create-facture] idempotent commande_id=${commande_id} → ${existing[0].numero_facture}`);
          return json({ ok: true, facture: existing[0], already_exists: true });
        }
      }

      // ── Calculer le prochain numéro FAC-YYYY-NNNNN ────────────────────────
      const year = new Date().getFullYear();
      const { data: yearRows, error: yearErr } = await supabase
        .from('factures')
        .select('id')
        .gte('date', `${year}-01-01T00:00:00Z`)
        .lt('date', `${year + 1}-01-01T00:00:00Z`);

      if (yearErr) {
        console.error('[create-facture] count:', yearErr.message);
        return json({ error: 'Erreur base de données' }, 500);
      }
      const nextN = (yearRows ?? []).length + 1;
      const numero_facture = factureData.numero_facture || ('FAC-' + year + '-' + String(nextN).padStart(5, '0'));

      // ── Insertion ─────────────────────────────────────────────────────────
      const payload: Record<string, unknown> = {
        ...factureData,
        numero_facture,
      };
      if (commande_id) payload.commande_id = String(commande_id);

      const { data: inserted, error: insertErr } = await supabase
        .from('factures')
        .insert(payload)
        .select('*')
        .maybeSingle();

      if (insertErr) {
        console.error('[create-facture] insert:', insertErr.message);
        // Doublon concurrent
        if (insertErr.code === '23505') {
          const { data: retry } = await supabase
            .from('factures')
            .select('*')
            .eq('commande_id', String(commande_id))
            .limit(1);
          if (retry && retry.length > 0) return json({ ok: true, facture: retry[0], already_exists: true });
        }
        return json({ error: 'Erreur base de données: ' + insertErr.message }, 500);
      }

      console.log(`[create-facture] créée ${numero_facture} commande_id=${commande_id ?? '—'}`);
      return json({ ok: true, facture: inserted });
    }

    return json({ error: `action inconnue: ${action}` }, 400);

  } catch (err) {
    console.error('[create-facture] erreur fatale:', (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});
