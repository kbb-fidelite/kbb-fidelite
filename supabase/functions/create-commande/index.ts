// Supabase Edge Function — create-commande
// Crée une nouvelle commande en utilisant service_role (bypass RLS).
// Pour type='sur_place' : exige un presence_token valide (signé par verify-presence-code).
//
// Secrets requis : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, EMP_TOKEN_SECRET (auto-injectés)
// Déploiement : supabase functions deploy create-commande

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Champs autorisés en entrée (whitelist)
const ALLOWED_FIELDS = [
  'type', 'items', 'montant', 'statut', 'created_at',
  'client_telephone', 'heure_retrait', 'table_num',
  'reward_nom', 'reward_pts', 'reward_id',
  'stripe_session_id', 'points_credites', 'order_num',
];

// ── Vérifie le presence_token (émis par verify-presence-code) ─────────────────
async function verifyPresenceToken(
  token: string,
  secret: string,
  clientTel: string
): Promise<boolean> {
  try {
    const dot = token.lastIndexOf('.');
    if (dot === -1) return false;
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
    if (!valid) return false;
    const payload = JSON.parse(atob(data));
    if (payload.t !== 'presence') return false;
    if (!payload.exp || payload.exp < Date.now()) return false;
    // Le token doit correspondre au même numéro de téléphone
    if (payload.tel !== clientTel) return false;
    return true;
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json();
    const { payload, presence_token } = body;

    if (!payload || typeof payload !== 'object') {
      return new Response(
        JSON.stringify({ error: 'payload requis' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Filtrer les champs autorisés
    const safe: Record<string, unknown> = {};
    for (const field of ALLOWED_FIELDS) {
      if (field in payload) safe[field] = payload[field];
    }

    if (!safe.montant || !safe.statut) {
      return new Response(
        JSON.stringify({ error: 'montant et statut requis' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── Vérification presence_token pour les commandes sur place ────────────
    if (safe.type === 'sur_place') {
      if (!presence_token || typeof presence_token !== 'string') {
        console.warn('create-commande: presence_token manquant pour sur_place');
        return new Response(
          JSON.stringify({ error: 'Code de présence requis pour commander sur place', code: 'TOKEN_REQUIS' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      const secret    = Deno.env.get('EMP_TOKEN_SECRET') ?? 'kbb-default-secret-change-me';
      const clientTel = String(safe.client_telephone || '');
      const valid     = await verifyPresenceToken(presence_token, secret, clientTel);
      if (!valid) {
        console.warn(`create-commande: presence_token invalide/expiré pour tel=${clientTel}`);
        return new Response(
          JSON.stringify({ error: 'Code de présence invalide ou expiré — recommencez', code: 'TOKEN_INVALIDE' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY'))!
    );

    const { data, error } = await supabase
      .from('commandes')
      .insert(safe)
      .select()
      .single();

    if (error) throw new Error('Supabase insert commande: ' + error.message);

    console.log('create-commande: commande', data.id, 'créée — type', safe.type, '— montant', safe.montant, '— tel', safe.client_telephone || 'anonyme');

    return new Response(
      JSON.stringify({ ok: true, commande: data }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('create-commande error:', err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
