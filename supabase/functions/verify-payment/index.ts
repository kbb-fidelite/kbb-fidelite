/**
 * verify-payment — Supabase Edge Function
 *
 * Sécurité :
 *  - Vérifie le paiement via l'API REST Stripe (jamais confiance au client)
 *  - Écrit en base via SUPABASE_SERVICE_ROLE_KEY (bypass RLS)
 *  - Idempotence : stripe_session_id = clé unique, pas de doublon
 *  - Valide que session_id commence par "cs_"
 *  - Ne logue jamais les clés secrètes
 *
 * Aucun SDK tiers — fetch natif uniquement.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const FIELDS = 'id, statut, montant, pts_a_crediter, client_telephone, items, type, heure_retrait';

function res(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

/** Appel REST Stripe — sans SDK */
async function stripeGetSession(sessionId: string, secretKey: string) {
  const r = await fetch(
    'https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(sessionId),
    { headers: { Authorization: 'Bearer ' + secretKey } }
  );
  const json = await r.json();
  if (!r.ok) throw new Error('Stripe ' + r.status + ': ' + (json?.error?.message ?? r.statusText));
  return json as { id: string; payment_status: string; amount_total: number };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: CORS });

  try {
    // ── 1. session_id ─────────────────────────────────────────────
    let session_id = '';
    try { session_id = String((await req.json())?.session_id ?? ''); } catch { /* body vide */ }

    console.log('[VP] session_id reçu :', session_id ? session_id.slice(0, 20) + '…' : 'ABSENT');

    if (!session_id) return res({ error: 'session_id manquant' }, 400);
    if (!session_id.startsWith('cs_')) return res({ error: 'session_id invalide (doit commencer par cs_)' }, 400);

    // ── 2. Secrets ────────────────────────────────────────────────
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
    const supaUrl   = Deno.env.get('SUPABASE_URL') ?? '';
    const supaKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY') ?? '';

    console.log('[VP] secrets — stripe:', stripeKey ? 'OK' : 'MANQUANT', '| supa:', supaUrl ? 'OK' : 'MANQUANT', '| role:', supaKey ? 'OK' : 'MANQUANT');

    if (!stripeKey) return res({ error: 'STRIPE_SECRET_KEY manquante' }, 400);
    if (!supaUrl)   return res({ error: 'SUPABASE_URL manquant' }, 400);
    if (!supaKey)   return res({ error: 'SERVICE_ROLE_KEY manquant' }, 400);

    // ── 3. Vérification Stripe (source de vérité) ─────────────────
    console.log('[VP] appel Stripe REST…');
    const t0 = Date.now();
    let session: { id: string; payment_status: string; amount_total: number };
    try {
      session = await stripeGetSession(session_id, stripeKey);
    } catch (e) {
      console.error('[VP] Stripe ERREUR :', (e as Error).message);
      return res({ error: 'Stripe : ' + (e as Error).message }, 404);
    }
    console.log('[VP] Stripe OK en', Date.now() - t0, 'ms — status:', session.payment_status);

    if (session.payment_status !== 'paid') {
      return res({ error: 'Paiement non confirmé : ' + session.payment_status }, 402);
    }

    // ── 4. Supabase — recherche commande existante ─────────────────
    const supabase = createClient(supaUrl, supaKey);

    console.log('[VP] SELECT commande…');
    const t1 = Date.now();
    const { data: rows, error: findErr } = await supabase
      .from('commandes')
      .select(FIELDS)
      .eq('stripe_session_id', session_id)
      .limit(1);

    if (findErr) {
      console.error('[VP] SELECT ERREUR :', findErr.message, findErr.code);
      return res({ error: 'ERREUR_BASE_DE_DONNEES', detail: findErr.message }, 500);
    }
    console.log('[VP] SELECT OK en', Date.now() - t1, 'ms — lignes :', rows?.length ?? 0);

    const order = rows?.[0] ?? null;

    // ── 5. Idempotence — commande déjà activée ────────────────────
    if (order && order.statut !== 'pending_payment') {
      console.log('[VP] IDEMPOTENT — statut :', order.statut);
      return res(buildResponse(order, true));
    }

    // ── 6a. Activer la commande pré-créée ─────────────────────────
    if (order) {
      console.log('[VP] UPDATE pending_payment → en_attente id=', order.id);
      const t2 = Date.now();
      const { data: updated, error: updateErr } = await supabase
        .from('commandes')
        .update({ statut: 'en_attente' })
        .eq('id', order.id)
        .eq('statut', 'pending_payment')
        .select(FIELDS)
        .maybeSingle();

      if (updateErr) {
        console.error('[VP] UPDATE ERREUR :', updateErr.message);
        return res({ error: 'ERREUR_BASE_DE_DONNEES', detail: updateErr.message }, 500);
      }
      console.log('[VP] UPDATE OK en', Date.now() - t2, 'ms');
      return res(buildResponse(updated ?? order, false));
    }

    // ── 6b. Fallback INSERT (create-checkout n'a pas pré-créé) ────
    console.warn('[VP] FALLBACK INSERT — aucune commande pré-créée pour', session_id.slice(0, 20));
    const montant = Number((session.amount_total ?? 0) / 100);
    const t3 = Date.now();
    const { data: newOrder, error: insertErr } = await supabase
      .from('commandes')
      .insert({
        stripe_session_id: session_id,
        statut:            'en_attente',
        montant,
        type:              'sur_place',
        pts_a_crediter:    0,
        created_at:        new Date().toISOString(),
      })
      .select(FIELDS)
      .maybeSingle();

    if (insertErr) {
      console.error('[VP] INSERT ERREUR :', insertErr.message);
      return res({ error: 'ERREUR_BASE_DE_DONNEES', detail: insertErr.message }, 500);
    }
    console.log('[VP] INSERT OK en', Date.now() - t3, 'ms — id :', newOrder?.id);
    return res(buildResponse(newOrder ?? {}, false));

  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    console.error('[VP] ERREUR FATALE :', msg);
    return res({ error: msg }, 500);
  }
});

/** Formate la réponse finale attendue par le frontend */
function buildResponse(order: Record<string, unknown>, already_processed: boolean) {
  const id  = Number(order.id ?? 0);
  const pts = Number(order.pts_a_crediter ?? 0);
  return {
    ok:              true,
    orderId:         id,
    numero_commande: id ? '#KBB-' + String(id).padStart(3, '0') : null,
    montant:         Number(order.montant ?? 0),
    points_gagnes:   pts,
    commande:        order,
    ...(already_processed ? { already_processed: true } : {}),
  };
}
