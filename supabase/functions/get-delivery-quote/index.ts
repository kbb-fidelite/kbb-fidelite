// Supabase Edge Function — get-delivery-quote
//
// Obtient un devis de livraison Uber Direct en temps réel.
// Appelée depuis le client quand l'adresse de livraison est complète.
//
// Body : { dropoff_address: string }
// Retourne : { fee_cents, currency, pickup_duration, dropoff_eta, quote_id }
//         ou { error, available: false } si hors zone / pas de livreur
//
// Secrets requis : UBER_CLIENT_ID, UBER_CLIENT_SECRET, UBER_CUSTOMER_ID
// Déploiement : supabase functions deploy get-delivery-quote

import { getUberToken, RESTAURANT } from '../_shared/uber-auth.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { dropoff_address } = await req.json();

    if (!dropoff_address || typeof dropoff_address !== 'string' || dropoff_address.trim().length < 10) {
      return json({ error: 'Adresse de livraison invalide' }, 400);
    }

    const customerId = Deno.env.get('UBER_CUSTOMER_ID');
    if (!customerId) throw new Error('UBER_CUSTOMER_ID non configuré');

    const token = await getUberToken();

    const res = await fetch(
      `https://api.uber.com/v1/customers/${customerId}/delivery_quotes`,
      {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          pickup_address:  RESTAURANT.address,
          dropoff_address: dropoff_address.trim(),
        }),
      }
    );

    const data = await res.json();
    console.log(`[get-delivery-quote] HTTP ${res.status} | dropoff: ${dropoff_address.slice(0, 40)} | fee: ${data.fee ?? '—'}`);

    // Hors zone ou pas de livreur disponible
    if (!res.ok) {
      const errCode = data?.errors?.[0]?.code ?? data?.code ?? '';
      if (res.status === 422 || errCode === 'no_couriers_available' || errCode === 'out_of_service_area') {
        return json({
          available: false,
          error: errCode === 'out_of_service_area'
            ? 'Adresse hors zone de livraison'
            : 'Aucun livreur disponible pour le moment — réessayez dans quelques minutes',
        });
      }
      throw new Error(`Uber Quotes API ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
    }

    return json({
      available:       true,
      fee_cents:       data.fee        ?? 399,
      currency:        data.currency   ?? 'EUR',
      pickup_duration: data.pickup_duration ?? null,
      dropoff_eta:     data.dropoff_eta     ?? null,
      quote_id:        data.id ?? null,
      expires:         data.expires    ?? null,
    });

  } catch (err) {
    console.error('get-delivery-quote error:', (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});
