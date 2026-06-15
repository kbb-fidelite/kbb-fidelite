/**
 * verify-payment — Supabase Edge Function
 *
 * Sécurité :
 *  - Vérifie le paiement via l'API REST Stripe (jamais confiance au client)
 *  - Le montant est pris de Stripe (amount_total) — pas du client
 *  - Écrit en base via SUPABASE_SERVICE_ROLE_KEY (bypass RLS)
 *  - Idempotence : stripe_session_id = clé unique, pas de doublon
 *  - Valide que session_id commence par "cs_"
 *  - Ne logue jamais les clés secrètes
 *
 * La commande est créée ICI après confirmation Stripe — jamais avant.
 * Les données d'affichage (type, items, clientTel…) viennent du client mais
 * n'affectent pas la sécurité : seul le montant vient de Stripe.
 *
 * Aucun SDK tiers — fetch natif uniquement.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const FIELDS = 'id, statut, montant, pts_a_crediter, client_telephone, items, type, heure_retrait, stripe_session_id, delivery_address';

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
    // ── 1. Lecture du body ─────────────────────────────────────────
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* body vide */ }

    const session_id    = String(body?.session_id    ?? '');
    // Données de commande transmises par le client (affichage uniquement — montant vient de Stripe)
    const orderType     = String(body?.orderType     || 'sur_place');
    const heureRetrait  = body?.heureRetrait  ? String(body.heureRetrait)  : null;
    const items         = body?.items         ? String(body.items)         : null;
    const clientTel     = body?.clientTel     ? String(body.clientTel)     : null;
    const ptsACrediter  = parseInt(String(body?.ptsACrediter  ?? 0)) || 0;
    const rewardId      = parseInt(String(body?.rewardId      ?? 0)) || null;
    const rewardPts     = parseInt(String(body?.rewardPts     ?? 0)) || 0;
    const rewardNom     = body?.rewardNom     ? String(body.rewardNom)     : null;
    const deliveryAddress = (body?.deliveryAddress && typeof body.deliveryAddress === 'object')
      ? body.deliveryAddress
      : null;

    console.log('[VP] session_id:', session_id?.substring(0, 20), '— orderType:', orderType, '— tel:', clientTel ? '...'+String(clientTel).slice(-4) : '—');

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

    // ── 3. Vérification Stripe (source de vérité pour le montant) ─
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

    // Montant vérifié côté Stripe — pas du client
    const montant = Number((session.amount_total ?? 0) / 100);

    // ── 4. Idempotence — chercher commande existante ───────────────
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

    const existing = rows?.[0] ?? null;

    // ── 5. Idempotence — commande déjà activée ────────────────────
    if (existing && existing.statut !== 'pending_payment') {
      console.log('[VP] IDEMPOTENT — statut :', existing.statut);
      return res(buildResponse(existing, true));
    }

    // ── 6a. Commande pré-créée (pending_payment) — transition ─────
    // Compatibilité avec les éventuelles commandes pré-créées avant le déploiement de ce fix.
    if (existing && existing.statut === 'pending_payment') {
      console.log('[VP] UPDATE pending_payment → en_attente id=', existing.id);
      const t2 = Date.now();
      const { data: updated, error: updateErr } = await supabase
        .from('commandes')
        .update({ statut: 'en_attente' })
        .eq('id', existing.id)
        .eq('statut', 'pending_payment')
        .select(FIELDS)
        .maybeSingle();

      if (updateErr) {
        console.error('[VP] UPDATE ERREUR :', updateErr.message);
        return res({ error: 'ERREUR_BASE_DE_DONNEES', detail: updateErr.message }, 500);
      }
      console.log('[VP] UPDATE OK en', Date.now() - t2, 'ms');
      return res(buildResponse(updated ?? existing, false));
    }

    // ── 6b. INSERT — création après paiement confirmé ─────────────
    // Le paiement est confirmé par Stripe. On crée maintenant la commande.
    console.log('[VP] INSERT commande — type:', orderType, '| montant:', montant);
    const t3 = Date.now();

    const orderPayload: Record<string, unknown> = {
      stripe_session_id: session_id,
      statut:            'en_attente',
      montant,
      type:              orderType || 'sur_place',
      items:             items ?? null,
      client_telephone:  clientTel ?? null,
      heure_retrait:     heureRetrait ?? null,
      pts_a_crediter:    ptsACrediter,
      created_at:        new Date().toISOString(),
    };

    if (rewardNom) orderPayload.reward_nom = rewardNom;
    if (rewardPts) orderPayload.reward_pts = rewardPts;
    if (rewardId && !isNaN(rewardId) && rewardId > 0) orderPayload.reward_id = rewardId;
    if (deliveryAddress) orderPayload.delivery_address = deliveryAddress;

    const { data: newOrder, error: insertErr } = await supabase
      .from('commandes')
      .insert(orderPayload)
      .select(FIELDS)
      .maybeSingle();

    if (insertErr) {
      console.error('[VP] INSERT ERREUR :', insertErr.message);
      return res({ error: 'ERREUR_BASE_DE_DONNEES', detail: insertErr.message }, 500);
    }
    console.log('[VP] INSERT OK en', Date.now() - t3, 'ms — id :', newOrder?.id);
    return res(buildResponse(newOrder ?? {}, false));

  } catch (err) {
    const msg   = (err as Error).message ?? String(err);
    const stack = (err as Error).stack   ?? '';
    const type  = (err as Error).name    ?? typeof err;
    console.error('[VP] ERREUR FATALE :', msg);
    console.error('[VP] STACK :', stack);
    return res({ error: msg, stack, type, raw: String(err) }, 500);
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
