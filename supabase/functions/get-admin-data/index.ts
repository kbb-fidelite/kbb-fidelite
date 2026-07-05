// Supabase Edge Function — get-admin-data
//
// Remplace tous les appels supaReq() directs depuis index.html vers les tables
// clients, commandes, factures (ex-anon SELECT — RGPD/fraude risque).
//
// Actions disponibles (toutes requièrent emp_token valide) :
//   commandes_kds       — commandes en_attente + en_cours (KDS)
//   commandes_pret      — commandes pret (comptoir / service)
//   commandes_all       — toutes commandes non archivées (panel employé)
//   commandes_today     — commandes du jour (patron supervision)
//   commandes_range     — commandes sur période (dashboard)
//   commandes_prev      — commandes période précédente (dashboard comparaison)
//   commandes_year      — commandes depuis début d'année (dashboard CA annuel)
//   commandes_by_id     — commande par ID
//   commandes_by_client — commandes d'un client par téléphone (historique)
//   clients_all         — tous les clients
//   clients_search      — recherche par nom ou téléphone
//   clients_by_id       — client par ID
//   clients_by_tel      — client par téléphone (lookup employé)
//   factures_range      — factures sur période (dashboard)
//   ping                — test de connectivité (retourne {ok:true})
//
// Sécurité : emp_token HMAC-SHA256 vérifié, expiré → 401
// Secrets requis : EMP_TOKEN_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

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

async function verifyEmpToken(token: string, secret: string): Promise<{ role: string } | null> {
  try {
    const dot = token.lastIndexOf('.');
    if (dot === -1) return null;
    const data   = token.slice(0, dot);
    const sigB64 = token.slice(dot + 1);
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const sig   = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(data));
    if (!valid) return null;
    const payload = JSON.parse(atob(data));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const body = await req.json();
    const { action, emp_token } = body;

    // ── 1. Vérification emp_token (obligatoire pour toutes les actions) ──
    if (!emp_token || typeof emp_token !== 'string') {
      return json({ error: 'emp_token requis' }, 401);
    }
    const secret = Deno.env.get('EMP_TOKEN_SECRET') ?? 'kbb-default-secret-change-me';
    const empPayload = await verifyEmpToken(emp_token, secret);
    if (!empPayload) {
      return json({ error: 'Token employé invalide ou expiré — reconnectez-vous' }, 401);
    }

    if (!action) return json({ error: 'action requise' }, 400);

    // ── 2. Ping ──────────────────────────────────────────────────────────
    if (action === 'ping') return json({ ok: true, role: empPayload.role });

    // ── 3. Client Supabase service_role ──────────────────────────────────
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY'))!
    );

    // ── 4. Dispatch ───────────────────────────────────────────────────────

    // ── COMMANDES ──

    if (action === 'commandes_kds') {
      const { data, error } = await supabase
        .from('commandes')
        .select('*')
        .in('statut', ['en_attente', 'en_cours'])
        .order('created_at', { ascending: true })
        .limit(100);
      if (error) return json({ error: error.message }, 500);
      return json({ commandes: data ?? [] });
    }

    if (action === 'commandes_pret') {
      const { data, error } = await supabase
        .from('commandes')
        .select('*')
        .eq('statut', 'pret')
        .order('created_at', { ascending: true })
        .limit(50);
      if (error) return json({ error: error.message }, 500);
      return json({ commandes: data ?? [] });
    }

    if (action === 'commandes_all') {
      const { data, error } = await supabase
        .from('commandes')
        .select('*')
        .order('created_at', { ascending: true })
        .limit(150);
      if (error) return json({ error: error.message }, 500);
      return json({ commandes: data ?? [] });
    }

    if (action === 'commandes_today') {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const { data, error } = await supabase
        .from('commandes')
        .select('*')
        .gte('created_at', todayStart.toISOString())
        .order('created_at', { ascending: false })
        .limit(300);
      if (error) return json({ error: error.message }, 500);
      return json({ commandes: data ?? [] });
    }

    if (action === 'commandes_range') {
      const { from, to } = body;
      if (!from || !to) return json({ error: 'from et to requis' }, 400);
      const { data, error } = await supabase
        .from('commandes')
        .select('*')
        .gte('created_at', from)
        .lte('created_at', to)
        .order('created_at', { ascending: true });
      if (error) return json({ error: error.message }, 500);
      return json({ commandes: data ?? [] });
    }

    if (action === 'commandes_prev') {
      const { from, to } = body;
      if (!from || !to) return json({ error: 'from et to requis' }, 400);
      const { data, error } = await supabase
        .from('commandes')
        .select('id, montant, statut, type, client_telephone')
        .gte('created_at', from)
        .lte('created_at', to);
      if (error) return json({ error: error.message }, 500);
      return json({ commandes: data ?? [] });
    }

    if (action === 'commandes_year') {
      const { year_iso } = body;
      if (!year_iso) return json({ error: 'year_iso requis' }, 400);
      const { data, error } = await supabase
        .from('commandes')
        .select('montant, statut')
        .gte('created_at', year_iso);
      if (error) return json({ error: error.message }, 500);
      return json({ commandes: data ?? [] });
    }

    if (action === 'commandes_by_id') {
      const { id } = body;
      if (!id) return json({ error: 'id requis' }, 400);
      const { data, error } = await supabase
        .from('commandes')
        .select('*')
        .eq('id', String(id))
        .limit(1);
      if (error) return json({ error: error.message }, 500);
      return json({ commande: (data ?? [])[0] ?? null });
    }

    if (action === 'commandes_by_client') {
      const { tel } = body;
      if (!tel) return json({ error: 'tel requis' }, 400);
      const { data, error } = await supabase
        .from('commandes')
        .select('id, montant, pts_a_crediter, created_at, statut')
        .eq('client_telephone', tel)
        .order('created_at', { ascending: false })
        .limit(5);
      if (error) return json({ error: error.message }, 500);
      return json({ commandes: data ?? [] });
    }

    // ── CLIENTS ──

    if (action === 'clients_all') {
      const { data, error } = await supabase
        .from('clients')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) return json({ error: error.message }, 500);
      return json({ clients: data ?? [] });
    }

    if (action === 'clients_search') {
      const { q } = body;
      if (!q || typeof q !== 'string') return json({ error: 'q requis' }, 400);
      const enc = q.trim();
      const [byPhone, byName] = await Promise.all([
        supabase.from('clients').select('*').ilike('telephone', `%${enc}%`).limit(5),
        supabase.from('clients').select('*').or(`prenom.ilike.%${enc}%,nom.ilike.%${enc}%`).limit(5),
      ]);
      const seen = new Set<number>();
      const results: unknown[] = [];
      [...(byPhone.data ?? []), ...(byName.data ?? [])].forEach((c: { id: number }) => {
        if (!seen.has(c.id)) { seen.add(c.id); results.push(c); }
      });
      return json({ clients: results });
    }

    if (action === 'clients_by_id') {
      const { id } = body;
      if (!id) return json({ error: 'id requis' }, 400);
      const { data, error } = await supabase
        .from('clients')
        .select('*')
        .eq('id', id)
        .limit(1);
      if (error) return json({ error: error.message }, 500);
      return json({ client: (data ?? [])[0] ?? null });
    }

    if (action === 'clients_by_tel') {
      const { tel } = body;
      if (!tel) return json({ error: 'tel requis' }, 400);
      const { data, error } = await supabase
        .from('clients')
        .select('*')
        .eq('telephone', tel.trim())
        .limit(1);
      if (error) return json({ error: error.message }, 500);
      return json({ client: (data ?? [])[0] ?? null });
    }

    // ── FACTURES ──

    if (action === 'factures_range') {
      const { from, to } = body;
      if (!from || !to) return json({ error: 'from et to requis' }, 400);
      const { data, error } = await supabase
        .from('factures')
        .select('*')
        .gte('date', from)
        .lte('date', to)
        .order('date', { ascending: true });
      if (error) return json({ error: error.message }, 500);
      return json({ factures: data ?? [] });
    }

    return json({ error: `action inconnue: ${action}` }, 400);

  } catch (err) {
    console.error('[get-admin-data] erreur fatale:', (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});
