// Supabase Edge Function — uber-auth
//
// Endpoint de vérification OAuth2 Uber Direct.
// N'expose jamais le token — retourne uniquement ok + config.
//
// Secrets requis : UBER_CLIENT_ID, UBER_CLIENT_SECRET, UBER_CUSTOMER_ID
// Déploiement : supabase functions deploy uber-auth

import { getUberToken, getRestaurant } from '../_shared/uber-auth.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  // ── Logs AVANT tout appel réseau ou await ───────────────────────────────────
  const clientId     = Deno.env.get('UBER_CLIENT_ID');
  const clientSecret = Deno.env.get('UBER_CLIENT_SECRET');
  const customerId   = Deno.env.get('UBER_CUSTOMER_ID');

  console.log('=== uber-auth diagnostic ===');
  console.log(`UBER_CLIENT_ID    : ${clientId     ? '"' + clientId.slice(0,6)     + '..."' : 'MANQUANT'}`);
  console.log(`UBER_CLIENT_SECRET: ${clientSecret ? '"' + clientSecret.slice(0,6) + '..."' : 'MANQUANT'}`);
  console.log(`UBER_CUSTOMER_ID  : ${customerId   ? '"' + customerId.slice(0,6)   + '..."' : 'MANQUANT'}`);
  console.log(`scope cible       : eats.deliveries`);
  console.log('============================');

  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    await getUberToken();
    const restaurant = getRestaurant();
    return new Response(
      JSON.stringify({
        ok: true,
        config: {
          client_id_set:        !!clientId,
          client_secret_set:    !!clientSecret,
          customer_id_set:      !!customerId,
          restaurant_addr_set:  !!restaurant.address,
          restaurant_phone_set: !!restaurant.phone_number,
        },
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('uber-auth error:', (err as Error).message);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
