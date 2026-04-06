// Supabase Edge Function — validate-reward
// Valide et déduit les points d'une récompense fidélité après paiement confirmé.
//
// Appelée côté serveur uniquement, jamais exposée au client directement.
// Secrets requis : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injectés)
//
// Déploiement : supabase functions deploy validate-reward

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supaUrl  = Deno.env.get('SUPABASE_URL')!;
    const supaKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supaUrl, supaKey);

    const { commande_id, client_id, reward_id } = await req.json();

    if (!commande_id || !client_id || !reward_id) {
      return new Response(
        JSON.stringify({ error: 'Paramètres manquants: commande_id, client_id, reward_id requis' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── 1. Charger la récompense ──────────────────────────────────
    const { data: recompense, error: rErr } = await supabase
      .from('recompenses')
      .select('*')
      .eq('id', reward_id)
      .eq('actif', true)
      .single();

    if (rErr || !recompense) {
      return new Response(
        JSON.stringify({ error: 'Récompense introuvable ou désactivée' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── 2. Charger la commande ────────────────────────────────────
    const { data: commande, error: cErr } = await supabase
      .from('commandes')
      .select('*')
      .eq('id', commande_id)
      .single();

    if (cErr || !commande) {
      return new Response(
        JSON.stringify({ error: 'Commande introuvable' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Vérifier que la récompense n'a pas déjà été validée
    if (commande.reward_valide) {
      return new Response(
        JSON.stringify({ ok: true, note: 'already_validated' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── 3. Vérifier le montant minimum de commande ────────────────
    const montant = parseFloat(commande.montant || 0);
    if (montant < parseFloat(recompense.commande_minimum)) {
      return new Response(
        JSON.stringify({
          error: `Montant insuffisant: ${montant}€ < ${recompense.commande_minimum}€ requis`
        }),
        { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── 4. Charger le client et vérifier les points ───────────────
    const { data: client, error: clErr } = await supabase
      .from('clients')
      .select('id, cagnotte, prenom')
      .eq('id', client_id)
      .single();

    if (clErr || !client) {
      return new Response(
        JSON.stringify({ error: 'Client introuvable' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const cagnotte = Math.floor(parseFloat(client.cagnotte || 0));
    if (cagnotte < recompense.points_requis) {
      return new Response(
        JSON.stringify({
          error: `Points insuffisants: ${cagnotte} pts < ${recompense.points_requis} pts requis`
        }),
        { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── 5. Déduire les points (opération atomique) ────────────────
    const newCagnotte = Math.max(0, cagnotte - recompense.points_requis);

    const { error: updateClientErr } = await supabase
      .from('clients')
      .update({ cagnotte: newCagnotte })
      .eq('id', client_id)
      .eq('cagnotte', cagnotte); // optimistic lock: évite double déduction

    if (updateClientErr) {
      return new Response(
        JSON.stringify({ error: 'Erreur mise à jour points: ' + updateClientErr.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── 6. Marquer la commande comme récompense validée ───────────
    await supabase
      .from('commandes')
      .update({ reward_valide: true, reward_id, reward_pts: recompense.points_requis })
      .eq('id', commande_id);

    console.log(
      `Récompense validée: ${recompense.nom} — client ${client.prenom} (id ${client_id})` +
      ` — ${recompense.points_requis} pts déduits — solde: ${newCagnotte} pts`
    );

    return new Response(
      JSON.stringify({
        ok: true,
        reward_nom: recompense.nom,
        pts_deduits: recompense.points_requis,
        nouveau_solde: newCagnotte
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('validate-reward error:', err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
