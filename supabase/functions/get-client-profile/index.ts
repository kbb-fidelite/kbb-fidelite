// Supabase Edge Function — get-client-profile
//
// Point d'accès sécurisé pour les clients du portail fidélité.
// Remplace tous les supaReq() directs du portail client (clients, commandes, factures).
//
// Actions (client_tel requis pour toutes) :
//   (défaut)          — retourne le profil client par téléphone
//   commandes         — retourne les commandes du client (client_telephone = tel)
//   commandes_ids     — retourne les IDs de commandes du client (pour join factures)
//   factures          — retourne toutes les factures du client (server-side join)
//   commande_status   — retourne le statut d'une commande si client_telephone = tel
//   facture_by_commande — retourne la facture d'une commande si client_telephone = tel
//
// Sécurité :
//   - client_tel requis → server vérifie ownership avant chaque requête
//   - Jamais de données d'autres clients
//   - Téléphone jamais loggué en clair
//
// Secrets requis : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const body = await req.json();
    const { client_tel, action, commande_id, limit: reqLimit } = body;

    if (!client_tel || typeof client_tel !== 'string' || !client_tel.trim()) {
      return json({ error: 'client_tel requis' }, 400);
    }

    const tel = client_tel.trim();
    const telMasked = '…' + tel.slice(-4);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY'))!
    );

    // ── Profil client (action par défaut) ────────────────────────────────
    if (!action) {
      const { data, error } = await supabase
        .from('clients')
        .select('*')
        .eq('telephone', tel)
        .limit(1);

      if (error) {
        console.error('[get-client-profile] SELECT client:', error.message);
        return json({ error: 'Erreur base de données' }, 500);
      }
      const client = (data ?? [])[0] ?? null;
      // Statut calculé côté serveur sur points_cumul (jamais décrémenté)
      if (client) {
        const cumul = Math.floor(parseFloat(String(client.points_cumul ?? 0)));
        client.statut = cumul >= 500 ? 'or' : cumul >= 200 ? 'argent' : 'bronze';
      }
      console.log(`[get-client-profile] tel=${telMasked} id=${client?.id ?? 'null'} statut=${client?.statut ?? '-'}`);
      return json({ client });
    }

    // ── Commandes du client ───────────────────────────────────────────────
    if (action === 'commandes') {
      const lim = Math.min(parseInt(String(reqLimit ?? 60)) || 60, 100);
      const { data, error } = await supabase
        .from('commandes')
        .select('*')
        .eq('client_telephone', tel)
        .order('created_at', { ascending: false })
        .limit(lim);
      if (error) return json({ error: error.message }, 500);
      return json({ commandes: data ?? [] });
    }

    // ── IDs de commandes (pour join factures côté client) ─────────────────
    if (action === 'commandes_ids') {
      const lim = Math.min(parseInt(String(reqLimit ?? 60)) || 60, 100);
      const { data, error } = await supabase
        .from('commandes')
        .select('id')
        .eq('client_telephone', tel)
        .order('created_at', { ascending: false })
        .limit(lim);
      if (error) return json({ error: error.message }, 500);
      return json({ ids: (data ?? []).map((r: { id: unknown }) => String(r.id)) });
    }

    // ── Toutes les factures du client (server-side join) ──────────────────
    if (action === 'factures') {
      // 1. Récupérer les IDs de commandes du client
      const { data: cmdRows, error: cmdErr } = await supabase
        .from('commandes')
        .select('id')
        .eq('client_telephone', tel)
        .order('created_at', { ascending: false })
        .limit(100);
      if (cmdErr) return json({ error: cmdErr.message }, 500);
      const ids = (cmdRows ?? []).map((r: { id: unknown }) => String(r.id));
      if (!ids.length) return json({ factures: [] });
      // 2. Récupérer les factures pour ces commandes
      const { data: facRows, error: facErr } = await supabase
        .from('factures')
        .select('*')
        .in('commande_id', ids)
        .order('date', { ascending: false });
      if (facErr) return json({ error: facErr.message }, 500);
      return json({ factures: facRows ?? [] });
    }

    // ── Factures pour une liste de commandes + commandes du client ─────────
    // (pour loadCommandesHistory qui charge commandes ET leurs factures)
    if (action === 'commandes_avec_factures') {
      const lim = Math.min(parseInt(String(reqLimit ?? 60)) || 60, 100);
      const { data: cmdRows, error: cmdErr } = await supabase
        .from('commandes')
        .select('*')
        .eq('client_telephone', tel)
        .order('created_at', { ascending: false })
        .limit(lim);
      if (cmdErr) return json({ error: cmdErr.message }, 500);
      const commandes = cmdRows ?? [];
      const ids = commandes.map((r: { id: unknown }) => String(r.id)).filter(Boolean);
      let factures: unknown[] = [];
      if (ids.length) {
        const { data: facRows } = await supabase
          .from('factures')
          .select('*')
          .in('commande_id', ids);
        factures = facRows ?? [];
      }
      return json({ commandes, factures });
    }

    // ── Statut d'une commande (polling suivi) — vérifie ownership ─────────
    if (action === 'commande_status') {
      if (!commande_id) return json({ error: 'commande_id requis' }, 400);
      const { data, error } = await supabase
        .from('commandes')
        .select('id, statut, stripe_session_id')
        .eq('id', String(commande_id))
        .eq('client_telephone', tel) // ownership obligatoire
        .limit(1);
      if (error) return json({ error: error.message }, 500);
      const row = (data ?? [])[0] ?? null;
      return json({ commande: row });
    }

    // ── Facture par commande — vérifie ownership ──────────────────────────
    if (action === 'facture_by_commande') {
      if (!commande_id) return json({ error: 'commande_id requis' }, 400);
      // Vérifier ownership
      const { data: cmdRows } = await supabase
        .from('commandes')
        .select('id')
        .eq('id', String(commande_id))
        .eq('client_telephone', tel)
        .limit(1);
      if (!cmdRows || !cmdRows.length) return json({ facture: null }); // pas propriétaire
      const { data: facRows, error } = await supabase
        .from('factures')
        .select('*')
        .eq('commande_id', String(commande_id))
        .limit(1);
      if (error) return json({ error: error.message }, 500);
      return json({ facture: (facRows ?? [])[0] ?? null });
    }

    return json({ error: `action inconnue: ${action}` }, 400);

  } catch (err) {
    console.error('[get-client-profile] erreur fatale:', (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});
