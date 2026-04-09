import Stripe from 'npm:stripe@14.23.0';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

console.log('!!! FICHIER CHARGE !!!');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SELECT_FIELDS = 'id, statut, montant, pts_a_crediter, client_telephone, items, type, heure_retrait';

function toNum(v: unknown, fallback = 0): number {
  try { const n = Number(v); return isNaN(n) ? fallback : n; } catch { return fallback; }
}

function sanitize(o: Record<string, unknown> | null) {
  if (!o) return {};
  return {
    id:             toNum(o.id),
    statut:         String(o.statut ?? ''),
    montant:        toNum(o.montant),
    pts_a_crediter: toNum(o.pts_a_crediter),
    client_telephone: String(o.client_telephone ?? ''),
    items:          o.items ?? '[]',
    type:           String(o.type ?? 'sur_place'),
    heure_retrait:  o.heure_retrait ?? null,
  };
}

Deno.serve(async (req) => {
  try {
    console.log('=== HANDLER APPELE === méthode:', req.method);

    if (req.method === 'OPTIONS') {
      return new Response('ok', { headers: corsHeaders });
    }

    // ── JWT / rôle — log uniquement, jamais bloquant (--no-verify-jwt) ──
    try {
      const authHeader = req.headers.get('Authorization') ?? '';
      console.log('Auth header présent:', authHeader.length > 0);
      const token = authHeader.replace('Bearer ', '');
      if (token) {
        const parts = token.split('.');
        if (parts.length === 3) {
          const payload = JSON.parse(atob(parts[1]));
          console.log('JWT role:', payload.role ?? 'absent');
        }
      }
    } catch (jwtErr) {
      console.log('JWT decode ignoré:', (jwtErr as Error).message);
    }

    // ── Secrets ───────────────────────────────────────────────────
    console.log('Lecture secrets...');
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
    const supaUrl   = Deno.env.get('SUPABASE_URL') ?? '';
    const supaKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY') ?? '';
    console.log('STRIPE_SECRET_KEY:', stripeKey.length > 0 ? 'OK len=' + stripeKey.length : 'VIDE ⚠️');
    console.log('SUPABASE_URL:', supaUrl.length > 0 ? 'OK' : 'VIDE ⚠️');
    console.log('SERVICE_ROLE_KEY:', supaKey.length > 0 ? 'OK len=' + supaKey.length : 'VIDE ⚠️');

    if (!stripeKey) return new Response(JSON.stringify({ error: 'STRIPE_SECRET_KEY vide' }), { status: 400, headers: corsHeaders });
    if (!supaUrl)   return new Response(JSON.stringify({ error: 'SUPABASE_URL vide' }), { status: 400, headers: corsHeaders });
    if (!supaKey)   return new Response(JSON.stringify({ error: 'SERVICE_ROLE_KEY vide' }), { status: 400, headers: corsHeaders });

    // ── Body ──────────────────────────────────────────────────────
    console.log('Lecture body...');
    let session_id = '';
    try {
      const body = await req.json();
      session_id = String(body?.session_id ?? '');
    } catch {
      console.log('Body vide ou non-JSON');
    }
    console.log('session_id:', session_id || 'ABSENT');

    if (!session_id) {
      return new Response(JSON.stringify({ error: 'session_id manquant' }), { status: 400, headers: corsHeaders });
    }

    // ── Stripe ────────────────────────────────────────────────────
    console.log('Stripe retrieve...');
    const stripe = new Stripe(stripeKey, { apiVersion: '2024-04-10' });
    let session: Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.retrieve(session_id);
      console.log('Stripe OK — payment_status:', session.payment_status, 'amount:', session.amount_total ?? 0);
    } catch (e) {
      console.error('Stripe ERREUR:', (e as Error).message);
      return new Response(JSON.stringify({ error: 'Stripe : ' + (e as Error).message }), { status: 404, headers: corsHeaders });
    }

    if (session.payment_status !== 'paid') {
      return new Response(JSON.stringify({ error: 'Non payé : ' + session.payment_status }), { status: 402, headers: corsHeaders });
    }

    // ── Supabase SELECT ───────────────────────────────────────────
    console.log('Supabase SELECT commande...');
    const supabase = createClient(supaUrl, supaKey);
    const { data: orders, error: findErr } = await supabase
      .from('commandes')
      .select(SELECT_FIELDS)
      .eq('stripe_session_id', session_id)
      .limit(1);

    if (findErr) {
      console.error('SELECT ERREUR:', findErr.message);
      throw new Error('SELECT : ' + findErr.message);
    }
    const found = orders ?? [];
    console.log('Commandes trouvées:', found.length, found[0] ? 'id=' + found[0].id + ' statut=' + found[0].statut : '');

    // Idempotence
    if (found.length > 0 && found[0].statut !== 'pending_payment') {
      console.log('IDEMPOTENT — retour commande existante');
      return new Response(
        JSON.stringify({ ok: true, orderId: toNum(found[0].id), commande: sanitize(found[0]), already_processed: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // UPDATE
    if (found.length > 0) {
      const order = found[0];
      console.log('UPDATE commande id=', order.id, '→ en_attente');
      const { data: updated, error: updateErr } = await supabase
        .from('commandes')
        .update({ statut: 'en_attente' })
        .eq('id', order.id)
        .eq('statut', 'pending_payment')
        .select(SELECT_FIELDS)
        .maybeSingle();
      if (updateErr) {
        console.error('UPDATE ERREUR:', updateErr.message);
        throw new Error('UPDATE : ' + updateErr.message);
      }
      const result = updated ?? order;
      console.log('UPDATE OK — id:', result.id);
      return new Response(
        JSON.stringify({ ok: true, orderId: toNum(result.id), commande: sanitize(result) }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Fallback INSERT
    console.warn('FALLBACK INSERT — aucune commande pré-créée');
    const montant = toNum((session.amount_total ?? 0) / 100);
    const { data: newOrder, error: insertErr } = await supabase
      .from('commandes')
      .insert({ stripe_session_id: session_id, statut: 'en_attente', montant, type: 'sur_place', pts_a_crediter: 0, created_at: new Date().toISOString() })
      .select(SELECT_FIELDS)
      .maybeSingle();
    if (insertErr) {
      console.error('INSERT ERREUR:', insertErr.message);
      throw new Error('INSERT : ' + insertErr.message);
    }
    console.log('INSERT OK id:', newOrder?.id ?? 'null');
    return new Response(
      JSON.stringify({ ok: true, orderId: toNum(newOrder?.id), commande: sanitize(newOrder ?? {}) }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    const msg   = (error as Error).message ?? String(error);
    const stack = (error as Error).stack   ?? '';
    console.error('ERREUR_DETECTEE:', msg);
    console.error('STACK:', stack);
    return new Response(
      JSON.stringify({ error: msg, stack }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
