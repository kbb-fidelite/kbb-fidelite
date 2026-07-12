// Supabase Edge Function — update-client
// Met à jour un enregistrement client avec vérification d'identité.
//
// Mode A — employé (emp_token valide) : tous les champs de la whitelist autorisés.
// Mode B — client (session_token) : uniquement son propre enregistrement,
//           champs restreints (pas de cagnotte, points, parrainage).
//
// Secrets requis : EMP_TOKEN_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injectés)
// Déploiement : supabase functions deploy update-client

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

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

// Champs autorisés en mode employé (accès total)
const EMP_FIELDS = [
  'passages', 'cagnotte', 'points_cumul', 'telephone', 'nom', 'prenom', 'code_secret',
  'pin_rapide', 'parrain_status', 'parrain_tel', 'parrain_mois',
  'parrain_mois_count', 'parrain_de', 'session_token',
  'derniere_visite', 'dernier_bonus_anniv', 'date_naissance', 'bloque',
];

// Champs autorisés en mode client (propre compte uniquement)
// SÉCURITÉ : cagnotte, points_cumul, passages, code_secret, session_token, parrain_*
// sont INTERDITS — seul le serveur (verify-payment, validate-reward, credit-referral-bonus)
// peut modifier les soldes et l'identité.
const CLIENT_FIELDS = [
  'nom', 'prenom', 'date_naissance', 'push_subscription',
  'pin_rapide', 'derniere_visite', 'dernier_bonus_anniv',
];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { id, data, emp_token, client_tel, session_token } = await req.json();

    if (!id || !data || typeof data !== 'object') {
      return jsonResp({ error: 'id et data requis' }, 400);
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
        return jsonResp({ error: 'Token invalide ou expiré — reconnectez-vous' }, 401);
      }
      allowedFields = EMP_FIELDS;
      console.log('update-client: mode employé —', payload.role);

    // ── Mode B : client avec session_token ─────────────────────────
    } else if (client_tel && typeof client_tel === 'string' && session_token && typeof session_token === 'string') {
      // Vérifier que l'enregistrement appartient bien à ce numéro ET que le session_token match
      const { data: record, error: findError } = await supabase
        .from('clients')
        .select('telephone, session_token')
        .eq('id', String(id))
        .single();

      if (findError || !record) {
        return jsonResp({ error: 'Client introuvable' }, 404);
      }

      if (record.telephone !== client_tel) {
        return jsonResp({ error: 'Accès refusé — ce n\'est pas votre compte' }, 403);
      }

      if (!record.session_token || record.session_token !== session_token) {
        console.warn('update-client: session_token invalide pour tel=…' + client_tel.slice(-4));
        return jsonResp({ error: 'Session invalide — reconnectez-vous' }, 401);
      }

      allowedFields = CLIENT_FIELDS;
      console.log('update-client: mode client — tel …' + client_tel.slice(-4));

    } else {
      return jsonResp({ error: 'Authentification requise (emp_token ou session_token)' }, 401);
    }

    // ── Filtrer les champs autorisés ──────────────────────────────
    const safe: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (field in data) safe[field] = data[field];
    }
    if (Object.keys(safe).length === 0) {
      return jsonResp({ error: 'Aucun champ valide à mettre à jour' }, 400);
    }

    // ── Mettre à jour via service_role (bypass RLS) ───────────────
    const { data: updated, error } = await supabase
      .from('clients')
      .update(safe)
      .eq('id', String(id))
      .select()
      .single();

    if (error) throw new Error('Supabase clients update: ' + error.message);

    return jsonResp({ ok: true, client: updated });

  } catch (err) {
    console.error('update-client error:', err);
    return jsonResp({ error: (err as Error).message }, 500);
  }
});
