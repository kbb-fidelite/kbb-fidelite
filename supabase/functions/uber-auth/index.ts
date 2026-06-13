// Supabase Edge Function — uber-auth
//
// Endpoint de vérification OAuth2 Uber Direct.
// N'expose jamais le token — retourne uniquement ok + expiry.
// Les autres Edge Functions importent getUberToken() depuis _shared/uber-auth.ts.
//
// Secrets requis : UBER_CLIENT_ID, UBER_CLIENT_SECRET
// Déploiement : supabase functions deploy uber-auth

import { getUberToken, getRestaurant } from '../_shared/uber-auth.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    await getUberToken(); // vérifie que l'auth fonctionne, jette en cas d'erreur
    const restaurant = getRestaurant();
    const customerId = Deno.env.get('UBER_CUSTOMER_ID');
    console.log(`[uber-auth] diagnostic — UBER_CUSTOMER_ID: ${customerId ? 'OK' : 'MANQUANT'} | RESTAURANT_ADDRESS: ${restaurant.address ? 'OK' : 'MANQUANT'}`);
    return new Response(
      JSON.stringify({
        ok: true,
        config: {
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
