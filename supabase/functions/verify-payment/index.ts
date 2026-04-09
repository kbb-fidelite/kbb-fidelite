import Stripe from 'npm:stripe@14.23.0';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Aucune vérification d'identité utilisateur — session_id uniquement
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SELECT_FIELDS = 'id, statut, montant, pts_a_crediter, client_telephone, items, type, heure_retrait';

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200, headers: corsHeaders });
  }

  try {
    console.log('[1] Handler démarré');

    // ── session_id — seule source d'identité, pas de user.id ─────
    let session_id = '';
    try {
      const body = await req.json();
      session_id = String(body?.session_id ?? '');
    } catch { /* body vide */ }
    console.log('[2] session_id:', session_id || 'ABSENT');

    if (!session_id) {
      return new Response(JSON.stringify({ error: 'session_id manquant' }), { status: 400, headers: corsHeaders });
    }

    // ── Secrets ───────────────────────────────────────────────────
    console.log('[3] lecture secrets...');
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
    const supaUrl   = Deno.env.get('SUPABASE_URL') ?? '';
    const supaKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY') ?? '';
    console.log('[3] STRIPE_SECRET_KEY:', stripeKey ? 'OK' : 'VIDE ⚠️');
    console.log('[3] SUPABASE_URL:', supaUrl ? 'OK' : 'VIDE ⚠️');
    console.log('[3] SERVICE_ROLE_KEY:', supaKey ? 'OK' : 'VIDE ⚠️');

    if (!stripeKey || !supaUrl || !supaKey) {
      return new Response(JSON.stringify({ error: 'Secrets manquants', stripe: !!stripeKey, url: !!supaUrl, key: !!supaKey }), { status: 400, headers: corsHeaders });
    }

    // ── Stripe retrieve ───────────────────────────────────────────
    console.log('[4] Stripe retrieve session...');
    const stripe = new Stripe(stripeKey, { apiVersion: '2024-04-10' });
    console.log('[4] Stripe instance créée');

    let session: Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.retrieve(session_id);
      console.log('[4] Stripe OK — payment_status:', session.payment_status, '| amount_total:', session.amount_total);
    } catch (e) {
      console.error('[4] Stripe ERREUR:', (e as Error).message);
      return new Response(JSON.stringify({ error: 'Stripe : ' + (e as Error).message }), { status: 404, headers: corsHeaders });
    }

    if (session.payment_status !== 'paid') {
      console.warn('[4] Non paid:', session.payment_status);
      return new Response(JSON.stringify({ error: 'Non payé : ' + session.payment_status }), { status: 402, headers: corsHeaders });
    }

    // ── Supabase ──────────────────────────────────────────────────
    console.log('[5] Supabase createClient...');
    const supabase = createClient(supaUrl, supaKey);
    console.log('[5] SELECT commande stripe_session_id =', session_id);

    const { data: rows, error: findErr } = await supabase
      .from('commandes')
      .select(SELECT_FIELDS)
      .eq('stripe_session_id', session_id)
      .limit(1);

    if (findErr) {
      console.error('[5] SELECT ERREUR:', findErr.message, findErr.code);
      throw new Error('SELECT : ' + findErr.message);
    }
    console.log('[5] lignes trouvées:', rows?.length ?? 0);

    const order = rows?.[0] ?? null;

    // Idempotence
    if (order && order.statut !== 'pending_payment') {
      console.log('[6] IDEMPOTENT statut=', order.statut);
      return new Response(
        JSON.stringify({ ok: true, orderId: Number(order.id), commande: order, already_processed: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // UPDATE pending_payment → en_attente
    if (order) {
      console.log('[6] UPDATE id=', order.id, '→ en_attente');
      const { data: updated, error: updateErr } = await supabase
        .from('commandes')
        .update({ statut: 'en_attente' })
        .eq('id', order.id)
        .eq('statut', 'pending_payment')
        .select(SELECT_FIELDS)
        .maybeSingle();

      if (updateErr) {
        console.error('[6] UPDATE ERREUR:', updateErr.message, updateErr.code);
        throw new Error('UPDATE : ' + updateErr.message);
      }
      const result = updated ?? order;
      console.log('[6] UPDATE OK id=', result.id);
      return new Response(
        JSON.stringify({ ok: true, orderId: Number(result.id), commande: result }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Fallback INSERT
    console.warn('[6] FALLBACK INSERT — aucune commande pré-créée');
    const montant = Number((session.amount_total ?? 0) / 100);
    const { data: newOrder, error: insertErr } = await supabase
      .from('commandes')
      .insert({ stripe_session_id: session_id, statut: 'en_attente', montant, type: 'sur_place', pts_a_crediter: 0, created_at: new Date().toISOString() })
      .select(SELECT_FIELDS)
      .maybeSingle();

    if (insertErr) {
      console.error('[6] INSERT ERREUR:', insertErr.message, insertErr.code);
      throw new Error('INSERT : ' + insertErr.message);
    }
    console.log('[6] INSERT OK id=', newOrder?.id);
    return new Response(
      JSON.stringify({ ok: true, orderId: Number(newOrder?.id ?? 0), commande: newOrder ?? {} }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    const msg   = (err as Error).message ?? String(err);
    const stack = (err as Error).stack   ?? '';
    console.error('[ERR]', msg);
    console.error('[STACK]', stack);
    return new Response(
      JSON.stringify({ error: msg, stack }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
