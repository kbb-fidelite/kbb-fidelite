// Supabase Edge Function — get-delivery-quote
//
// Obtient un devis de livraison Uber Direct en temps réel.
// Appelée depuis le client quand l'adresse de livraison est complète.
//
// Body : { dropoff_address: string }
// Retourne : { fee_cents, currency, pickup_duration, dropoff_eta, quote_id }
//         ou { available: false, error } si hors zone / pas de livreur / erreur config
//
// Secrets requis : UBER_CLIENT_ID, UBER_CLIENT_SECRET, UBER_CUSTOMER_ID, RESTAURANT_ADDRESS
// Déploiement : supabase functions deploy get-delivery-quote

import { getUberToken, getRestaurant } from '../_shared/uber-auth.ts';

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
    // ── Étape 1 : validation de la requête ─────────────────────────────────────
    const { dropoff_address } = await req.json();
    console.log(`[get-delivery-quote] step 1 — dropoff_address reçu: "${(dropoff_address ?? '').slice(0, 80)}"`);

    if (!dropoff_address || typeof dropoff_address !== 'string' || dropoff_address.trim().length < 10) {
      return json({ available: false, error: 'Adresse de livraison invalide' }, 400);
    }

    // ── Étape 2 : vérifier UBER_CUSTOMER_ID et RESTAURANT_ADDRESS ──────────────
    const customerId = Deno.env.get('UBER_CUSTOMER_ID');
    const restaurant = getRestaurant();
    console.log(`[get-delivery-quote] step 2 — UBER_CUSTOMER_ID: ${customerId ? 'OK ('+customerId.slice(0,4)+'...)' : 'MANQUANT'}`);
    console.log(`[get-delivery-quote] step 2 — RESTAURANT_ADDRESS: ${restaurant.address ? '"'+restaurant.address.slice(0,50)+'"' : 'MANQUANT (secret RESTAURANT_ADDRESS non configuré)'}`);

    if (!customerId) {
      console.error('[get-delivery-quote] ✗ UBER_CUSTOMER_ID non configuré — ajoutez-le via supabase secrets set');
      return json({ available: false, error: 'Configuration manquante (UBER_CUSTOMER_ID)' }, 500);
    }
    if (!restaurant.address) {
      console.error('[get-delivery-quote] ✗ RESTAURANT_ADDRESS non configuré — ajoutez l\'adresse réelle du restaurant');
      return json({ available: false, error: 'Configuration manquante (RESTAURANT_ADDRESS)' }, 500);
    }

    // ── Étape 3 : authentification OAuth2 Uber ─────────────────────────────────
    console.log('[get-delivery-quote] step 3 — OAuth2...');
    let token: string;
    try {
      token = await getUberToken();
    } catch (authErr) {
      console.error('[get-delivery-quote] ✗ OAuth2 échoué:', (authErr as Error).message);
      // Retourner available:false plutôt qu'un 500 pour que le client affiche "Indisponible"
      return json({ available: false, error: 'Service de livraison temporairement indisponible' }, 503);
    }

    // ── Étape 4 : appel API Uber Direct delivery_quotes ────────────────────────
    const quoteUrl = `https://api.uber.com/v1/customers/${customerId}/delivery_quotes`;
    console.log(`[get-delivery-quote] step 4 — POST ${quoteUrl}`);
    console.log(`[get-delivery-quote] pickup: "${restaurant.address}" | dropoff: "${dropoff_address.trim().slice(0, 60)}"`);

    let res: Response;
    try {
      res = await fetch(quoteUrl, {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          pickup_address:  restaurant.address,
          dropoff_address: dropoff_address.trim(),
        }),
      });
    } catch (netErr) {
      console.error('[get-delivery-quote] ✗ Erreur réseau vers api.uber.com:', (netErr as Error).message);
      return json({ available: false, error: 'Service de livraison temporairement indisponible' }, 503);
    }

    const rawBody = await res.text();
    console.log(`[get-delivery-quote] step 4 — HTTP ${res.status} | body: ${rawBody.slice(0, 500)}`);

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(rawBody);
    } catch {
      console.error(`[get-delivery-quote] ✗ réponse non-JSON (HTTP ${res.status}):`, rawBody.slice(0, 200));
      return json({ available: false, error: 'Réponse inattendue du service Uber' }, 502);
    }

    // ── Étape 5 : analyser la réponse ─────────────────────────────────────────
    console.log('[get-delivery-quote] step 5 — champs reçus:', Object.keys(data).join(', '));

    if (!res.ok) {
      const errCode = (data?.errors as Array<Record<string,string>>)?.[0]?.code ?? String(data?.code ?? '');
      console.log(`[get-delivery-quote] erreur Uber: code="${errCode}" | status=${res.status}`);

      if (
        res.status === 422 ||
        errCode === 'no_couriers_available' ||
        errCode === 'out_of_service_area' ||
        errCode === 'invalid_params'
      ) {
        return json({
          available: false,
          error: errCode === 'out_of_service_area'
            ? 'Adresse hors zone de livraison'
            : errCode === 'no_couriers_available'
              ? 'Aucun livreur disponible pour le moment — réessayez dans quelques minutes'
              : 'Livraison indisponible pour cette adresse',
        });
      }
      // Erreur Uber non gérée — logguer et retourner available:false (pas de 500)
      console.error(`[get-delivery-quote] ✗ Uber API ${res.status}:`, rawBody.slice(0, 300));
      return json({ available: false, error: 'Service de livraison temporairement indisponible' }, 503);
    }

    // ── Étape 6 : extraire le prix ─────────────────────────────────────────────
    // Uber Direct API v1 retourne le prix en centimes dans data.fee
    // Certaines versions retournent data.quote.fee ou data.amount
    const rawFee = data.fee ?? (data.quote as Record<string,unknown>)?.fee ?? data.amount ?? null;

    console.log(`[get-delivery-quote] step 6 — rawFee: ${rawFee} | type: ${typeof rawFee}`);
    console.log(`[get-delivery-quote] champs prix disponibles: fee=${data.fee ?? '—'} | quote.fee=${(data.quote as Record<string,unknown>)?.fee ?? '—'} | amount=${data.amount ?? '—'}`);

    if (rawFee === null || rawFee === undefined) {
      console.error(`[get-delivery-quote] ✗ aucun champ fee trouvé. Tous les champs: ${JSON.stringify(data).slice(0, 500)}`);
      return json({ available: false, error: 'Prix de livraison indisponible — réessayez' });
    }

    const feeCents = Math.round(Number(rawFee));
    const feeSource = data.fee !== undefined ? 'fee' : (data.quote as Record<string,unknown>)?.fee !== undefined ? 'quote.fee' : 'amount';
    console.log(`[get-delivery-quote] ✅ fee_cents=${feeCents} (champ: ${feeSource}) | dropoff_eta=${data.dropoff_eta ?? '—'} min | quote_id=${data.id ?? '—'}`);

    return json({
      available:       true,
      fee_cents:       feeCents,
      currency:        String(data.currency   ?? 'EUR'),
      pickup_duration: data.pickup_duration   ?? null,
      dropoff_eta:     data.dropoff_eta       ?? null,
      quote_id:        data.id               ?? null,
      expires:         data.expires           ?? null,
    });

  } catch (err) {
    console.error('[get-delivery-quote] ✗ erreur non gérée:', (err as Error).message, (err as Error).stack?.slice(0, 300));
    return json({ available: false, error: 'Erreur interne — réessayez' }, 500);
  }
});
