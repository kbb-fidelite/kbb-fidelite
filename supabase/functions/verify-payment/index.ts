// Supabase Edge Function — verify-payment
// Vérifie auprès de Stripe que le paiement est bien au statut "paid",
// puis active la commande pré-créée (pending_payment → en_attente).

import Stripe from 'https://esm.sh/stripe@14?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    // ── STEP 1 : vérifier les secrets ────────────────────────────
    console.log('[verify-payment] STEP 1 — lecture des secrets');
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    const supaUrl   = Deno.env.get('SUPABASE_URL');
    const supaKey   = Deno.env.get('SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!stripeKey) { console.error('[verify-payment] MANQUANT: STRIPE_SECRET_KEY'); throw new Error('Secret STRIPE_SECRET_KEY non configuré'); }
    if (!supaUrl)   { console.error('[verify-payment] MANQUANT: SUPABASE_URL');       throw new Error('Secret SUPABASE_URL non configuré'); }
    if (!supaKey)   { console.error('[verify-payment] MANQUANT: SERVICE_ROLE_KEY');   throw new Error('Secret SERVICE_ROLE_KEY non configuré'); }

    console.log('[verify-payment] secrets OK — supaUrl:', supaUrl);

    // ── STEP 2 : lire le body ────────────────────────────────────
    console.log('[verify-payment] STEP 2 — lecture body');
    const body = await req.json().catch(() => ({}));
    const { session_id } = body;

    if (!session_id || typeof session_id !== 'string') {
      console.error('[verify-payment] session_id manquant — body reçu:', JSON.stringify(body));
      return new Response(
        JSON.stringify({ error: 'session_id manquant ou invalide' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    console.log('[verify-payment] session_id:', session_id);

    // ── STEP 3 : appel Stripe ────────────────────────────────────
    console.log('[verify-payment] STEP 3 — retrieve Stripe session');
    const stripe = new Stripe(stripeKey, { apiVersion: '2024-04-10' });
    let session: Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.retrieve(session_id);
      console.log('[verify-payment] Stripe session status:', session.payment_status);
    } catch (stripeErr) {
      console.error('[verify-payment] Stripe retrieve error:', stripeErr);
      return new Response(
        JSON.stringify({ error: 'Session Stripe introuvable: ' + (stripeErr as Error).message }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (session.payment_status !== 'paid') {
      console.warn('[verify-payment] paiement non confirmé — statut:', session.payment_status);
      return new Response(
        JSON.stringify({ error: `Paiement non confirmé — statut Stripe: ${session.payment_status}` }),
        { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── STEP 4 : chercher la commande dans Supabase ──────────────
    console.log('[verify-payment] STEP 4 — recherche commande stripe_session_id =', session_id);
    const supabase = createClient(supaUrl, supaKey);
    const { data: orders, error: findErr } = await supabase
      .from('commandes')
      .select('id, statut')
      .eq('stripe_session_id', session_id)
      .limit(1);

    if (findErr) {
      console.error('[verify-payment] Supabase select error:', findErr);
      throw new Error('Erreur recherche commande: ' + findErr.message);
    }
    console.log('[verify-payment] commandes trouvées:', orders?.length ?? 0);

    if (!orders || orders.length === 0) {
      // Aucune commande pré-créée — on la crée maintenant
      console.log('[verify-payment] aucune commande pré-créée — création en_attente');
      const { data: newOrder, error: insertErr } = await supabase
        .from('commandes')
        .insert({
          stripe_session_id: session_id,
          statut: 'en_attente',
          montant: (session.amount_total ?? 0) / 100,
          created_at: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (insertErr) {
        console.error('[verify-payment] insert error:', insertErr);
        throw new Error('Erreur création commande: ' + insertErr.message);
      }
      console.log('[verify-payment] commande créée id:', newOrder?.id);
      return new Response(
        JSON.stringify({ ok: true, orderId: newOrder?.id }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const order = orders[0];

    // ── STEP 5 : idempotence ──────────────────────────────────────
    if (order.statut !== 'pending_payment') {
      console.log('[verify-payment] commande', order.id, 'déjà activée — statut:', order.statut);
      return new Response(
        JSON.stringify({ ok: true, orderId: order.id, already_processed: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── STEP 6 : activer la commande ──────────────────────────────
    console.log('[verify-payment] STEP 6 — activation commande', order.id);
    const { error: updateErr } = await supabase
      .from('commandes')
      .update({ statut: 'en_attente' })
      .eq('id', order.id)
      .eq('statut', 'pending_payment');

    if (updateErr) {
      console.error('[verify-payment] update error:', updateErr);
      throw new Error('Erreur activation commande: ' + updateErr.message);
    }

    console.log('[verify-payment] commande', order.id, 'activée — session', session_id);
    return new Response(
      JSON.stringify({ ok: true, orderId: order.id }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('[verify-payment] ERREUR FATALE:', (err as Error).message, err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
