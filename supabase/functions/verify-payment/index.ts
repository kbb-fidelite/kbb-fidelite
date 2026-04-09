import Stripe from 'npm:stripe@14.23.0';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SELECT_FIELDS = 'id, statut, montant, pts_a_crediter, client_telephone, items, type, heure_retrait';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: corsHeaders });

  try {
    console.log('[1] Handler démarré');

    // ── session_id ────────────────────────────────────────────────
    let session_id = '';
    try { session_id = String((await req.json())?.session_id ?? ''); } catch { /* body vide */ }
    console.log('[2] session_id:', session_id || 'ABSENT');
    if (!session_id) return new Response(JSON.stringify({ error: 'session_id manquant' }), { status: 400, headers: corsHeaders });

    // ── Stripe ────────────────────────────────────────────────────
    console.log('[3] Stripe retrieve...');
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
    if (!stripeKey) return new Response(JSON.stringify({ error: 'STRIPE_SECRET_KEY manquante' }), { status: 400, headers: corsHeaders });

    const stripe = new Stripe(stripeKey, { apiVersion: '2024-04-10' });
    let session: Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.retrieve(session_id);
      console.log('[3] Stripe OK — payment_status:', session.payment_status, '| amount:', session.amount_total);
    } catch (e) {
      console.error('[3] Stripe ERREUR:', (e as Error).message);
      return new Response(JSON.stringify({ error: 'Stripe : ' + (e as Error).message }), { status: 404, headers: corsHeaders });
    }

    if (session.payment_status !== 'paid') {
      console.warn('[3] Non paid:', session.payment_status);
      return new Response(JSON.stringify({ error: 'Non payé : ' + session.payment_status }), { status: 402, headers: corsHeaders });
    }

    // ── Supabase — client initialisé dans le handler ─────────────
    console.log('[4] Supabase createClient...');
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );
    console.log('[4] createClient OK');

    // ── SELECT ────────────────────────────────────────────────────
    console.log('DB_CHECK: Tentative de connexion...');
    let rows: Record<string, unknown>[] = [];
    try {
      const { data, error: findErr } = await supabase
        .from('commandes')
        .select(SELECT_FIELDS)
        .eq('stripe_session_id', session_id)
        .limit(1);
      if (findErr) throw findErr;
      rows = data ?? [];
      console.log('[5] SELECT OK — lignes:', rows.length, rows[0] ? 'id=' + rows[0].id + ' statut=' + rows[0].statut : '');
    } catch (dbErr) {
      console.error('[5] ERREUR_BASE_DE_DONNEES SELECT:', (dbErr as Error).message);
      return new Response(JSON.stringify({ error: 'ERREUR_BASE_DE_DONNEES', detail: (dbErr as Error).message }), { status: 500, headers: corsHeaders });
    }

    const order = rows[0] ?? null;

    // Idempotence
    if (order && order.statut !== 'pending_payment') {
      console.log('[6] IDEMPOTENT statut=', order.statut);
      return new Response(JSON.stringify({ ok: true, orderId: Number(order.id), commande: order, already_processed: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ── UPDATE ────────────────────────────────────────────────────
    if (order) {
      console.log('[6] UPDATE id=', order.id, '→ en_attente');
      try {
        const { data: updated, error: updateErr } = await supabase
          .from('commandes')
          .update({ statut: 'en_attente' })
          .eq('id', order.id)
          .eq('statut', 'pending_payment')
          .select(SELECT_FIELDS)
          .maybeSingle();
        if (updateErr) throw updateErr;
        const result = updated ?? order;
        console.log('[6] UPDATE OK id=', result.id);
        return new Response(JSON.stringify({ ok: true, orderId: Number(result.id), commande: result }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (dbErr) {
        console.error('[6] ERREUR_BASE_DE_DONNEES UPDATE:', (dbErr as Error).message);
        return new Response(JSON.stringify({ error: 'ERREUR_BASE_DE_DONNEES', detail: (dbErr as Error).message }), { status: 500, headers: corsHeaders });
      }
    }

    // ── Fallback INSERT ───────────────────────────────────────────
    console.warn('[6] FALLBACK INSERT — aucune commande pré-créée');
    try {
      const montant = Number((session.amount_total ?? 0) / 100);
      const { data: newOrder, error: insertErr } = await supabase
        .from('commandes')
        .insert({ stripe_session_id: session_id, statut: 'en_attente', montant, type: 'sur_place', pts_a_crediter: 0, created_at: new Date().toISOString() })
        .select(SELECT_FIELDS)
        .maybeSingle();
      if (insertErr) throw insertErr;
      console.log('[6] INSERT OK id=', newOrder?.id);
      return new Response(JSON.stringify({ ok: true, orderId: Number(newOrder?.id ?? 0), commande: newOrder ?? {} }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (dbErr) {
      console.error('[6] ERREUR_BASE_DE_DONNEES INSERT:', (dbErr as Error).message);
      return new Response(JSON.stringify({ error: 'ERREUR_BASE_DE_DONNEES', detail: (dbErr as Error).message }), { status: 500, headers: corsHeaders });
    }

  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    console.error('[ERR]', msg, (err as Error).stack ?? '');
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: corsHeaders });
  }
});
