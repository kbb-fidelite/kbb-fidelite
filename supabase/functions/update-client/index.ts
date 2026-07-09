// Supabase Edge Function — update-client
// Met à jour un enregistrement client avec vérification d'identité.
//
// Mode A — employé (emp_token valide) : tous les champs de la whitelist autorisés.
// Mode B — client (client_tel) : uniquement son propre enregistrement,
//           champs restreints (pas de nom/telephone/code_secret par client_tel seul).
//
// Secrets requis : EMP_TOKEN_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injectés)
// Déploiement : supabase functions deploy update-client

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

// Champs autorisés en mode employé
const EMP_FIELDS = [
  'passages', 'cagnotte', 'points_cumul', 'telephone', 'nom', 'prenom', 'code_secret',
  'pin_rapide', 'parrain_status', 'parrain_tel', 'parrain_mois',
  'parrain_mois_count', 'parrain_de', 'session_token',
  'derniere_visite', 'dernier_bonus_anniv', 'date_naissance', 'bloque',
];

// Champs autorisés en mode client (propre compte uniquement)
// SÉCURITÉ : 'cagnotte' et 'points_cumul' intentionnellement absents —
// toute écriture de solde passe par une Edge Function dédiée (emp_token ou credit-referral-bonus).
// SÉCURITÉ : champs restreints en mode client — pas de cagnotte, points, ni champs parrainage
// Le parrainage est géré côté serveur (inscription → create-client, crédit → credit-referral-bonus)
const CLIENT_FIELDS = [
  'pin_rapide', 'date_naissance', 'derniere_visite', 'dernier_bonus_anniv',
  'session_token',
];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { id, data, emp_token, client_tel } = await req.json();

    if (!id || !data || typeof data !== 'object') {
      return new Response(
        JSON.stringify({ error: 'id et data requis' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY'))!
    );

    let allowedFields: string[];

    // ── Mode A : token employé ────────────────────────────────────
    if (emp_token && typeof emp_token === 'string') {
      const secret  = Deno.env.get('EMP_TOKEN_SECRET') ?? 'kbb-default-secret-change-me';
      const payload = await verifyEmpToken(emp_token, secret);
      if (!payload) {
        return new Response(
          JSON.stringify({ error: 'Token invalide ou expiré — reconnectez-vous' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      allowedFields = EMP_FIELDS;
      console.log('update-client: mode employé —', payload.role);

    // ── Mode B : téléphone client (propre compte seulement) ───────
    } else if (client_tel && typeof client_tel === 'string') {
      // Vérifier que l'enregistrement appartient bien à ce numéro
      const { data: record, error: findError } = await supabase
        .from('clients')
        .select('telephone')
        .eq('id', String(id))
        .single();

      if (findError || !record) {
        return new Response(
          JSON.stringify({ error: 'Client introuvable' }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      if (record.telephone !== client_tel) {
        return new Response(
          JSON.stringify({ error: 'Accès refusé — ce n\'est pas votre compte' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      allowedFields = CLIENT_FIELDS;
      console.log('update-client: mode client — tel', client_tel.slice(-4));

    } else {
      return new Response(
        JSON.stringify({ error: 'emp_token ou client_tel requis' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── Filtrer les champs autorisés ──────────────────────────────
    const safe: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (field in data) safe[field] = data[field];
    }
    if (Object.keys(safe).length === 0) {
      return new Response(
        JSON.stringify({ error: 'Aucun champ valide à mettre à jour' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── Mettre à jour via service_role (bypass RLS) ───────────────
    const { data: updated, error } = await supabase
      .from('clients')
      .update(safe)
      .eq('id', String(id))
      .select()
      .single();

    if (error) throw new Error('Supabase clients update: ' + error.message);

    return new Response(
      JSON.stringify({ ok: true, client: updated }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('update-client error:', err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
