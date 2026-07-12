// Supabase Edge Function — validate-reward
// Valide et déduit les points d'une récompense fidélité après paiement confirmé.
//
// Sécurité : exige session_token + client_tel pour vérifier l'identité du client.
// Secrets requis : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injectés)
//
// Déploiement : supabase functions deploy validate-reward

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supaUrl  = Deno.env.get('SUPABASE_URL')!;
    const supaKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supaUrl, supaKey);

    const { commande_id, client_id, reward_id, session_token, client_tel } = await req.json();

    if (!commande_id || !client_id || !reward_id) {
      return jsonResp({ error: 'Paramètres manquants: commande_id, client_id, reward_id requis' }, 400);
    }

    // ── 0. Vérification session_token ────────────────────────────
    if (!session_token || !client_tel) {
      return jsonResp({ error: 'Authentification requise (session_token + client_tel)' }, 401);
    }

    const { data: authRow, error: authErr } = await supabase
      .from('clients')
      .select('id, session_token')
      .eq('telephone', client_tel)
      .single();

    if (authErr || !authRow) {
      return jsonResp({ error: 'Client introuvable' }, 404);
    }

    if (!authRow.session_token || authRow.session_token !== session_token) {
      console.warn('[validate-reward] session_token invalide tel=…' + String(client_tel).slice(-4));
      return jsonResp({ error: 'Session invalide — reconnectez-vous' }, 401);
    }

    // Vérifier que le client_id correspond bien au téléphone authentifié
    if (String(authRow.id) !== String(client_id)) {
      console.warn('[validate-reward] client_id mismatch: auth=' + authRow.id + ' req=' + client_id);
      return jsonResp({ error: 'Accès refusé' }, 403);
    }

    // ── 1. Charger la récompense ──────────────────────────────────
    const { data: recompense, error: rErr } = await supabase
      .from('recompenses')
      .select('*')
      .eq('id', reward_id)
      .eq('actif', true)
      .single();

    if (rErr || !recompense) {
      return jsonResp({ error: 'Récompense introuvable ou désactivée' }, 404);
    }

    // ── 2. Charger la commande ────────────────────────────────────
    const { data: commande, error: cErr } = await supabase
      .from('commandes')
      .select('*')
      .eq('id', commande_id)
      .single();

    if (cErr || !commande) {
      return jsonResp({ error: 'Commande introuvable' }, 404);
    }

    // Vérifier que la récompense n'a pas déjà été validée
    if (commande.reward_valide) {
      return jsonResp({ ok: true, note: 'already_validated' });
    }

    // ── 3. Vérifier le montant minimum de commande ────────────────
    const montant = parseFloat(commande.montant || 0);
    if (montant < parseFloat(recompense.commande_minimum)) {
      return jsonResp({
        error: `Montant insuffisant: ${montant}€ < ${recompense.commande_minimum}€ requis`
      }, 422);
    }

    // ── 4. Charger le client et vérifier les points ───────────────
    const { data: client, error: clErr } = await supabase
      .from('clients')
      .select('id, cagnotte, prenom')
      .eq('id', client_id)
      .single();

    if (clErr || !client) {
      return jsonResp({ error: 'Client introuvable' }, 404);
    }

    const cagnotte = Math.floor(parseFloat(client.cagnotte || 0));
    if (cagnotte < recompense.points_requis) {
      return jsonResp({
        error: `Points insuffisants: ${cagnotte} pts < ${recompense.points_requis} pts requis`
      }, 422);
    }

    // ── 5. Déduire les points (opération atomique) ────────────────
    const newCagnotte = Math.max(0, cagnotte - recompense.points_requis);

    const { error: updateClientErr } = await supabase
      .from('clients')
      .update({ cagnotte: newCagnotte })
      .eq('id', client_id)
      .eq('cagnotte', cagnotte); // optimistic lock: évite double déduction

    if (updateClientErr) {
      return jsonResp({ error: 'Erreur mise à jour points: ' + updateClientErr.message }, 500);
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

    return jsonResp({
      ok: true,
      reward_nom: recompense.nom,
      pts_deduits: recompense.points_requis,
      nouveau_solde: newCagnotte
    });

  } catch (err) {
    console.error('validate-reward error:', err);
    return jsonResp({ error: (err as Error).message }, 500);
  }
});
