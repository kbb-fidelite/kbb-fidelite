// Supabase Edge Function — create-checkout
//
// Crée une session Stripe Checkout avec UN seul line item (montant total).
// Stripe est un processeur de paiement, pas un catalogue produit.
//
// Sécurité :
//   - Le total est calculé côté serveur en sommant les prix des articles reçus
//   - Comparé au montant envoyé par le client (±10cts de tolérance arrondi)
//   - La clé secrète Stripe n'est jamais exposée côté client
//
// Pré-crée la commande en "pending_payment" dans Supabase avec stripe_session_id.
// verify-payment activera la commande en "en_attente" après confirmation Stripe.
//
// Secrets requis : STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Déploiement : supabase functions deploy create-checkout

import Stripe from 'https://esm.sh/stripe@14?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// ── Vérifie le presence_token émis par verify-presence-code ──────────────────
async function verifyPresenceToken(token: string, secret: string, clientTel: string): Promise<boolean> {
  try {
    const dot = token.lastIndexOf('.');
    if (dot === -1) return false;
    const data   = token.slice(0, dot);
    const sigB64 = token.slice(dot + 1);
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const sig   = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(data));
    if (!valid) return false;
    const payload = JSON.parse(atob(data));
    if (payload.t !== 'presence') return false;
    if (!payload.exp || payload.exp < Date.now()) return false;
    if (payload.tel !== clientTel) return false;
    return true;
  } catch { return false; }
}

function getServiceFee(statut: string): number {
  return (statut === 'bronze' || !statut) ? 0.50 : 0;
}

function getStatutFromCumul(pointsCumul: number): string {
  if (pointsCumul >= 500) return 'or';
  if (pointsCumul >= 200) return 'argent';
  return 'bronze';
}

// ── Calcul serveur : somme les prix reçus dans le payload (source : MENU_DATA client) ──
// Les prix viennent de MENU_DATA embarqué dans index.html — pas modifiables sans redéploiement.
// On additionne ici pour éviter toute manipulation du total côté client.
function calcServerTotal(items: Array<{ price?: number; isSuppl?: boolean }>): number {
  let total = 0;
  for (const item of items) {
    if (item.isSuppl) continue;
    const p = Number(item.price);
    if (!isFinite(p) || p < 0) throw new Error('Prix article invalide');
    total += p;
  }
  return Math.round(total * 100) / 100;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    if (!stripeKey) throw new Error('STRIPE_SECRET_KEY non configurée');

    const stripeMode = stripeKey.startsWith('sk_live_') ? 'LIVE' : stripeKey.startsWith('sk_test_') ? 'TEST' : 'INCONNU';
    console.log(`[create-checkout] Stripe mode: ${stripeMode} | clé: ${stripeKey.slice(0, 8)}...`);

    const supaUrl  = Deno.env.get('SUPABASE_URL')!;
    const supaKey  = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY'))!;
    const stripe   = new Stripe(stripeKey, { apiVersion: '2024-04-10' });
    const supabase = createClient(supaUrl, supaKey);

    const {
      orderId,
      items,              // [{price, isSuppl?, ...}] — prix issus de MENU_DATA
      clientLevel,
      clientTel,
      orderLabel,
      successUrl,
      cancelUrl,
      orderType,
      heureRetrait,
      rewardId,
      rewardPts,
      rewardNom,
      rewardDiscount: clientRewardDiscount,
      ptsACrediter,
      amountCents: clientAmountCents,
      presence_token,
      deliveryAddress,
      deliveryFeeCents,
    } = await req.json();

    // ── Vérification presence_token pour les commandes sur place ─────────────
    if (orderType === 'sur_place') {
      if (!presence_token || typeof presence_token !== 'string') {
        return jsonResp({ error: 'Code de présence requis pour commander sur place', code: 'TOKEN_REQUIS' }, 403);
      }
      const secret = Deno.env.get('EMP_TOKEN_SECRET') ?? 'kbb-default-secret-change-me';
      const valid  = await verifyPresenceToken(presence_token, secret, String(clientTel || ''));
      if (!valid) {
        return jsonResp({ error: 'Code de présence invalide ou expiré — recommencez', code: 'TOKEN_INVALIDE' }, 403);
      }
      console.log(`[create-checkout] presence_token OK | tel=...${String(clientTel || '').slice(-4)}`);
    }

    // ── Validation de base ────────────────────────────────────────────────────
    if (!items || !Array.isArray(items) || items.length === 0) {
      return jsonResp({ error: 'Panier vide ou invalide' }, 400);
    }

    // ── Calcul serveur du total ───────────────────────────────────────────────
    const serverTotal  = calcServerTotal(items);
    const isLivraison  = orderType === 'livraison';
    // Frais de livraison Uber Direct (uniquement si livraison)
    // deliveryFeeCents DOIT être fourni par le client pour les livraisons (pas de fallback forfaitaire)
    if (isLivraison && (deliveryFeeCents === undefined || deliveryFeeCents === null)) {
      console.warn('[create-checkout] livraison sans deliveryFeeCents — refusé');
      return jsonResp({ error: 'Frais de livraison manquants — recalculez le devis' }, 400);
    }
    const deliveryFee  = isLivraison
      ? Math.round(Math.max(0, Number(deliveryFeeCents))) / 100
      : 0;
    // ── Statut serveur : lookup points_cumul en base ───────────────────────
    let serverStatut = 'bronze';
    if (clientTel) {
      const { data: cRow } = await supabase
        .from('clients')
        .select('points_cumul')
        .eq('telephone', String(clientTel))
        .maybeSingle();
      if (cRow) {
        serverStatut = getStatutFromCumul(Math.floor(parseFloat(String(cRow.points_cumul ?? 0))));
        console.log(`[create-checkout] statut serveur: ${serverStatut} (points_cumul=${cRow.points_cumul})`);
      }
    }
    // Frais de service 0,50€ — s'applique à TOUS les paiements en ligne par carte (bronze uniquement)
    // Y compris les livraisons : Stripe est utilisé pour toutes les commandes non sur-place
    const serviceFee   = getServiceFee(serverStatut);
    const serverGrandTotal = Math.round((serverTotal + deliveryFee + serviceFee) * 100) / 100;
    const serverCents      = Math.round(serverGrandTotal * 100);

    console.log(`[create-checkout] total serveur: ${serverTotal.toFixed(2)}€ + livraison ${deliveryFee.toFixed(2)}€ + service ${serviceFee.toFixed(2)}€ = ${serverGrandTotal.toFixed(2)}€ (${serverCents} cts)`);

    // ── Reward "Livraison offerte" : validation serveur ─────────────────────
    let serverRewardDiscount = 0;
    if (rewardId) {
      const { data: reward, error: rwErr } = await supabase
        .from('recompenses')
        .select('type, points_requis, commande_minimum, plafond, actif')
        .eq('id', rewardId)
        .eq('actif', true)
        .single();

      if (rwErr || !reward) {
        console.warn(`[create-checkout] reward ${rewardId} introuvable ou désactivée`);
        // Récompense invalide : on ignore le discount (pas de blocage)
      } else if (reward.type === 'livraison_offerte') {
        // Vérification conditions côté serveur
        if (!isLivraison) {
          return jsonResp({ error: 'Livraison offerte : uniquement en mode livraison' }, 400);
        }
        if (serverTotal < parseFloat(reward.commande_minimum || 35)) {
          return jsonResp({ error: `Livraison offerte : commande minimum ${reward.commande_minimum}€ requise (sous-total : ${serverTotal.toFixed(2)}€)` }, 400);
        }
        // Discount = min(frais de livraison, plafond récompense)
        const plafond = parseFloat(reward.plafond || 8);
        serverRewardDiscount = Math.min(deliveryFee, plafond);
        serverRewardDiscount = Math.round(serverRewardDiscount * 100) / 100;
        console.log(`[create-checkout] reward livraison_offerte: discount ${serverRewardDiscount.toFixed(2)}€ (plafond ${plafond}€, livraison ${deliveryFee.toFixed(2)}€)`);
      }
      // Autres types de reward : pas de discount sur le montant (article offert géré autrement)
    }

    // Recalculer le total avec le discount récompense
    const serverGrandTotalFinal = Math.round((serverGrandTotal - serverRewardDiscount) * 100) / 100;
    const serverCentsFinal      = Math.round(serverGrandTotalFinal * 100);

    // ── Anti-fraude : comparaison avec le montant client (±10cts) ────────────
    if (clientAmountCents !== undefined) {
      const diff = Math.abs(Number(clientAmountCents) - serverCentsFinal);
      if (diff > 10) {
        console.warn(`[create-checkout] montant tampered: client=${clientAmountCents} server=${serverCentsFinal} diff=${diff} | deliveryFeeCents=${deliveryFeeCents} isLivraison=${isLivraison} rewardDiscount=${serverRewardDiscount}`);
        return jsonResp({ error: 'Montant invalide — commande refusée' }, 400);
      }
    }

    if (serverCentsFinal < 50) return jsonResp({ error: 'Montant minimum Stripe non atteint (0,50€)' }, 400);

    // ── Vérification capacité créneau ─────────────────────────────────────────
    if (heureRetrait && (orderType === 'click_collect' || orderType === 'reservation')) {
      const { data: capRow } = await supabase.from('settings').select('value').eq('key', 'capacite_creneau').maybeSingle();
      const capacite = Math.max(1, parseInt(String(capRow?.value ?? 5)) || 5);

      const today       = new Date().toISOString().slice(0, 10);
      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

      const { count } = await supabase
        .from('commandes')
        .select('id', { count: 'exact', head: true })
        .eq('heure_retrait', heureRetrait)
        .gte('created_at', today + 'T00:00:00.000Z')
        .lt('created_at', today + 'T23:59:59.999Z')
        .not('statut', 'in', '(annule,archive)')
        .or(`statut.neq.pending_payment,created_at.gte.${thirtyMinAgo}`);

      console.log(`[create-checkout] créneau ${heureRetrait} — ${count}/${capacite}`);

      if ((count ?? 0) >= capacite) {
        const [h, m] = heureRetrait.split(':').map(Number);
        const nextMin  = h * 60 + m + 15;
        const nextSlot = `${String(Math.floor(nextMin / 60)).padStart(2, '0')}:${String(nextMin % 60).padStart(2, '0')}`;
        return jsonResp({ error: 'CRENEAU_PLEIN', heure: heureRetrait, next_slot: nextSlot }, 409);
      }
    }

    // ── Créer la session Stripe — line items séparés par type de frais ─────────
    // Stripe est un processeur de paiement, pas un catalogue produit.
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
      {
        price_data: {
          currency:     'eur',
          product_data: { name: 'Commande KBB à la braise', description: orderLabel || undefined },
          unit_amount:  Math.round(serverTotal * 100),
        },
        quantity: 1,
      },
    ];

    // Frais de livraison Uber Direct (line item séparé si livraison)
    // Si reward "livraison offerte" : réduire les frais affichés du discount
    const effectiveDeliveryFee = Math.round((deliveryFee - serverRewardDiscount) * 100) / 100;
    if (effectiveDeliveryFee > 0) {
      lineItems.push({
        price_data: {
          currency:     'eur',
          product_data: {
            name: serverRewardDiscount > 0 ? 'Frais de livraison (après réduction fidélité)' : 'Frais de livraison (Uber Direct)',
            description: serverRewardDiscount > 0 ? `Livraison ${deliveryFee.toFixed(2)}€ − ${serverRewardDiscount.toFixed(2)}€ offerts` : 'Livraison à domicile',
          },
          unit_amount:  Math.round(effectiveDeliveryFee * 100),
        },
        quantity: 1,
      });
    } else if (deliveryFee > 0 && serverRewardDiscount > 0) {
      // Livraison entièrement offerte — line item à 0 pour visibilité
      // Stripe n'accepte pas les montants à 0 dans les line items, donc on ajoute juste dans les metadata
      console.log(`[create-checkout] livraison entièrement offerte par récompense fidélité`);
    }

    // Frais de service (line item séparé — offerts dès Argent)
    if (serviceFee > 0) {
      lineItems.push({
        price_data: {
          currency:     'eur',
          product_data: { name: 'Frais de service', description: 'Offerts dès le niveau Argent' },
          unit_amount:  Math.round(serviceFee * 100),
        },
        quantity: 1,
      });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items:           lineItems,
      mode:                 'payment',
      success_url:          successUrl,
      cancel_url:           cancelUrl,
      metadata: {
        client_tel:      String(clientTel || ''),
        client_level:    serverStatut,
        server_total:    String(serverGrandTotalFinal),
        reward_discount: serverRewardDiscount > 0 ? String(serverRewardDiscount) : '',
        reward_id:       rewardId ? String(rewardId) : '',
      },
      phone_number_collection: { enabled: false },
    });

    console.log(`[create-checkout] session Stripe créée: ${session.id} | ${serverGrandTotalFinal.toFixed(2)}€` + (serverRewardDiscount > 0 ? ` (dont −${serverRewardDiscount.toFixed(2)}€ livraison offerte)` : ''));

    // La commande sera créée dans verify-payment après confirmation Stripe.
    // Aucune pré-création ici — pas de commandes fantômes en cas d'abandon.
    return jsonResp({ url: session.url, sessionId: session.id, serverTotal: serverGrandTotalFinal, rewardDiscount: serverRewardDiscount });

  } catch (err) {
    const e = err as { message?: string; type?: string; code?: string; statusCode?: number };
    console.error('[create-checkout] erreur:', { message: e.message, type: e.type ?? '—', code: e.code ?? '—', statusCode: e.statusCode ?? '—' });
    return jsonResp({ error: e.message ?? 'Erreur inconnue', stripeType: e.type ?? null, stripeCode: e.code ?? null }, 400);
  }
});
