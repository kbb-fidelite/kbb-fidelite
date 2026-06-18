// Supabase Edge Function — manage-adresses
//
// Gère les adresses de livraison sauvegardées d'un client.
//
// Actions :
//   list    — liste les adresses du client
//   save    — sauvegarde une nouvelle adresse (max 3)
//   delete  — supprime une adresse par ID
//   replace — remplace une adresse existante par une nouvelle
//
// Sécurité :
//   - client_tel vérifié contre la table clients (lookup par téléphone)
//   - client_id obtenu du lookup — jamais fourni par le client
//   - Toutes les opérations filtrées par client_id (service_role)
//   - Téléphone jamais loggué en clair (4 derniers chiffres seulement)
//
// Secrets requis : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Déploiement : supabase functions deploy manage-adresses

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

const MAX_ADRESSES = 3;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY'))!
    );

    const body = await req.json();
    const { action, client_tel } = body;

    if (!client_tel || typeof client_tel !== 'string' || !client_tel.trim()) {
      return json({ error: 'client_tel requis' }, 400);
    }
    if (!action) return json({ error: 'action requise' }, 400);

    const tel = client_tel.trim();
    const telMasked = '…' + tel.slice(-4);

    // ── 1. Vérifier l'existence du client (jamais confiance à un client_id fourni) ──
    const { data: clientRows, error: clientErr } = await supabase
      .from('clients')
      .select('id')
      .eq('telephone', tel)
      .limit(1);

    if (clientErr) {
      console.error('[manage-adresses] SELECT client:', clientErr.message);
      return json({ error: 'Erreur base de données' }, 500);
    }
    if (!clientRows || clientRows.length === 0) {
      return json({ error: 'Client introuvable' }, 404);
    }

    const clientId: number = clientRows[0].id;

    // ── 2. Dispatch par action ─────────────────────────────────────────────

    // LIST
    if (action === 'list') {
      const { data, error } = await supabase
        .from('adresses_client')
        .select('id, label, adresse, rue, code_postal, ville, instructions, telephone, created_at')
        .eq('client_id', clientId)
        .order('created_at', { ascending: true });

      if (error) {
        console.error('[manage-adresses] list:', error.message);
        return json({ error: 'Erreur base de données' }, 500);
      }
      console.log(`[manage-adresses] list tel=${telMasked} → ${data?.length ?? 0} adresses`);
      return json({ adresses: data ?? [] });
    }

    // SAVE
    if (action === 'save') {
      const { label, adresse, rue, code_postal, ville, instructions, telephone } = body;

      if (!adresse || typeof adresse !== 'string' || !adresse.trim()) {
        return json({ error: 'adresse requise' }, 400);
      }

      // Vérifier la limite de 3 adresses
      const { count, error: countErr } = await supabase
        .from('adresses_client')
        .select('id', { count: 'exact', head: true })
        .eq('client_id', clientId);

      if (countErr) return json({ error: 'Erreur base de données' }, 500);

      if ((count ?? 0) >= MAX_ADRESSES) {
        // Retourner les adresses existantes pour proposer un remplacement
        const { data: existing } = await supabase
          .from('adresses_client')
          .select('id, label, adresse')
          .eq('client_id', clientId)
          .order('created_at', { ascending: true });
        return json({ error: 'MAX_REACHED', existing: existing ?? [] }, 409);
      }

      const { data: newAddr, error: insertErr } = await supabase
        .from('adresses_client')
        .insert({
          client_id:    clientId,
          label:        label ?? null,
          adresse:      adresse.trim(),
          rue:          rue ?? null,
          code_postal:  code_postal ?? null,
          ville:        ville ?? null,
          instructions: instructions ?? null,
          telephone:    telephone ?? null,
        })
        .select('id, label, adresse, rue, code_postal, ville, instructions, telephone, created_at')
        .maybeSingle();

      if (insertErr) {
        console.error('[manage-adresses] save:', insertErr.message);
        return json({ error: 'Erreur base de données' }, 500);
      }
      console.log(`[manage-adresses] save tel=${telMasked} | label="${label}" → id=${newAddr?.id}`);
      return json({ ok: true, adresse: newAddr });
    }

    // DELETE
    if (action === 'delete') {
      const { id } = body;
      if (!id) return json({ error: 'id requis' }, 400);

      const { error: delErr } = await supabase
        .from('adresses_client')
        .delete()
        .eq('id', id)
        .eq('client_id', clientId); // sécurité : ownership obligatoire

      if (delErr) {
        console.error('[manage-adresses] delete:', delErr.message);
        return json({ error: 'Erreur base de données' }, 500);
      }
      console.log(`[manage-adresses] delete tel=${telMasked} | id=${id}`);
      return json({ ok: true });
    }

    // REPLACE
    if (action === 'replace') {
      const { replaceId, label, adresse, rue, code_postal, ville, instructions, telephone } = body;

      if (!replaceId) return json({ error: 'replaceId requis' }, 400);
      if (!adresse || typeof adresse !== 'string' || !adresse.trim()) {
        return json({ error: 'adresse requise' }, 400);
      }

      // Supprimer l'ancienne (filtrée par client_id)
      await supabase
        .from('adresses_client')
        .delete()
        .eq('id', replaceId)
        .eq('client_id', clientId);

      // Insérer la nouvelle
      const { data: newAddr, error: insertErr } = await supabase
        .from('adresses_client')
        .insert({
          client_id:    clientId,
          label:        label ?? null,
          adresse:      adresse.trim(),
          rue:          rue ?? null,
          code_postal:  code_postal ?? null,
          ville:        ville ?? null,
          instructions: instructions ?? null,
          telephone:    telephone ?? null,
        })
        .select('id, label, adresse, rue, code_postal, ville, instructions, telephone, created_at')
        .maybeSingle();

      if (insertErr) {
        console.error('[manage-adresses] replace:', insertErr.message);
        return json({ error: 'Erreur base de données' }, 500);
      }
      console.log(`[manage-adresses] replace tel=${telMasked} | replaceId=${replaceId} → id=${newAddr?.id}`);
      return json({ ok: true, adresse: newAddr });
    }

    return json({ error: `action inconnue: ${action}` }, 400);

  } catch (err) {
    console.error('[manage-adresses] erreur fatale:', (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});
