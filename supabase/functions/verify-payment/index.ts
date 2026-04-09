import Stripe from 'https://esm.sh/stripe@14.23.0';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

console.log('!!! FICHIER CHARGE !!!');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SELECT_FIELDS = 'id, statut, montant, pts_a_crediter, client_telephone, items, type, heure_retrait';

function toNum(v: unknown, fallback = 0): number {
  const n = Number(v);
  return isNaN(n) ? fallback : n;
}

function sanitize(o: Record<string, unknown> | null) {
  if (!o) return null;
  return { ...o, id: Number(o.id), montant: toNum(o.montant), pts_a_crediter: toNum(o.pts_a_crediter) };
}

Deno.serve(async (req) => {
  try {

    console.log('Etape 1: Requête reçue — méthode:', req.method);
    console.log('Auth Header:', req.headers.get('Authorization') ? 'Présent' : 'Absent');
    console.log('Content-Type:', req.headers.get('content-type') ?? 'absent');

    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

    console.log('Etape 2: Lecture de la clé Stripe');
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    const supaUrl   = Deno.env.get('SUPABASE_URL');
    const supaKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY');
    console.log('  STRIPE_SECRET_KEY:', stripeKey ? 'OK len=' + stripeKey.length : 'MANQUANTE ⚠️');
    console.log('  SUPABASE_URL:', supaUrl ? 'OK' : 'MANQUANTE ⚠️');
    console.log('  SERVICE_ROLE_KEY:', supaKey ? 'OK len=' + supaKey.length : 'MANQUANTE ⚠️');

    if (!stripeKey) return new Response(JSON.stringify({ error: 'STRIPE_SECRET_KEY manquante' }), { status: 400, headers: corsHeaders });
    if (!supaUrl)   return new Response(JSON.stringify({ error: 'SUPABASE_URL manquante' }), { status: 400, headers: corsHeaders });
    if (!supaKey)   return new Response(JSON.stringify({ error: 'SERVICE_ROLE_KEY manquante' }), { status: 400, headers: corsHeaders });

    console.log('Etape 3: Lecture body');
    const body = await req.json().catch(() => ({}));
    const { session_id } = body as { session_id?: string };
    console.log('  session_id:', session_id ?? 'ABSENT');

    if (!session_id || typeof session_id !== 'string') {
      return new Response(JSON.stringify({ error: 'session_id manquant' }), { status: 400, headers: corsHeaders });
    }

    console.log('Etape 4: Tentative Stripe session retrieve — id:', session_id);
    const stripe = new Stripe(stripeKey, { apiVersion: '2024-04-10' });
    let session: Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.retrieve(session_id);
      console.log('  Stripe OK — payment_status:', session.payment_status, '| amount:', session.amount_total);
    } catch (stripeErr) {
      console.error('  Stripe ERREUR:', (stripeErr as Error).message);
      return new Response(JSON.stringify({ error: 'Stripe : ' + (stripeErr as Error).message }), { status: 404, headers: corsHeaders });
    }

    if (session.payment_status !== 'paid') {
      console.warn('  paiement non paid:', session.payment_status);
      return new Response(JSON.stringify({ error: 'Paiement non confirmé : ' + session.payment_status }), { status: 402, headers: corsHeaders });
    }

    console.log('Etape 5: SELECT commande Supabase');
    const supabase = createClient(supaUrl, supaKey);
    const { data: orders, error: findErr } = await supabase
      .from('commandes')
      .select(SELECT_FIELDS)
      .eq('stripe_session_id', session_id)
      .limit(1);

    if (findErr) {
      console.error('  SELECT ERREUR:', findErr.message, findErr.code);
      throw new Error('SELECT : ' + findErr.message);
    }
    console.log('  lignes:', orders?.length ?? 0, orders?.[0] ? 'id=' + orders[0].id + ' statut=' + orders[0].statut : '');

    if (orders && orders.length > 0 && orders[0].statut !== 'pending_payment') {
      console.log('  IDEMPOTENT — déjà activée');
      return new Response(JSON.stringify({ ok: true, orderId: Number(orders[0].id), commande: sanitize(orders[0]), already_processed: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (orders && orders.length > 0) {
      const order = orders[0];
      console.log('Etape 6: UPDATE id=', order.id, '→ en_attente');
      const { data: updated, error: updateErr } = await supabase
        .from('commandes')
        .update({ statut: 'en_attente' })
        .eq('id', order.id)
        .eq('statut', 'pending_payment')
        .select(SELECT_FIELDS)
        .maybeSingle();
      if (updateErr) {
        console.error('  UPDATE ERREUR:', updateErr.message, updateErr.code);
        throw new Error('UPDATE : ' + updateErr.message);
      }
      console.log('  UPDATE OK:', updated ? 'activé' : 'race-condition OK');
      const result = updated ?? order;
      return new Response(JSON.stringify({ ok: true, orderId: Number(result.id), commande: sanitize(result) }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    console.warn('Etape 6: FALLBACK INSERT — aucune commande pré-créée');
    const montant = toNum((session.amount_total ?? 0) / 100);
    const { data: newOrder, error: insertErr } = await supabase
      .from('commandes')
      .insert({ stripe_session_id: session_id, statut: 'en_attente', montant, type: 'sur_place', pts_a_crediter: 0, created_at: new Date().toISOString() })
      .select(SELECT_FIELDS)
      .maybeSingle();
    if (insertErr) {
      console.error('  INSERT ERREUR:', insertErr.message, insertErr.code);
      throw new Error('INSERT : ' + insertErr.message);
    }
    console.log('  INSERT OK id:', newOrder?.id);
    return new Response(JSON.stringify({ ok: true, orderId: Number(newOrder?.id), commande: sanitize(newOrder) }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('ERREUR_DETECTEE:', error);
    console.error('ERREUR_DETECTEE message:', (error as Error).message);
    console.error('ERREUR_DETECTEE stack:', (error as Error).stack);
    return new Response(
      JSON.stringify({ error: (error as Error).message, stack: (error as Error).stack }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
