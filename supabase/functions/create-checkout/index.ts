// Supabase Edge Function — create-checkout (avec validation des prix côté serveur)
// Les prix sont recalculés CÔTÉ SERVEUR — le client n'envoie que les articles (noms + options)
// Secrets requis : STRIPE_SECRET_KEY
//
// Déploiement : supabase functions deploy create-checkout

import Stripe from 'https://esm.sh/stripe@14?target=deno';

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

    const stripe = new Stripe(stripeKey, { apiVersion: '2024-04-10' });

    const {
      orderId,
      items,          // [{name, menu, suppls, sauces}] — calculé côté serveur
      clientLevel,    // 'bronze' | 'argent' | 'or'
      clientTel,
      orderLabel,
      successUrl,
      cancelUrl,
      // amountCents envoyé par le client — utilisé uniquement pour vérification
      amountCents: clientAmountCents,
    } = await req.json();

    // ── Validation des articles ───────────────────────────────────
    if (!items || !Array.isArray(items) || items.length === 0) {
      throw new Error('Panier vide ou invalide');
    }

    const serverTotal    = calcServerTotal(items);
    const fee            = getServiceFee(clientLevel);
    const serverGrandTotal = serverTotal + fee;
    const serverCents    = Math.round(serverGrandTotal * 100);

    // Vérification anti-fraude : le montant client doit correspondre (±tolérance)
    if (clientAmountCents !== undefined) {
      const diff = Math.abs(clientAmountCents - serverCents);
      if (diff > Math.round(TOLERANCE_EUROS * 100)) {
        console.warn(`Prix tampered: client=${clientAmountCents} server=${serverCents}`);
        throw new Error('Montant invalide — commande refusée');
      }
    }

    if (serverCents < 50) throw new Error('Montant minimum non atteint');

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

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: successUrl,
      cancel_url:  cancelUrl,
      metadata: {
        order_id:     orderId ? String(orderId) : 'local',
        client_tel:   clientTel || '',
        client_level: clientLevel || 'bronze',
        server_total: String(serverGrandTotal),
      },
      phone_number_collection: { enabled: false },
    });

    return new Response(
      JSON.stringify({ url: session.url, sessionId: session.id, serverTotal: serverGrandTotal }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('create-checkout error:', err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
