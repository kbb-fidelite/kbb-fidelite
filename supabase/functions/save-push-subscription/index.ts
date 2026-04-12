// Supabase Edge Function — save-push-subscription
//
// Stocke ou supprime l'abonnement Web Push d'un client dans la colonne
// clients.push_subscription (JSONB). Écriture via service_role uniquement.
//
// Modes :
//   POST { client_tel, subscription }  → stocke l'abonnement
//   POST { client_tel, subscription: null } → supprime l'abonnement (désabonnement)
//
// Validation :
//   - client_tel doit correspondre à un client existant
//   - subscription doit contenir endpoint + keys.auth + keys.p256dh
//   - Aucune valeur fournie par le client n'est utilisée pour l'autorisation
//
// Secrets requis : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injectés)
// Déploiement : supabase functions deploy save-push-subscription

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

function isValidSubscription(sub: unknown): boolean {
  if (!sub || typeof sub !== 'object') return false;
  const s = sub as Record<string, unknown>;
  if (typeof s.endpoint !== 'string' || !s.endpoint.startsWith('https://')) return false;
  if (!s.keys || typeof s.keys !== 'object') return false;
  const keys = s.keys as Record<string, unknown>;
  if (typeof keys.auth !== 'string' || typeof keys.p256dh !== 'string') return false;
  return true;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { client_tel, subscription } = await req.json();

    if (!client_tel || typeof client_tel !== 'string' || !client_tel.trim()) {
      return json({ error: 'client_tel requis' }, 400);
    }

    // subscription = null → désabonnement volontaire
    // subscription = objet → abonnement à valider
    if (subscription !== null && subscription !== undefined) {
      if (!isValidSubscription(subscription)) {
        return json({ error: 'subscription invalide (endpoint + keys.auth + keys.p256dh requis)' }, 400);
      }
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY'))!
    );

    const tel = client_tel.trim();

    // ── 1. Vérifier que le client existe (ne pas créer d'abonnement fantôme) ──
    const { data: rows, error: findErr } = await supabase
      .from('clients')
      .select('id, telephone')
      .eq('telephone', tel)
      .limit(1);

    if (findErr) {
      console.error('save-push-subscription: SELECT client:', findErr.message);
      return json({ error: 'Erreur base de données' }, 500);
    }
    if (!rows || rows.length === 0) {
      return json({ error: 'Client introuvable' }, 404);
    }

    const clientId = rows[0].id;

    // ── 2. Stocker ou supprimer l'abonnement ─────────────────────────────────
    const { error: updateErr } = await supabase
      .from('clients')
      .update({ push_subscription: subscription ?? null })
      .eq('id', clientId);

    if (updateErr) {
      console.error('save-push-subscription: UPDATE:', updateErr.message);
      return json({ error: 'Erreur sauvegarde abonnement' }, 500);
    }

    const action = subscription ? 'enregistré' : 'supprimé';
    console.log(`save-push-subscription: abonnement ${action} pour tel=${tel.slice(-4)}`);

    return json({ ok: true, action });

  } catch (err) {
    console.error('save-push-subscription error:', err);
    return json({ error: (err as Error).message }, 500);
  }
});
