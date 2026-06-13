// Supabase Edge Function — uber-webhook
//
// Reçoit les mises à jour de statut Uber Direct via webhook POST.
// Vérifie la signature HMAC-SHA256 (header X-Postmates-Signature).
// Met à jour uber_status dans commandes et envoie une notification push au client.
//
// URL à enregistrer dans le dashboard Uber Direct :
//   https://mwfezeuaohwbhubaaddm.supabase.co/functions/v1/uber-webhook
//
// Secrets requis : UBER_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, EMP_TOKEN_SECRET
// Déploiement : supabase functions deploy uber-webhook

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const UBER_STATUS_MESSAGES: Record<string, { title: string; body: string }> = {
  pickup_enroute:  { title: '🛵 Livreur en route',     body: 'Votre livreur est en route vers KBB à la braise.' },
  pickup_arrived:  { title: '✅ Au restaurant',          body: 'Le livreur récupère votre commande — prêt dans un instant !' },
  dropoff_enroute: { title: '🚀 En chemin !',            body: 'Votre commande est en route vers vous.' },
  dropoff_arrived: { title: '📍 À votre porte',          body: 'Le livreur est arrivé devant chez vous !' },
  delivered:       { title: '🎉 Livré !',                body: 'Votre commande est livrée. Bon appétit !' },
  cancelled:       { title: '❌ Livraison annulée',      body: 'La livraison a été annulée. Contactez le restaurant.' },
  returned:        { title: '↩️ Commande retournée',     body: 'La commande n\'a pas pu être livrée et a été retournée.' },
};

async function verifyUberSignature(body: string, signature: string, secret: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const expectedSig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
    const receivedSig = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    if (expectedSig.length !== receivedSig.length) return false;
    let diff = 0;
    for (let i = 0; i < expectedSig.length; i++) diff |= expectedSig[i] ^ receivedSig[i];
    return diff === 0;
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  // Uber envoie POST — pas de preflight
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const rawBody = await req.text();

  // ── Vérification signature ──────────────────────────────────────────────────
  const webhookSecret = Deno.env.get('UBER_WEBHOOK_SECRET');
  if (webhookSecret) {
    const sig = req.headers.get('x-postmates-signature') ?? req.headers.get('x-uber-signature') ?? '';
    if (!sig) {
      console.warn('[uber-webhook] Signature absente — requête rejetée');
      return new Response('Unauthorized', { status: 401 });
    }
    const valid = await verifyUberSignature(rawBody, sig, webhookSecret);
    if (!valid) {
      console.warn('[uber-webhook] Signature invalide');
      return new Response('Unauthorized', { status: 401 });
    }
  } else {
    console.warn('[uber-webhook] UBER_WEBHOOK_SECRET non configuré — signature non vérifiée');
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  const eventType  = payload.event_type as string ?? '';
  const deliveryId = (payload.delivery_id ?? (payload.data as Record<string, unknown>)?.id) as string;
  const status     = (payload.status ?? (payload.data as Record<string, unknown>)?.status) as string;

  console.log(`[uber-webhook] event=${eventType} | delivery=${deliveryId} | status=${status}`);

  if (!deliveryId || !status) {
    // Uber envoie parfois des pings de test sans payload complet
    return new Response(JSON.stringify({ ok: true, ignored: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  // ── Récupérer la commande associée ─────────────────────────────────────────
  const { data: rows, error: fetchErr } = await supabase
    .from('commandes')
    .select('id, client_telephone, uber_status')
    .eq('uber_delivery_id', deliveryId)
    .limit(1);

  if (fetchErr) {
    console.error('[uber-webhook] SELECT commande:', fetchErr.message);
    return new Response('DB Error', { status: 500 });
  }

  if (!rows || rows.length === 0) {
    console.warn(`[uber-webhook] Aucune commande pour delivery_id=${deliveryId}`);
    return new Response(JSON.stringify({ ok: true, ignored: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const commande = rows[0];

  // ── Ignorer si statut déjà à jour (idempotence) ────────────────────────────
  if (commande.uber_status === status) {
    return new Response(JSON.stringify({ ok: true, already_processed: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Mise à jour statut Uber ─────────────────────────────────────────────────
  const { error: updateErr } = await supabase
    .from('commandes')
    .update({ uber_status: status })
    .eq('id', commande.id);

  if (updateErr) {
    console.error('[uber-webhook] UPDATE uber_status:', updateErr.message);
  }

  // ── Notification push client ────────────────────────────────────────────────
  const msg = UBER_STATUS_MESSAGES[status];
  if (msg && commande.client_telephone) {
    const internalSecret = Deno.env.get('EMP_TOKEN_SECRET') ?? 'kbb-default-secret-change-me';
    try {
      const pushRes = await fetch(
        `${Deno.env.get('SUPABASE_URL')}/functions/v1/send-push-notification`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_tel:      commande.client_telephone,
            title:           msg.title,
            body:            msg.body,
            internal_secret: internalSecret,
          }),
        }
      );
      const pushData = await pushRes.json().catch(() => ({}));
      console.log(`[uber-webhook] push ${commande.client_telephone.slice(-4)} → ${pushRes.status}`, pushData?.ok ?? pushData?.reason);
    } catch (pushErr) {
      console.error('[uber-webhook] push notification échouée:', (pushErr as Error).message);
    }
  }

  // ── MAJ statut commande si delivered ───────────────────────────────────────
  if (status === 'delivered') {
    await supabase
      .from('commandes')
      .update({ statut: 'remis_au_client' })
      .eq('id', commande.id);
    console.log(`[uber-webhook] commande ${commande.id} → remis_au_client`);
  }

  console.log(`[uber-webhook] ✅ traité | commande ${commande.id} | ${status}`);
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
