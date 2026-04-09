// Supabase Edge Function — verify-payment
// Vérifie auprès de Stripe que le paiement est bien "paid",
// active la commande pré-créée (pending_payment → en_attente),
// et renvoie l'objet commande COMPLET pour que le frontend n'ait
// pas besoin d'un second SELECT (RLS instable sur iOS).
//
// Idempotence : stripe_session_id est la clé unique.
// Si la commande est déjà activée, renvoie ses données sans rien modifier.

import Stripe from 'https://esm.sh/stripe@14?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Champs renvoyés au frontend pour remplir l'écran de confirmation
const SELECT_FIELDS = 'id, statut, montant, pts_a_crediter, client_telephone, items, type, heure_retrait';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    // ── STEP 1 : secrets ─────────────────────────────────────────
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    const supaUrl   = Deno.env.get('SUPABASE_URL');
    const supaKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY');

    if (!stripeKey) throw new Error('Secret STRIPE_SECRET_KEY non configuré');
    if (!supaUrl)   throw new Error('Secret SUPABASE_URL non configuré');
    if (!supaKey)   throw new Error('Secret SERVICE_ROLE_KEY non configuré');

    // ── STEP 2 : session_id ───────────────────────────────────────
    const body = await req.json().catch(() => ({}));
    const { session_id } = body;

    if (!session_id || typeof session_id !== 'string') {
      return new Response(
        JSON.stringify({ error: 'session_id manquant ou invalide' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    console.log('[verify-payment] session_id:', session_id);

    // ── STEP 3 : vérification Stripe (source de vérité) ──────────
    const stripe = new Stripe(stripeKey, { apiVersion: '2024-04-10' });
    let session: Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.retrieve(session_id);
    } catch (stripeErr) {
      console.error('[verify-payment] Stripe error:', stripeErr);
      return new Response(
        JSON.stringify({ error: 'Session Stripe introuvable: ' + (stripeErr as Error).message }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (session.payment_status !== 'paid') {
      return new Response(
        JSON.stringify({ error: `Paiement non confirmé — statut: ${session.payment_status}` }),
        { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(supaUrl, supaKey);

    // ── STEP 4 : chercher la commande existante ───────────────────
    const { data: orders, error: findErr } = await supabase
      .from('commandes')
      .select(SELECT_FIELDS)
      .eq('stripe_session_id', session_id)
      .limit(1);

    if (findErr) throw new Error('Erreur recherche commande: ' + findErr.message);

    // ── STEP 5 : idempotence — commande déjà activée ─────────────
    if (orders && orders.length > 0 && orders[0].statut !== 'pending_payment') {
      const order = orders[0];
      console.log('[verify-payment] commande', order.id, 'déjà activée — statut:', order.statut);
      return new Response(
        JSON.stringify({ ok: true, orderId: order.id, commande: order, already_processed: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── STEP 6 : activer la commande pré-créée ────────────────────
    if (orders && orders.length > 0) {
      const order = orders[0];
      console.log('[verify-payment] activation commande', order.id);

      const { data: updated, error: updateErr } = await supabase
        .from('commandes')
        .update({ statut: 'en_attente' })
        .eq('id', order.id)
        .eq('statut', 'pending_payment')
        .select(SELECT_FIELDS)
        .single();

      if (updateErr) throw new Error('Erreur activation commande: ' + updateErr.message);

      const result = updated ?? order; // fallback si update race-condition
      console.log('[verify-payment] commande', result.id, 'activée');
      return new Response(
        JSON.stringify({ ok: true, orderId: result.id, commande: result }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── STEP 7 : aucune commande pré-créée — fallback INSERT ──────
    // (create-checkout a échoué silencieusement)
    console.warn('[verify-payment] aucune commande pré-créée — fallback insert');
    const { data: newOrder, error: insertErr } = await supabase
      .from('commandes')
      .insert({
        stripe_session_id: session_id,
        statut:            'en_attente',
        montant:           (session.amount_total ?? 0) / 100,
        type:              'sur_place',
        created_at:        new Date().toISOString(),
      })
      .select(SELECT_FIELDS)
      .single();

    if (insertErr) throw new Error('Erreur création commande: ' + insertErr.message);

    console.log('[verify-payment] commande fallback créée id:', newOrder?.id);
    return new Response(
      JSON.stringify({ ok: true, orderId: newOrder?.id, commande: newOrder }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    console.error('[verify-payment] ERREUR FATALE:', msg, (err as Error).stack ?? '');
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
