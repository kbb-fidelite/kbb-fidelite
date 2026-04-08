// Supabase Edge Function — create-commande
// Crée une nouvelle commande en utilisant service_role (bypass RLS).
// Accepte une payload libre — la validation métier est faite côté client
// (Stripe déjà vérifié, ou validation employé).
//
// Secrets requis : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injectés)
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json();
    const { payload } = body;

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

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { data, error } = await supabase
      .from('commandes')
      .insert(safe)
      .select()
      .single();

    if (error) throw new Error('Supabase insert commande: ' + error.message);

    console.log('create-commande: commande', data.id, 'créée — montant', safe.montant, '— tel', safe.client_telephone || 'anonyme');

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
