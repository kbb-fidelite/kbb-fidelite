// Supabase Edge Function — Stripe Checkout Session
// Déployement : supabase functions deploy create-checkout
// Secret requis : supabase secrets set STRIPE_SECRET_KEY=sk_live_...
//
// ⚠️  Ne jamais mettre la clé secrète Stripe dans ce fichier ni dans index.html

import Stripe from 'https://esm.sh/stripe@14?target=deno';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  // Preflight CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    if (!stripeKey) throw new Error('STRIPE_SECRET_KEY non configurée');

    const stripe = new Stripe(stripeKey, { apiVersion: '2024-04-10' });

    const {
      orderId,       // ID Supabase de la commande (ou null si locale)
      amountCents,   // Montant total en centimes (ex: 1050 = 10,50€)
      feeCents,      // Frais de service en centimes (50 = 0,50€ pour Bronze, 0 sinon)
      clientLevel,   // 'bronze' | 'argent' | 'or'
      clientTel,     // Téléphone du client (pour metadata)
      orderLabel,    // Ex: "Sur place" ou "Retrait à 13:30"
      successUrl,    // URL de retour après paiement réussi
      cancelUrl,     // URL de retour en cas d'abandon
    } = await req.json();

    if (!amountCents || amountCents < 50) {
      throw new Error('Montant invalide');
    }

    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
      {
        price_data: {
          currency: 'eur',
          product_data: {
            name: `Commande KBB à la braise — ${orderLabel || 'Commande'}`,
            description: orderId ? `Référence #KBB-${String(orderId).padStart(3, '0')}` : undefined,
          },
          unit_amount: amountCents,
        },
        quantity: 1,
      },
    ];

    // Frais de service Bronze (0,50€)
    if (feeCents > 0) {
      lineItems.push({
        price_data: {
          currency: 'eur',
          product_data: {
            name: 'Frais de service',
            description: 'Offerts dès le niveau Argent',
          },
          unit_amount: feeCents,
        },
        quantity: 1,
      });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        order_id: orderId ? String(orderId) : 'local',
        client_tel: clientTel || '',
        client_level: clientLevel || 'bronze',
      },
      // Pré-remplir l'email si disponible dans les métadonnées Stripe
      phone_number_collection: { enabled: false },
    });

    return new Response(
      JSON.stringify({ url: session.url, sessionId: session.id }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('create-checkout error:', err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
