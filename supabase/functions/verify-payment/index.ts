import Stripe from 'https://esm.sh/stripe@14.23.0?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SELECT_FIELDS = 'id, statut, montant, pts_a_crediter, client_telephone, items, type, heure_retrait';

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(label + '_TIMEOUT')), ms)),
  ]);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: corsHeaders });

  try {
    console.log('[1] Handler démarré');

    let session_id = '';
    try { session_id = String((await req.json())?.session_id ?? ''); } catch { /* body vide */ }
    console.log('[2] session_id:', session_id || 'ABSENT');
    if (!session_id) return new Response(JSON.stringify({ error: 'session_id manquant' }), { status: 400, headers: corsHeaders });

    // ── Stripe avec timeout 5s ────────────────────────────────────
    console.log('[3] Stripe retrieve (timeout 5s)...');
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
    if (!stripeKey) return new Response(JSON.stringify({ error: 'STRIPE_SECRET_KEY manquante' }), { status: 400, headers: corsHeaders });

    const stripe = new Stripe(stripeKey, { apiVersion: '2024-04-10' });
    let session: Stripe.Checkout.Session;
    try {
      const t0 = Date.now();
      session = await withTimeout(
        stripe.checkout.sessions.retrieve(session_id),
        5000,
        'STRIPE'
      );
      console.log('[3] Stripe OK en', Date.now() - t0, 'ms — payment_status:', session.payment_status, '| amount:', session.amount_total);
    } catch (e) {
      const msg = (e as Error).message;
      console.error('[3] Stripe ERREUR:', msg);
      return new Response(JSON.stringify({ error: msg.includes('STRIPE_TIMEOUT') ? 'STRIPE_TIMEOUT' : 'Stripe : ' + msg }), { status: msg.includes('STRIPE_TIMEOUT') ? 504 : 404, headers: corsHeaders });
    }

    if (session.payment_status !== 'paid') {
      console.warn('[3] Non paid:', session.payment_status);
      return new Response(JSON.stringify({ error: 'Non payé : ' + session.payment_status }), { status: 402, headers: corsHeaders });
    }

    // ── Supabase avec timeout 5s ──────────────────────────────────
    console.log('[4] Supabase createClient...');
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    console.log('DB_CHECK: Tentative de connexion...');
    let rows: Record<string, unknown>[] = [];
    try {
      const t1 = Date.now();
      const { data, error: findErr } = await withTimeout(
        supabase.from('commandes').select(SELECT_FIELDS).eq('stripe_session_id', session_id).limit(1),
        5000,
        'DB'
      );
      if (findErr) throw new Error(findErr.message);
      rows = data ?? [];
      console.log('[4] SELECT OK en', Date.now() - t1, 'ms — lignes:', rows.length);
    } catch (e) {
      const msg = (e as Error).message;
      console.error('[4] ERREUR_BASE_DE_DONNEES SELECT:', msg);
      return new Response(JSON.stringify({ error: msg.includes('DB_TIMEOUT') ? 'DB_TIMEOUT' : 'ERREUR_BASE_DE_DONNEES', detail: msg }), { status: 500, headers: corsHeaders });
    }

    const order = rows[0] ?? null;

    // Idempotence
    if (order && order.statut !== 'pending_payment') {
      console.log('[5] IDEMPOTENT statut=', order.statut);
      return new Response(JSON.stringify({ ok: true, orderId: Number(order.id), commande: order, already_processed: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // UPDATE avec timeout 5s
    if (order) {
      console.log('[5] UPDATE id=', order.id, '→ en_attente');
      try {
        const t2 = Date.now();
        const { data: updated, error: updateErr } = await withTimeout(
          supabase.from('commandes').update({ statut: 'en_attente' }).eq('id', order.id).eq('statut', 'pending_payment').select(SELECT_FIELDS).maybeSingle(),
          5000,
          'DB'
        );
        if (updateErr) throw new Error(updateErr.message);
        console.log('[5] UPDATE OK en', Date.now() - t2, 'ms');
        const result = updated ?? order;
        return new Response(JSON.stringify({ ok: true, orderId: Number(result.id), commande: result }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (e) {
        const msg = (e as Error).message;
        console.error('[5] ERREUR_BASE_DE_DONNEES UPDATE:', msg);
        return new Response(JSON.stringify({ error: msg.includes('DB_TIMEOUT') ? 'DB_TIMEOUT' : 'ERREUR_BASE_DE_DONNEES', detail: msg }), { status: 500, headers: corsHeaders });
      }
    }

    // Fallback INSERT avec timeout 5s
    console.warn('[5] FALLBACK INSERT — aucune commande pré-créée');
    try {
      const montant = Number((session.amount_total ?? 0) / 100);
      const t3 = Date.now();
      const { data: newOrder, error: insertErr } = await withTimeout(
        supabase.from('commandes').insert({ stripe_session_id: session_id, statut: 'en_attente', montant, type: 'sur_place', pts_a_crediter: 0, created_at: new Date().toISOString() }).select(SELECT_FIELDS).maybeSingle(),
        5000,
        'DB'
      );
      if (insertErr) throw new Error(insertErr.message);
      console.log('[5] INSERT OK en', Date.now() - t3, 'ms — id:', newOrder?.id);
      return new Response(JSON.stringify({ ok: true, orderId: Number(newOrder?.id ?? 0), commande: newOrder ?? {} }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
      const msg = (e as Error).message;
      console.error('[5] ERREUR_BASE_DE_DONNEES INSERT:', msg);
      return new Response(JSON.stringify({ error: msg.includes('DB_TIMEOUT') ? 'DB_TIMEOUT' : 'ERREUR_BASE_DE_DONNEES', detail: msg }), { status: 500, headers: corsHeaders });
    }

  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    console.error('[ERR FATAL]', msg, (err as Error).stack ?? '');
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: corsHeaders });
  }
});
