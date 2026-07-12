// Supabase Edge Function — get-client-profile
//
// Point d'accès sécurisé pour les clients du portail fidélité.
//
// Actions (client_tel + session_token requis pour toutes sauf login) :
//   login             — retourne le profil par tel+code_secret, génère session_token
//   (défaut)          — retourne le profil client par téléphone (session_token requis)
//   commandes         — retourne les commandes du client
//   commandes_ids     — retourne les IDs de commandes du client
//   factures          — retourne toutes les factures du client (server-side join)
//   commande_status   — retourne le statut d'une commande si ownership vérifié
//   facture_by_commande — retourne la facture d'une commande si ownership vérifié
//   commandes_avec_factures — commandes + factures en un appel
//
// Sécurité :
//   - session_token vérifié côté serveur pour chaque requête (sauf login)
//   - code_secret JAMAIS retourné dans les réponses profil
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

// Retire code_secret de l'objet client avant de le retourner
function sanitizeClient(client: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!client) return null;
  const { code_secret: _, ...safe } = client;
  return safe;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const body = await req.json();
    const { client_tel, session_token, action, commande_id, limit: reqLimit, code_secret } = body;

    if (!client_tel || typeof client_tel !== 'string' || !client_tel.trim()) {
      return json({ error: 'client_tel requis' }, 400);
    }

    const tel = client_tel.trim();
    const telMasked = '…' + tel.slice(-4);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY'))!
    );

    // ── Action LOGIN — authentifie par code_secret, génère session_token ──
    if (action === 'login') {
      const { data: rows, error } = await supabase
        .from('clients')
        .select('*')
        .eq('telephone', tel)
        .limit(1);

      if (error) {
        console.error('[get-client-profile] login SELECT:', error.message);
        return json({ error: 'Erreur base de données' }, 500);
      }
      const client = (rows ?? [])[0] ?? null;
      if (!client) {
        return json({ error: 'Client introuvable' }, 404);
      }

      // Vérifier code_secret si le client en a un
      const storedCode = client.code_secret || '';
      if (storedCode && storedCode !== (code_secret || '')) {
        console.warn(`[get-client-profile] login code_secret invalide tel=${telMasked}`);
        return json({ error: 'Code secret incorrect' }, 401);
      }

      // Générer un nouveau session_token
      const newToken = crypto.randomUUID();
      const { error: updateErr } = await supabase
        .from('clients')
        .update({ session_token: newToken })
        .eq('id', client.id);

      if (updateErr) {
        console.error('[get-client-profile] login update session_token:', updateErr.message);
        return json({ error: 'Erreur base de données' }, 500);
      }

      // Calculer statut
      const cumul = Math.floor(parseFloat(String(client.points_cumul ?? 0)));
      client.statut = cumul >= 500 ? 'or' : cumul >= 200 ? 'argent' : 'bronze';
      client.session_token = newToken;

      console.log(`[get-client-profile] login OK tel=${telMasked} id=${client.id}`);
      return json({ client: sanitizeClient(client) });
    }

    // ── Toutes les autres actions requièrent session_token ─────────────
    if (!session_token || typeof session_token !== 'string') {
      return json({ error: 'Session invalide — reconnectez-vous' }, 401);
    }

    // Vérifier session_token en base
    const { data: authRows, error: authErr } = await supabase
      .from('clients')
      .select('id, session_token')
      .eq('telephone', tel)
      .limit(1);

    if (authErr || !authRows || !authRows.length) {
      return json({ error: 'Client introuvable' }, 404);
    }

    const authClient = authRows[0];
    if (!authClient.session_token || authClient.session_token !== session_token) {
      console.warn(`[get-client-profile] session_token invalide tel=${telMasked}`);
      return json({ error: 'Session invalide — reconnectez-vous' }, 401);
    }

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
      if (client) {
        const cumul = Math.floor(parseFloat(String(client.points_cumul ?? 0)));
        client.statut = cumul >= 500 ? 'or' : cumul >= 200 ? 'argent' : 'bronze';
      }
      console.log(`[get-client-profile] tel=${telMasked} id=${client?.id ?? 'null'} statut=${client?.statut ?? '-'}`);
      return json({ client: sanitizeClient(client) });
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
      const { data: cmdRows, error: cmdErr } = await supabase
        .from('commandes')
        .select('id')
        .eq('client_telephone', tel)
        .order('created_at', { ascending: false })
        .limit(100);
      if (cmdErr) return json({ error: cmdErr.message }, 500);
      const ids = (cmdRows ?? []).map((r: { id: unknown }) => String(r.id));
      if (!ids.length) return json({ factures: [] });
      const { data: facRows, error: facErr } = await supabase
        .from('factures')
        .select('*')
        .in('commande_id', ids)
        .order('date', { ascending: false });
      if (facErr) return json({ error: facErr.message }, 500);
      return json({ factures: facRows ?? [] });
    }

    // ── Commandes + factures en un appel ──────────────────────────────────
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
        .eq('client_telephone', tel)
        .limit(1);
      if (error) return json({ error: error.message }, 500);
      const row = (data ?? [])[0] ?? null;
      return json({ commande: row });
    }

    // ── Facture par commande — vérifie ownership ──────────────────────────
    if (action === 'facture_by_commande') {
      if (!commande_id) return json({ error: 'commande_id requis' }, 400);
      const { data: cmdRows } = await supabase
        .from('commandes')
        .select('id')
        .eq('id', String(commande_id))
        .eq('client_telephone', tel)
        .limit(1);
      if (!cmdRows || !cmdRows.length) return json({ facture: null });
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
