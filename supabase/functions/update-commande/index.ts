// Supabase Edge Function — update-commande
// Met à jour le statut ou les métadonnées d'une commande.
// Requiert un token employé valide (n'importe quel rôle).
// Utilise SUPABASE_SERVICE_ROLE_KEY pour bypasser les RLS.
//
// Secrets requis : EMP_TOKEN_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injectés)
// Déploiement : supabase functions deploy update-commande

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

// Seuls ces champs peuvent être mis à jour via cette fonction
const ALLOWED_FIELDS = ['statut', 'points_credites'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { id, data, emp_token } = await req.json();

    // ── 1. Vérifier le token employé ─────────────────────────────
    if (!emp_token || typeof emp_token !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Token employé requis' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const secret  = Deno.env.get('EMP_TOKEN_SECRET') ?? 'kbb-default-secret-change-me';
    const payload = await verifyEmpToken(emp_token, secret);
    if (!payload) {
      return new Response(
        JSON.stringify({ error: 'Token invalide ou expiré — reconnectez-vous' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── 2. Valider les paramètres ─────────────────────────────────
    if (!id || !data || typeof data !== 'object') {
      return new Response(
        JSON.stringify({ error: 'id et data requis' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── 3. Filtrer les champs autorisés ───────────────────────────
    const safe: Record<string, unknown> = {};
    for (const field of ALLOWED_FIELDS) {
      if (field in data) safe[field] = data[field];
    }
    if (Object.keys(safe).length === 0) {
      return new Response(
        JSON.stringify({ error: 'Aucun champ valide (autorisés : ' + ALLOWED_FIELDS.join(', ') + ')' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── 4. Mettre à jour via service_role (bypass RLS) ───────────
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SERVICE_ROLE_KEY')!
    );

    const { data: updated, error } = await supabase
      .from('commandes')
      .update(safe)
      .eq('id', String(id))
      .select()
      .single();

    if (error) throw new Error('Supabase commandes update: ' + error.message);

    console.log('update-commande: commande', id, 'mise à jour par', payload.role, '—', JSON.stringify(safe));
    return new Response(
      JSON.stringify({ ok: true, commande: updated }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('update-commande error:', err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
