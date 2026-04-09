// Supabase Edge Function — verify-payment
// Vérifie auprès de Stripe que le paiement est "paid",
// active la commande pré-créée (pending_payment → en_attente),
// renvoie l'objet commande COMPLET (pas de SELECT client côté frontend).
//
// Idempotence : stripe_session_id est la clé unique — appels multiples safe.

import Stripe from 'https://esm.sh/stripe@14?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SELECT_FIELDS = 'id, statut, montant, pts_a_crediter, client_telephone, items, type, heure_retrait';

/** Cast explicite en nombre — évite d'envoyer des strings à Supabase */
function toNum(v: unknown, fallback = 0): number {
  const n = Number(v);
  return isNaN(n) ? fallback : n;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {

    // ── ÉTAPE 1 : vérification des secrets ───────────────────────
    console.log('[verify-payment] ÉTAPE 1 — lecture des secrets');
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    const supaUrl   = Deno.env.get('SUPABASE_URL');
    const supaKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY');

    if (!stripeKey) {
      console.error('[verify-payment] SECRET MANQUANT: STRIPE_SECRET_KEY');
      return json({ error: 'Configuration serveur incomplète : STRIPE_SECRET_KEY manquant' }, 400);
    }
    if (!supaUrl) {
      console.error('[verify-payment] SECRET MANQUANT: SUPABASE_URL');
      return json({ error: 'Configuration serveur incomplète : SUPABASE_URL manquant' }, 400);
    }
    if (!supaKey) {
      console.error('[verify-payment] SECRET MANQUANT: SUPABASE_SERVICE_ROLE_KEY');
      return json({ error: 'Configuration serveur incomplète : SERVICE_ROLE_KEY manquant' }, 400);
    }
    console.log('[verify-payment] secrets OK');

    // ── ÉTAPE 2 : lecture du body ────────────────────────────────
    console.log('[verify-payment] ÉTAPE 2 — lecture body');
    const body = await req.json().catch(() => ({}));
    const { session_id } = body as { session_id?: string };

    if (!session_id || typeof session_id !== 'string' || !session_id.startsWith('cs_')) {
      console.error('[verify-payment] session_id invalide:', session_id);
      return json({ error: 'session_id manquant ou invalide' }, 400);
    }
    console.log('[verify-payment] session_id reçu:', session_id);

    // ── ÉTAPE 3 : récupération session Stripe (source de vérité) ─
    console.log('[verify-payment] ÉTAPE 3 — Tentative de récupération de la session Stripe...');
    const stripe = new Stripe(stripeKey, { apiVersion: '2024-04-10' });
    let session: Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.retrieve(session_id);
      console.log('[verify-payment] Session Stripe récupérée — statut:', session.payment_status,
        '| montant:', session.amount_total, '| currency:', session.currency);
    } catch (stripeErr) {
      console.error('[verify-payment] Erreur Stripe retrieve:', stripeErr);
      return json({ error: 'Session Stripe introuvable : ' + (stripeErr as Error).message }, 404);
    }

    if (session.payment_status !== 'paid') {
      console.warn('[verify-payment] Paiement non confirmé — statut Stripe:', session.payment_status);
      return json({ error: `Paiement non confirmé — statut : ${session.payment_status}` }, 402);
    }

    // ── ÉTAPE 4 : recherche commande existante dans Supabase ─────
    console.log('[verify-payment] ÉTAPE 4 — recherche commande stripe_session_id =', session_id);
    const supabase = createClient(supaUrl, supaKey);

    const { data: orders, error: findErr } = await supabase
      .from('commandes')
      .select(SELECT_FIELDS)
      .eq('stripe_session_id', session_id)
      .limit(1);

    if (findErr) {
      console.error('[verify-payment] Erreur SELECT commandes:', findErr);
      throw new Error('Erreur recherche commande : ' + findErr.message);
    }
    console.log('[verify-payment] commandes trouvées:', orders?.length ?? 0,
      orders?.[0] ? '| id=' + orders[0].id + ' statut=' + orders[0].statut : '');

    // ── ÉTAPE 5 : idempotence — commande déjà activée ───────────
    if (orders && orders.length > 0 && orders[0].statut !== 'pending_payment') {
      const order = orders[0];
      console.log('[verify-payment] IDEMPOTENT — commande', order.id, 'déjà au statut', order.statut);
      return json({ ok: true, orderId: Number(order.id), commande: _sanitize(order), already_processed: true });
    }

    // ── ÉTAPE 6 : activation commande pending_payment → en_attente
    if (orders && orders.length > 0) {
      const order = orders[0];
      console.log('[verify-payment] ÉTAPE 6 — Tentative d\'insertion/update dans la table commandes... id=', order.id);

      // maybeSingle() au lieu de single() : évite le 500 si 0 lignes retournées
      // (race-condition possible si deux appels simultanés)
      const { data: updated, error: updateErr } = await supabase
        .from('commandes')
        .update({ statut: 'en_attente' })
        .eq('id', order.id)
        .eq('statut', 'pending_payment')   // garde-fou idempotence
        .select(SELECT_FIELDS)
        .maybeSingle();

      if (updateErr) {
        console.error('[verify-payment] Erreur UPDATE commandes:', updateErr);
        throw new Error('Erreur activation commande : ' + updateErr.message);
      }

      // Si updated est null : race-condition (autre appel a déjà activé) — on refetch
      const result = updated ?? order;
      console.log('[verify-payment] commande', result.id, 'activée (ou déjà activée en race-condition)');
      return json({ ok: true, orderId: Number(result.id), commande: _sanitize(result) });
    }

    // ── ÉTAPE 7 : fallback INSERT (create-checkout a échoué) ────
    console.warn('[verify-payment] ÉTAPE 7 — Aucune commande pré-créée — Tentative d\'insertion/update dans la table commandes...');
    const montantNum = toNum((session.amount_total ?? 0) / 100);

    const { data: newOrder, error: insertErr } = await supabase
      .from('commandes')
      .insert({
        stripe_session_id: session_id,
        statut:            'en_attente',
        montant:           montantNum,       // Number — pas de string
        type:              'sur_place',
        pts_a_crediter:    0,               // Number
        created_at:        new Date().toISOString(),
      })
      .select(SELECT_FIELDS)
      .maybeSingle();

    if (insertErr) {
      console.error('[verify-payment] Erreur INSERT commandes:', insertErr);
      throw new Error('Erreur création commande : ' + insertErr.message);
    }

    console.log('[verify-payment] commande fallback créée — id:', newOrder?.id, 'montant:', montantNum);
    return json({ ok: true, orderId: Number(newOrder?.id), commande: _sanitize(newOrder) });

  } catch (err) {
    // ── CATCH GLOBAL ────────────────────────────────────────────
    const msg   = (err as Error).message ?? String(err);
    const stack = (err as Error).stack   ?? '';
    console.error('[verify-payment] ERREUR 500:', msg);
    console.error('[verify-payment] STACK:', stack);
    return json({ error: msg }, 500);
  }
});

/** Caste les champs numériques pour éviter tout type string dans la réponse JSON */
function _sanitize(order: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!order) return null;
  return {
    ...order,
    id:             Number(order.id),
    montant:        toNum(order.montant),
    pts_a_crediter: toNum(order.pts_a_crediter),
  };
}
