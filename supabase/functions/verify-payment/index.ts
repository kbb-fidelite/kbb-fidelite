// Supabase Edge Function — verify-payment
// Vérifie auprès de Stripe que le paiement est bien au statut "paid",
// puis active la commande pré-créée (pending_payment → en_attente).
//
// Sans cette vérification côté serveur, aucune commande n'est activée.
// Le client ne peut pas forger stripe_success=1 pour obtenir une commande gratuite.
//
// Secrets requis : STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injectés)
// Déploiement : supabase functions deploy verify-payment

import Stripe from 'https://esm.sh/stripe@14?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    if (!stripeKey) throw new Error('STRIPE_SECRET_KEY non configurée');

    const supaUrl  = Deno.env.get('SUPABASE_URL')!;
    const supaKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const stripe   = new Stripe(stripeKey, { apiVersion: '2024-04-10' });
    const supabase = createClient(supaUrl, supaKey);

    const { session_id } = await req.json();

    if (!session_id || typeof session_id !== 'string') {
      return new Response(
        JSON.stringify({ error: 'session_id manquant ou invalide' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── 1. Vérifier le paiement auprès de Stripe ─────────────────
    let session: Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.retrieve(session_id);
    } catch (stripeErr) {
      return new Response(
        JSON.stringify({ error: 'Session Stripe introuvable: ' + (stripeErr as Error).message }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (session.payment_status !== 'paid') {
      console.warn(`verify-payment: session ${session_id} non payée (statut: ${session.payment_status})`);
      return new Response(
        JSON.stringify({ error: `Paiement non confirmé — statut Stripe: ${session.payment_status}` }),
        { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── 2. Trouver la commande pré-créée par stripe_session_id ────
    const { data: orders, error: findErr } = await supabase
      .from('commandes')
      .select('id, statut')
      .eq('stripe_session_id', session_id)
      .limit(1);

    if (findErr) throw new Error('Erreur recherche commande: ' + findErr.message);

    if (!orders || orders.length === 0) {
      return new Response(
        JSON.stringify({ error: 'Commande introuvable pour cette session Stripe' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const order = orders[0];

    // ── 3. Idempotence : déjà activée ─────────────────────────────
    if (order.statut !== 'pending_payment') {
      console.log(`verify-payment: commande ${order.id} déjà activée (statut: ${order.statut})`);
      return new Response(
        JSON.stringify({ ok: true, orderId: order.id, already_processed: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── 4. Activer la commande (atomic — guard optimiste sur statut) ─
    const { error: updateErr } = await supabase
      .from('commandes')
      .update({ statut: 'en_attente' })
      .eq('id', order.id)
      .eq('statut', 'pending_payment');  // évite double activation concurrente

    if (updateErr) throw new Error('Erreur activation commande: ' + updateErr.message);

    console.log(`verify-payment: commande ${order.id} activée — session ${session_id}`);

    return new Response(
      JSON.stringify({ ok: true, orderId: order.id }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('verify-payment error:', err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
