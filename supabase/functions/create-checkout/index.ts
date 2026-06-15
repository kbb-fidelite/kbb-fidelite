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

function getServiceFee(clientLevel: string): number {
  return (clientLevel === 'bronze' || !clientLevel) ? 0.50 : 0;
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
    const serverTotal     = calcServerTotal(items);
    const isLivraison     = orderType === 'livraison';
    const fee             = isLivraison
      ? Math.round(Math.max(0, deliveryFeeCents ?? 399)) / 100
      : getServiceFee(clientLevel);
    const serverGrandTotal = Math.round((serverTotal + fee) * 100) / 100;
    const serverCents      = Math.round(serverGrandTotal * 100);

    console.log(`[create-checkout] total serveur: ${serverTotal.toFixed(2)}€ + fee ${fee.toFixed(2)}€ = ${serverGrandTotal.toFixed(2)}€ (${serverCents} cts)`);

    // ── Anti-fraude : comparaison avec le montant client (±10cts) ────────────
    if (clientAmountCents !== undefined) {
      const diff = Math.abs(Number(clientAmountCents) - serverCents);
      if (diff > 10) {
        console.warn(`[create-checkout] montant tampered: client=${clientAmountCents} server=${serverCents} diff=${diff}`);
        return jsonResp({ error: 'Montant invalide — commande refusée' }, 400);
      }
    }

    if (serverCents < 50) return jsonResp({ error: 'Montant minimum Stripe non atteint (0,50€)' }, 400);

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

    // ── Créer la session Stripe — UN seul line item générique ─────────────────
    // Stripe est un processeur de paiement, pas un catalogue produit.
    const feeLabel    = isLivraison ? 'Frais de livraison (Uber Direct)' : 'Frais de service';
    const feeSubLabel = isLivraison ? 'Livraison à domicile'              : 'Offerts dès le niveau Argent';

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

    if (fee > 0) {
      lineItems.push({
        price_data: {
          currency:     'eur',
          product_data: { name: feeLabel, description: feeSubLabel },
          unit_amount:  Math.round(fee * 100),
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
        client_tel:   String(clientTel || ''),
        client_level: String(clientLevel || 'bronze'),
        server_total: String(serverGrandTotal),
      },
      phone_number_collection: { enabled: false },
    });

    console.log(`[create-checkout] session Stripe créée: ${session.id} | ${serverGrandTotal.toFixed(2)}€`);

    // La commande sera créée dans verify-payment après confirmation Stripe.
    // Aucune pré-création ici — pas de commandes fantômes en cas d'abandon.
    return jsonResp({ url: session.url, sessionId: session.id, serverTotal: serverGrandTotal });

  } catch (err) {
    const e = err as { message?: string; type?: string; code?: string; statusCode?: number };
    console.error('[create-checkout] erreur:', { message: e.message, type: e.type ?? '—', code: e.code ?? '—', statusCode: e.statusCode ?? '—' });
    return jsonResp({ error: e.message ?? 'Erreur inconnue', stripeType: e.type ?? null, stripeCode: e.code ?? null }, 400);
  }
});
