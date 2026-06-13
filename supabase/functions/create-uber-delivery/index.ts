// Supabase Edge Function — create-uber-delivery
//
// Crée une livraison Uber Direct après confirmation du paiement Stripe.
// Stocke uber_delivery_id, uber_tracking_url et uber_status dans la table commandes.
//
// Body : {
//   commande_id:     number,
//   dropoff_address: string,   // "12 rue ..., 75011 Paris, France"
//   dropoff_notes:   string,   // instructions livreur (optionnel)
//   client_tel:      string,
//   client_name:     string,
//   order_ref:       string,   // "#KBB-123"
//   total_cents:     number,
// }
//
// Secrets requis : UBER_CLIENT_ID, UBER_CLIENT_SECRET, UBER_CUSTOMER_ID,
//                  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Déploiement : supabase functions deploy create-uber-delivery

import { getUberToken, RESTAURANT } from '../_shared/uber-auth.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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
    const {
      commande_id,
      dropoff_address,
      dropoff_notes,
      client_tel,
      client_name,
      order_ref,
      total_cents,
    } = await req.json();

    if (!commande_id) return json({ error: 'commande_id requis' }, 400);
    if (!dropoff_address) return json({ error: 'dropoff_address requis' }, 400);

    const customerId = Deno.env.get('UBER_CUSTOMER_ID');
    if (!customerId) throw new Error('UBER_CUSTOMER_ID non configuré');

    const token = await getUberToken();

    // ── Préparation dans 10 minutes (laisser le temps de préparer) ──
    const pickupReadyDt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const body = {
      pickup: {
        name:         RESTAURANT.name,
        address:      RESTAURANT.address,
        phone_number: RESTAURANT.phone_number,
        email:        RESTAURANT.email,
      },
      dropoff: {
        name:         client_name || 'Client KBB',
        address:      dropoff_address,
        phone_number: client_tel  || '',
        notes:        dropoff_notes || '',
      },
      manifest: {
        reference:   order_ref || `KBB-${commande_id}`,
        description: 'Commande KBB à la braise',
        total_value: total_cents ?? 0,
      },
      pickup_ready_dt: pickupReadyDt,
    };

    const res = await fetch(
      `https://api.uber.com/v1/customers/${customerId}/deliveries`,
      {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify(body),
      }
    );

    const data = await res.json();
    console.log(`[create-uber-delivery] HTTP ${res.status} | commande_id: ${commande_id} | delivery_id: ${data.id ?? '—'}`);

    if (!res.ok) {
      throw new Error(`Uber Deliveries API ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
    }

    const deliveryId   = data.id          as string;
    const trackingUrl  = data.tracking_url as string | null;
    const dropoffEta   = data.dropoff?.eta_seconds ? Math.round(data.dropoff.eta_seconds / 60) : null;
    const dropoffEtaLabel = dropoffEta ? `${dropoffEta} min` : '25–40 min';

    // ── Stocker dans Supabase ──────────────────────────────────────
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { error: updateErr } = await supabase
      .from('commandes')
      .update({
        uber_delivery_id:  deliveryId,
        uber_tracking_url: trackingUrl ?? null,
        uber_status:       data.status ?? 'pending',
      })
      .eq('id', commande_id);

    if (updateErr) {
      console.error('[create-uber-delivery] DB update échoué:', updateErr.message);
    } else {
      console.log(`[create-uber-delivery] ✅ commande ${commande_id} ← delivery ${deliveryId}`);
    }

    return json({
      ok:             true,
      delivery_id:    deliveryId,
      tracking_url:   trackingUrl,
      status:         data.status,
      dropoff_eta:    dropoffEta,
      dropoff_eta_label: dropoffEtaLabel,
      fee_cents:      data.fee ?? null,
    });

  } catch (err) {
    console.error('create-uber-delivery error:', (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});
