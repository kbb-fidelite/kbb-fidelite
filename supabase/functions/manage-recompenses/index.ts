// Supabase Edge Function — manage-recompenses
// CRUD sur la table recompenses via service_role (bypass RLS).
// Requiert un token employé valide avec rôle "patron".
// L'écriture directe anon sur recompenses est impossible (RLS SELECT uniquement).
//
// Actions : create | update | delete | toggle
// Secrets requis : EMP_TOKEN_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injectés)
// Déploiement : supabase functions deploy manage-recompenses

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function verifyEmpToken(
  token: string,
  secret: string
): Promise<{ role: string; exp: number } | null> {
  try {
    const dot = token.lastIndexOf('.');
    if (dot === -1) return null;
    const data   = token.slice(0, dot);
    const sigB64 = token.slice(dot + 1);
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const sig   = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(data));
    if (!valid) return null;
    const payload = JSON.parse(atob(data));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json();
    const { action, emp_token, id, data } = body;

    // ── 1. Token requis ───────────────────────────────────────────
    if (!emp_token || typeof emp_token !== 'string') {
      return json({ error: 'Token manquant' }, 401);
    }

    // ── 2. Vérification HMAC + expiration ─────────────────────────
    const secret  = Deno.env.get('EMP_TOKEN_SECRET') ?? 'kbb-default-secret-change-me';
    const payload = await verifyEmpToken(emp_token, secret);
    if (!payload) {
      return json({ error: 'Token invalide ou expiré — reconnectez-vous' }, 401);
    }

    // ── 3. Rôle patron obligatoire ────────────────────────────────
    if (payload.role !== 'patron') {
      return json({ error: 'Accès réservé au patron' }, 403);
    }

    // ── 4. Client service_role (bypass RLS) ───────────────────────
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // ── 5. Actions ────────────────────────────────────────────────

    // CREATE
    if (action === 'create') {
      const { nom, points_requis, commande_minimum, ordre } = data || {};
      if (!nom || typeof nom !== 'string' || !points_requis) {
        return json({ error: 'nom et points_requis requis' }, 400);
      }
      const { data: rec, error } = await supabase
        .from('recompenses')
        .insert({
          nom: String(nom).trim(),
          points_requis: Math.max(1, parseInt(String(points_requis))),
          commande_minimum: Math.max(0, parseFloat(String(commande_minimum || 0))),
          actif: true,
          ordre: parseInt(String(ordre || 0)) || 0,
        })
        .select()
        .single();
      if (error) throw new Error('insert recompense: ' + error.message);
      console.log('manage-recompenses: créée id='+rec.id+' par patron');
      return json({ ok: true, recompense: rec });
    }

    // UPDATE
    if (action === 'update') {
      if (!id) return json({ error: 'id requis' }, 400);
      const safe: Record<string, unknown> = {};
      if (data?.nom       !== undefined) safe.nom              = String(data.nom).trim();
      if (data?.points_requis !== undefined) safe.points_requis = Math.max(1, parseInt(String(data.points_requis)));
      if (data?.commande_minimum !== undefined) safe.commande_minimum = Math.max(0, parseFloat(String(data.commande_minimum)));
      if (Object.keys(safe).length === 0) return json({ error: 'Aucun champ valide' }, 400);
      const { data: rec, error } = await supabase
        .from('recompenses').update(safe).eq('id', String(id)).select().single();
      if (error) throw new Error('update recompense: ' + error.message);
      console.log('manage-recompenses: mise à jour id='+id+' par patron');
      return json({ ok: true, recompense: rec });
    }

    // TOGGLE (activer / désactiver)
    if (action === 'toggle') {
      if (!id) return json({ error: 'id requis' }, 400);
      // Lire l'état actuel
      const { data: current, error: readErr } = await supabase
        .from('recompenses').select('actif').eq('id', String(id)).single();
      if (readErr) throw new Error('read recompense: ' + readErr.message);
      const nouvelEtat = !current.actif;
      const { data: rec, error } = await supabase
        .from('recompenses').update({ actif: nouvelEtat }).eq('id', String(id)).select().single();
      if (error) throw new Error('toggle recompense: ' + error.message);
      console.log('manage-recompenses: toggle id='+id+' → '+nouvelEtat+' par patron');
      return json({ ok: true, recompense: rec, actif: nouvelEtat });
    }

    // DELETE
    if (action === 'delete') {
      if (!id) return json({ error: 'id requis' }, 400);
      const { error } = await supabase.from('recompenses').delete().eq('id', String(id));
      if (error) throw new Error('delete recompense: ' + error.message);
      console.log('manage-recompenses: supprimée id='+id+' par patron');
      return json({ ok: true });
    }

    return json({ error: 'Action inconnue (attendu: create | update | toggle | delete)' }, 400);

  } catch (err) {
    console.error('manage-recompenses error:', err);
    return json({ error: (err as Error).message }, 500);
  }
});
