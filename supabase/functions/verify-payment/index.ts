// Pas d'import Stripe SDK — appel fetch direct à l'API Stripe REST
// Élimine tout problème de compatibilité d'import avec Deno
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

console.log('MODULE CHARGE');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SELECT_FIELDS = 'id, statut, montant, pts_a_crediter, client_telephone, items, type, heure_retrait';

/** Appel direct à l'API REST Stripe — sans SDK */
async function stripeRetrieveSession(sessionId: string, secretKey: string) {
  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { 'Authorization': `Bearer ${secretKey}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Stripe ${res.status}: ${data?.error?.message ?? JSON.stringify(data)}`);
  return data as { id: string; payment_status: string; amount_total: number };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: corsHeaders });

  try {
    console.log('[1] Handler démarré');

    // ── session_id ────────────────────────────────────────────────
    let session_id = '';
    try { session_id = String((await req.json())?.session_id ?? ''); } catch { /* body vide */ }
    console.log('[2] session_id:', session_id || 'ABSENT');
    if (!session_id) {
      return new Response(JSON.stringify({ error: 'session_id manquant' }), { status: 400, headers: corsHeaders });
    }

    // ── Secrets ───────────────────────────────────────────────────
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
    const supaUrl   = Deno.env.get('SUPABASE_URL') ?? '';
    const supaKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY') ?? '';
    console.log('[3] STRIPE_SECRET_KEY:', stripeKey ? 'OK len=' + stripeKey.length : 'VIDE ⚠️');
    console.log('[3] SUPABASE_URL:', supaUrl ? 'OK' : 'VIDE ⚠️');
    console.log('[3] SERVICE_ROLE_KEY:', supaKey ? 'OK' : 'VIDE ⚠️');
    if (!stripeKey || !supaUrl || !supaKey) {
      return new Response(JSON.stringify({ error: 'Secrets manquants' }), { status: 400, headers: corsHeaders });
    }

    // ── Stripe REST (fetch direct — pas de SDK) ───────────────────
    console.log('[4] Stripe REST retrieve...');
    let stripeSession: { id: string; payment_status: string; amount_total: number };
    try {
      const t0 = Date.now();
      stripeSession = await stripeRetrieveSession(session_id, stripeKey);
      console.log('[4] Stripe OK en', Date.now() - t0, 'ms — payment_status:', stripeSession.payment_status, '| amount:', stripeSession.amount_total);
    } catch (e) {
      console.error('[4] Stripe ERREUR:', (e as Error).message);
      return new Response(JSON.stringify({ error: 'Stripe : ' + (e as Error).message }), { status: 404, headers: corsHeaders });
    }

    if (stripeSession.payment_status !== 'paid') {
      console.warn('[4] Non paid:', stripeSession.payment_status);
      return new Response(JSON.stringify({ error: 'Non payé : ' + stripeSession.payment_status }), { status: 402, headers: corsHeaders });
    }

    // ── Supabase ──────────────────────────────────────────────────
    console.log('[5] Supabase SELECT...');
    const supabase = createClient(supaUrl, supaKey);

    const t1 = Date.now();
    const { data: rows, error: findErr } = await supabase
      .from('commandes')
      .select(SELECT_FIELDS)
      .eq('stripe_session_id', session_id)
      .limit(1);

    if (findErr) {
      console.error('[5] SELECT ERREUR:', findErr.message, findErr.code);
      return new Response(JSON.stringify({ error: 'ERREUR_BASE_DE_DONNEES', detail: findErr.message }), { status: 500, headers: corsHeaders });
    }
    console.log('[5] SELECT OK en', Date.now() - t1, 'ms — lignes:', rows?.length ?? 0);

    const order = rows?.[0] ?? null;

    // Idempotence
    if (order && order.statut !== 'pending_payment') {
      console.log('[6] IDEMPOTENT statut=', order.statut);
      return new Response(JSON.stringify({ ok: true, orderId: Number(order.id), commande: order, already_processed: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // UPDATE
    if (order) {
      console.log('[6] UPDATE id=', order.id, '→ en_attente');
      const t2 = Date.now();
      const { data: updated, error: updateErr } = await supabase
        .from('commandes')
        .update({ statut: 'en_attente' })
        .eq('id', order.id)
        .eq('statut', 'pending_payment')
        .select(SELECT_FIELDS)
        .maybeSingle();
      if (updateErr) {
        console.error('[6] UPDATE ERREUR:', updateErr.message);
        return new Response(JSON.stringify({ error: 'ERREUR_BASE_DE_DONNEES', detail: updateErr.message }), { status: 500, headers: corsHeaders });
      }
      console.log('[6] UPDATE OK en', Date.now() - t2, 'ms');
      const result = updated ?? order;
      return new Response(JSON.stringify({ ok: true, orderId: Number(result.id), commande: result }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Fallback INSERT
    console.warn('[6] FALLBACK INSERT');
    const montant = Number((stripeSession.amount_total ?? 0) / 100);
    const t3 = Date.now();
    const { data: newOrder, error: insertErr } = await supabase
      .from('commandes')
      .insert({ stripe_session_id: session_id, statut: 'en_attente', montant, type: 'sur_place', pts_a_crediter: 0, created_at: new Date().toISOString() })
      .select(SELECT_FIELDS)
      .maybeSingle();
    if (insertErr) {
      console.error('[6] INSERT ERREUR:', insertErr.message);
      return new Response(JSON.stringify({ error: 'ERREUR_BASE_DE_DONNEES', detail: insertErr.message }), { status: 500, headers: corsHeaders });
    }
    console.log('[6] INSERT OK en', Date.now() - t3, 'ms — id:', newOrder?.id);
    return new Response(JSON.stringify({ ok: true, orderId: Number(newOrder?.id ?? 0), commande: newOrder ?? {} }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    console.error('[ERR FATAL]', msg, (err as Error).stack ?? '');
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: corsHeaders });
  }
});
