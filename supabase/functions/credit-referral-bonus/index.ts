// Supabase Edge Function — credit-referral-bonus
//
// Crédite les points de parrainage "reportés" au parrain, 100% côté serveur.
// Le client envoie uniquement son numéro de téléphone — aucun montant n'est
// accepté en entrée. La fonction décide elle-même du montant à créditer en
// lisant les enregistrements `parrainages` dans la base.
//
// Conditions vérifiées côté serveur :
//   - status = 'reporte'
//   - pts_filleul_verse = true  (le filleul a bien passé sa 1ère commande)
//   - pts_parrain_verse = false (le parrain n'a pas encore été crédité)
//   - mois != mois courant      (le report était pour un mois précédent)
//
// Secrets requis : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injectés)
// Déploiement : supabase functions deploy credit-referral-bonus

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${now.getMonth() + 1}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { client_tel } = await req.json();

    if (!client_tel || typeof client_tel !== 'string' || !client_tel.trim()) {
      return json({ error: 'client_tel requis' }, 400);
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY'))!
    );

    const tel = client_tel.trim();

    // ── 1. Charger le client par téléphone ───────────────────────────────────
    const { data: clientRows, error: clientErr } = await supabase
      .from('clients')
      .select('id, telephone, cagnotte, points_cumul, prenom')
      .eq('telephone', tel)
      .limit(1);

    if (clientErr) {
      console.error('credit-referral-bonus: lecture client:', clientErr.message);
      return json({ error: 'Erreur base de données' }, 500);
    }
    const client = clientRows?.[0];
    if (!client) return json({ error: 'Client introuvable' }, 404);

    // ── 2. Chercher les parrainages reportés éligibles ───────────────────────
    // Les conditions sont vérifiées côté serveur — aucune valeur client acceptée.
    const moisCourant = getCurrentMonth();

    const { data: parrainages, error: parrErr } = await supabase
      .from('parrainages')
      .select('id, pts_parrain, mois')
      .eq('parrain_id', String(client.id))
      .eq('status', 'reporte')
      .eq('pts_filleul_verse', true)
      .eq('pts_parrain_verse', false)
      .neq('mois', moisCourant);

    if (parrErr) {
      console.error('credit-referral-bonus: lecture parrainages:', parrErr.message);
      return json({ error: 'Erreur lecture parrainages' }, 500);
    }

    // Rien à créditer — réponse OK sans modification
    if (!parrainages || parrainages.length === 0) {
      return json({ ok: true, pts_credites: 0, nb_parrainages: 0 });
    }

    // ── 3. Calculer le total — valeurs issues de la DB, jamais du client ─────
    const totalPts = parrainages.reduce((sum, r) => sum + (r.pts_parrain ?? 15), 0);
    const ids = parrainages.map(r => r.id);

    // ── 4. Marquer les parrainages comme traités (atomique avant le crédit) ──
    const { error: updateParrErr } = await supabase
      .from('parrainages')
      .update({ status: 'valide', pts_parrain_verse: true })
      .in('id', ids);

    if (updateParrErr) {
      console.error('credit-referral-bonus: update parrainages:', updateParrErr.message);
      return json({ error: 'Erreur mise à jour parrainages' }, 500);
    }

    // ── 5. Créditer le parrain (lecture → calcul → écriture côté serveur) ────
    const ancienSolde = Math.round(parseFloat(String(client.cagnotte ?? 0)) * 100) / 100;
    const nouveauSolde = Math.round((ancienSolde + totalPts) * 100) / 100;

    const ancienCumul = Math.round(parseFloat(String(client.points_cumul ?? client.cagnotte ?? 0)) * 100) / 100;
    const nouveauCumul = Math.round((ancienCumul + totalPts) * 100) / 100;

    const { error: updateClientErr } = await supabase
      .from('clients')
      .update({ cagnotte: nouveauSolde, points_cumul: nouveauCumul })
      .eq('id', client.id);

    if (updateClientErr) {
      console.error('credit-referral-bonus: update client:', updateClientErr.message);
      // Rollback : remettre les parrainages en état "reporte"
      await supabase
        .from('parrainages')
        .update({ status: 'reporte', pts_parrain_verse: false })
        .in('id', ids)
        .catch(e => console.error('credit-referral-bonus: rollback échoué:', e.message));
      return json({ error: 'Erreur crédit points' }, 500);
    }

    console.log(
      `credit-referral-bonus: OK — +${totalPts} pts → ${tel}` +
      ` (${parrainages.length} parrainage${parrainages.length > 1 ? 's' : ''})` +
      ` solde: ${ancienSolde} → ${nouveauSolde}`
    );

    return json({
      ok: true,
      pts_credites: totalPts,
      nb_parrainages: parrainages.length,
      nouveau_solde: nouveauSolde,
    });

  } catch (err) {
    console.error('credit-referral-bonus error:', err);
    return json({ error: (err as Error).message }, 500);
  }
});
