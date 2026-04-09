import Stripe from 'https://esm.sh/stripe@14?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SELECT_FIELDS = 'id, statut, montant, pts_a_crediter, client_telephone, items, type, heure_retrait';

function toNum(v: unknown, fallback = 0): number {
  const n = Number(v);
  return isNaN(n) ? fallback : n;
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function sanitize(order: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!order) return null;
  return { ...order, id: Number(order.id), montant: toNum(order.montant), pts_a_crediter: toNum(order.pts_a_crediter) };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {

    // ── DEBUG SECRETS — log immédiat avant tout traitement ────────
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    const supaUrl   = Deno.env.get('SUPABASE_URL');
    const supaKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY');

    console.log('[VP] STRIPE_SECRET_KEY:', stripeKey ? 'PRÉSENTE (longueur=' + stripeKey.length + ')' : 'UNDEFINED ⚠️');
    console.log('[VP] SUPABASE_URL:', supaUrl ?? 'UNDEFINED ⚠️');
    console.log('[VP] SERVICE_ROLE_KEY:', supaKey ? 'PRÉSENTE (longueur=' + supaKey.length + ')' : 'UNDEFINED ⚠️');

    if (!stripeKey) return jsonRes({ error: 'STRIPE_SECRET_KEY manquant' }, 400);
    if (!supaUrl)   return jsonRes({ error: 'SUPABASE_URL manquant' }, 400);
    if (!supaKey)   return jsonRes({ error: 'SERVICE_ROLE_KEY manquant' }, 400);

    // ── Lecture body ──────────────────────────────────────────────
    console.log('[VP] lecture body...');
    const body = await req.json().catch(() => ({}));
    const { session_id } = body as { session_id?: string };
    console.log('[VP] session_id reçu:', session_id ?? 'ABSENT');

    if (!session_id || typeof session_id !== 'string') {
      return jsonRes({ error: 'session_id manquant ou invalide' }, 400);
    }

    // ── Appel Stripe ──────────────────────────────────────────────
    console.log('[VP] appel Stripe retrieve...');
    const stripe = new Stripe(stripeKey, { apiVersion: '2024-04-10' });
    let session: Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.retrieve(session_id);
      console.log('[VP] Stripe OK — payment_status:', session.payment_status, '| amount_total:', session.amount_total);
    } catch (stripeErr) {
      console.error('[VP] Stripe retrieve ERREUR:', stripeErr);
      return jsonRes({ error: 'Session Stripe introuvable : ' + (stripeErr as Error).message }, 404);
    }

    if (session.payment_status !== 'paid') {
      console.warn('[VP] paiement non paid — statut:', session.payment_status);
      return jsonRes({ error: 'Paiement non confirmé — statut : ' + session.payment_status }, 402);
    }

    // ── Supabase — recherche commande ────────────────────────────
    console.log('[VP] createClient Supabase...');
    const supabase = createClient(supaUrl, supaKey);

    console.log('[VP] SELECT commandes WHERE stripe_session_id =', session_id);
    const { data: orders, error: findErr } = await supabase
      .from('commandes')
      .select(SELECT_FIELDS)
      .eq('stripe_session_id', session_id)
      .limit(1);

    if (findErr) {
      console.error('[VP] SELECT ERREUR:', findErr);
      throw new Error('Erreur recherche commande : ' + findErr.message);
    }
    console.log('[VP] SELECT OK — lignes:', orders?.length ?? 0, orders?.[0] ? JSON.stringify({ id: orders[0].id, statut: orders[0].statut }) : '');

    // ── Idempotence ───────────────────────────────────────────────
    if (orders && orders.length > 0 && orders[0].statut !== 'pending_payment') {
      console.log('[VP] IDEMPOTENT — commande déjà activée:', orders[0].id, orders[0].statut);
      return jsonRes({ ok: true, orderId: Number(orders[0].id), commande: sanitize(orders[0]), already_processed: true });
    }

    // ── UPDATE pending_payment → en_attente ───────────────────────
    if (orders && orders.length > 0) {
      const order = orders[0];
      console.log('[VP] UPDATE commande id=', order.id, 'pending_payment → en_attente');

      const { data: updated, error: updateErr } = await supabase
        .from('commandes')
        .update({ statut: 'en_attente' })
        .eq('id', order.id)
        .eq('statut', 'pending_payment')
        .select(SELECT_FIELDS)
        .maybeSingle();

      if (updateErr) {
        console.error('[VP] UPDATE ERREUR:', updateErr);
        throw new Error('Erreur activation commande : ' + updateErr.message);
      }
      console.log('[VP] UPDATE OK — résultat:', updated ? 'commande mise à jour' : 'déjà activée (race-condition)');

      const result = updated ?? order;
      return jsonRes({ ok: true, orderId: Number(result.id), commande: sanitize(result) });
    }

    // ── Fallback INSERT (create-checkout n'a pas pré-créé) ────────
    console.warn('[VP] FALLBACK INSERT — aucune commande pré-créée pour cette session');
    const montantNum = toNum((session.amount_total ?? 0) / 100);
    console.log('[VP] INSERT commande — montant:', montantNum);

    const { data: newOrder, error: insertErr } = await supabase
      .from('commandes')
      .insert({
        stripe_session_id: session_id,
        statut:            'en_attente',
        montant:           montantNum,
        type:              'sur_place',
        pts_a_crediter:    0,
        created_at:        new Date().toISOString(),
      })
      .select(SELECT_FIELDS)
      .maybeSingle();

    if (insertErr) {
      console.error('[VP] INSERT ERREUR:', insertErr);
      throw new Error('Erreur création commande : ' + insertErr.message);
    }
    console.log('[VP] INSERT OK — id:', newOrder?.id);
    return jsonRes({ ok: true, orderId: Number(newOrder?.id), commande: sanitize(newOrder) });

  } catch (error) {
    // ── CATCH GLOBAL — affiche tout ──────────────────────────────
    console.error('ERREUR_DETECTEE:', error);
    console.error('ERREUR_DETECTEE message:', (error as Error).message);
    console.error('ERREUR_DETECTEE stack:', (error as Error).stack);
    return new Response(
      JSON.stringify({ error: (error as Error).message, stack: (error as Error).stack }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
