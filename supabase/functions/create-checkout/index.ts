// Supabase Edge Function — create-checkout (avec validation des prix côté serveur)
// Les prix sont recalculés CÔTÉ SERVEUR — le client n'envoie que les articles (noms + options)
// Pré-crée la commande en "pending_payment" dans Supabase avec stripe_session_id.
// verify-payment activera la commande en "en_attente" après vérification du paiement.
// Secrets requis : STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Déploiement : supabase functions deploy create-checkout

import Stripe from 'https://esm.sh/stripe@14?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Vérifie le presence_token émis par verify-presence-code ──────────────────
async function verifyPresenceToken(
  token: string,
  secret: string,
  clientTel: string
): Promise<boolean> {
  try {
    const dot = token.lastIndexOf('.');
    if (dot === -1) return false;
    const data   = token.slice(0, dot);
    const sigB64 = token.slice(dot + 1);
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const sig   = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(data));
    if (!valid) return false;
    const payload = JSON.parse(atob(data));
    if (payload.t !== 'presence') return false;
    if (!payload.exp || payload.exp < Date.now()) return false;
    if (payload.tel !== clientTel) return false;
    return true;
  } catch {
    return false;
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Référentiel de prix officiel (source de vérité côté serveur) ─────────────
const MENU_PRICES: Record<string, number> = {
  'Le Classique':       8.50,
  "L'Original":         8.50,
  'Le Grec':            9.50,
  'Le Phénicien':      10.50,
  'Le Chèvre Miel':    10.50,
  'Le Mexico':         10.50,
  'Le Burrata':        12.90,
  'Spicy KBB':          8.50,
  'Sweet KBB':          8.50,
  'Spicy Chicken':      8.50,
  'Sweet Chicken':      8.50,
  "L'Asia":            14.90,
  'La Burrata':        16.90,
  'La Libanaise':      16.90,
  'Menu Junior':        7.90,
  'Supplément Menu':    3.50,
  'Panna Cotta':        3.90,
  'Mousse au Chocolat': 3.90,
  'Mövenpick':          4.90,
};

const SUPPLEMENT_PRICES: Record<string, number> = {
  'Supplément viande kebab':   2.00,
  'Supplément viande poulet':  2.00,
  'Supplément burrata':        4.00,
  'Supplément cheddar':        0.50,
  'Supplément féta':           1.00,
  'Supplément sauce fromagère':0.50,
  'Supplément jalapeños':      0.50,
};

const SAUCES_FREE       = 2;
const SAUCE_EXTRA_PRICE = 0.30;
const TOLERANCE_EUROS   = 0.10; // tolérance arrondi flottant

interface CartItem {
  name:    string;
  price?:  number;   // prix client (non utilisé pour facturation)
  menu?:   boolean;  // +3.50€ supplément menu
  suppls?: string[]; // noms des suppléments payants
  sauces?: string[]; // sauces (>2 = 0.30€/sauce supplémentaire)
  isSuppl?: boolean; // ligne supplément interne
}

function calcServerTotal(items: CartItem[]): number {
  let total = 0;
  for (const item of items) {
    if (item.isSuppl) continue; // lignes internes ignorées
    const base = MENU_PRICES[item.name];
    if (base === undefined) {
      throw new Error(`Article inconnu : "${item.name}"`);
    }
    total += base;
    if (item.menu) total += MENU_PRICES['Supplément Menu'] ?? 3.50;
    for (const s of item.suppls ?? []) {
      const sp = SUPPLEMENT_PRICES[s];
      if (sp !== undefined) total += sp;
    }
    const extraSauces = Math.max(0, (item.sauces?.length ?? 0) - SAUCES_FREE);
    total += extraSauces * SAUCE_EXTRA_PRICE;
  }
  return Math.round(total * 100) / 100;
}

function getServiceFee(clientLevel: string): number {
  return (clientLevel === 'bronze' || !clientLevel) ? 0.50 : 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    if (!stripeKey) throw new Error('STRIPE_SECRET_KEY non configurée');

    const supaUrl  = Deno.env.get('SUPABASE_URL')!;
    const supaKey  = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY'))!;
    const stripe   = new Stripe(stripeKey, { apiVersion: '2024-04-10' });
    const supabase = createClient(supaUrl, supaKey);

    const {
      orderId,
      items,              // [{name, menu, suppls, sauces}] — calculé côté serveur
      clientLevel,        // 'bronze' | 'argent' | 'or'
      clientTel,
      orderLabel,
      successUrl,
      cancelUrl,
      // Données de commande pour pré-création Supabase
      orderType,          // 'sur_place' | 'reservation' | 'click_collect'
      heureRetrait,       // heure de retrait (string HH:MM)
      rewardId,           // ID récompense Supabase (nullable)
      rewardPts,          // points récompense (nullable)
      rewardNom,          // nom récompense (nullable)
      ptsACrediter,       // points à créditer au client après remise
      // amountCents envoyé par le client — utilisé uniquement pour vérification
      amountCents: clientAmountCents,
      // presence_token — requis pour orderType='sur_place'
      presence_token,
    } = await req.json();

    // ── Vérification presence_token pour les commandes sur place ─────────────
    if (orderType === 'sur_place') {
      if (!presence_token || typeof presence_token !== 'string') {
        console.warn('create-checkout: presence_token manquant pour sur_place');
        return new Response(
          JSON.stringify({ error: 'Code de présence requis pour commander sur place', code: 'TOKEN_REQUIS' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      const secret    = Deno.env.get('EMP_TOKEN_SECRET') ?? 'kbb-default-secret-change-me';
      const clientTelForToken = String(clientTel || '');
      const valid = await verifyPresenceToken(presence_token, secret, clientTelForToken);
      if (!valid) {
        console.warn(`create-checkout: presence_token invalide/expiré pour tel=${clientTelForToken}`);
        return new Response(
          JSON.stringify({ error: 'Code de présence invalide ou expiré — recommencez', code: 'TOKEN_INVALIDE' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      console.log(`create-checkout: presence_token OK pour tel=${clientTelForToken}`);
    }

    // ── Validation des articles ───────────────────────────────────
    if (!items || !Array.isArray(items) || items.length === 0) {
      throw new Error('Panier vide ou invalide');
    }

    const serverTotal       = calcServerTotal(items);
    const fee               = getServiceFee(clientLevel);
    const serverGrandTotal  = serverTotal + fee;
    const serverCents       = Math.round(serverGrandTotal * 100);

    // Vérification anti-fraude : le montant client doit correspondre (±tolérance)
    if (clientAmountCents !== undefined) {
      const diff = Math.abs(clientAmountCents - serverCents);
      if (diff > Math.round(TOLERANCE_EUROS * 100)) {
        console.warn(`Prix tampered: client=${clientAmountCents} server=${serverCents}`);
        throw new Error('Montant invalide — commande refusée');
      }
    }

    if (serverCents < 50) throw new Error('Montant minimum non atteint');

    // ── Vérification capacité créneau ─────────────────────────────
    // Uniquement pour click_collect et reservation avec une heure définie
    if (heureRetrait && (orderType === 'click_collect' || orderType === 'reservation')) {
      const supabase = createClient(supaUrl, supaKey);

      // Lire la capacité max configurée par le patron
      const { data: capRow } = await supabase
        .from('settings')
        .select('value')
        .eq('key', 'capacite_creneau')
        .maybeSingle();
      const capacite = Math.max(1, parseInt(String(capRow?.value ?? 5)) || 5);

      // Compter les commandes actives sur ce créneau aujourd'hui
      // Exclure les pending_payment de plus de 30 min (paiements abandonnés)
      const today = new Date().toISOString().slice(0, 10);
      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

      const { count } = await supabase
        .from('commandes')
        .select('id', { count: 'exact', head: true })
        .eq('heure_retrait', heureRetrait)
        .gte('created_at', today + 'T00:00:00.000Z')
        .lt('created_at', today + 'T23:59:59.999Z')
        .not('statut', 'in', '(annule,archive)')
        .or(`statut.neq.pending_payment,created_at.gte.${thirtyMinAgo}`);

      console.log(`create-checkout: créneau ${heureRetrait} — ${count}/${capacite} réservations`);

      if ((count ?? 0) >= capacite) {
        // Calculer le créneau suivant (+15 min)
        const [h, m] = heureRetrait.split(':').map(Number);
        const nextMin = h * 60 + m + 15;
        const nextSlot = `${String(Math.floor(nextMin / 60)).padStart(2, '0')}:${String(nextMin % 60).padStart(2, '0')}`;
        console.log(`create-checkout: créneau ${heureRetrait} COMPLET — suggestion ${nextSlot}`);
        return new Response(
          JSON.stringify({ error: 'CRENEAU_PLEIN', heure: heureRetrait, next_slot: nextSlot }),
          { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // ── Construire les line items Stripe ─────────────────────────
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
      {
        price_data: {
          currency: 'eur',
          product_data: {
            name: `Commande KBB à la braise — ${orderLabel || 'Commande'}`,
            description: orderId ? `Référence #KBB-${String(orderId).padStart(3, '0')}` : undefined,
          },
          unit_amount: Math.round(serverTotal * 100),
        },
        quantity: 1,
      },
    ];

    if (fee > 0) {
      lineItems.push({
        price_data: {
          currency: 'eur',
          product_data: {
            name: 'Frais de service',
            description: 'Offerts dès le niveau Argent',
          },
          unit_amount: Math.round(fee * 100),
        },
        quantity: 1,
      });
    }

    // ── Créer la session Stripe Checkout ─────────────────────────
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: successUrl,
      cancel_url:  cancelUrl,
      metadata: {
        client_tel:   clientTel || '',
        client_level: clientLevel || 'bronze',
        server_total: String(serverGrandTotal),
      },
      phone_number_collection: { enabled: false },
    });

    // ── Pré-créer la commande en "pending_payment" dans Supabase ─
    // La commande sera activée (→ en_attente) par verify-payment après vérification Stripe.
    // Sans cette vérification, la commande reste inactive et n'apparaît pas en cuisine.
    let supabaseOrderId: number | null = null;
    try {
      const orderPayload: Record<string, unknown> = {
        type:             orderType || 'sur_place',
        items:            JSON.stringify(items),
        montant:          serverGrandTotal,
        statut:           'pending_payment',
        created_at:       new Date().toISOString(),
        client_telephone: clientTel || null,
        heure_retrait:    heureRetrait || null,
        stripe_session_id: session.id,
        pts_a_crediter:   parseInt(String(ptsACrediter || 0)) || 0,
      };
      if (rewardNom) orderPayload.reward_nom = rewardNom;
      if (rewardPts) orderPayload.reward_pts = parseInt(String(rewardPts)) || 0;
      const rewardIdNum = parseInt(String(rewardId || 0));
      if (rewardId && !isNaN(rewardIdNum) && rewardIdNum > 0) orderPayload.reward_id = rewardIdNum;

      const { data, error: insertErr } = await supabase
        .from('commandes')
        .insert(orderPayload)
        .select('id')
        .single();

      if (insertErr) {
        console.error('create-checkout: pré-création commande échouée:', insertErr.message);
      } else if (data) {
        supabaseOrderId = data.id;
        console.log(`create-checkout: commande ${supabaseOrderId} pré-créée (pending_payment) — session ${session.id}`);
      }
    } catch (dbErr) {
      // Non bloquant : la session Stripe est créée, verify-payment signalera l'erreur
      console.error('create-checkout: erreur DB:', (dbErr as Error).message);
    }

    return new Response(
      JSON.stringify({ url: session.url, sessionId: session.id, supabaseOrderId, serverTotal: serverGrandTotal }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('create-checkout error:', err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
