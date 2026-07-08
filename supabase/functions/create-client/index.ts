// Supabase Edge Function — create-client
//
// Remplace supaReq('clients','POST',payload) depuis index.html.
// Accepte deux modes d'authentification :
//   1. Auto-inscription client : sans emp_token — crée un compte avec numéro de téléphone
//   2. Création par employé    : emp_token valide requis
//
// Sécurité :
//   - Vérifie l'unicité du téléphone avant insertion
//   - Insertion via service_role (bypass RLS)
//   - Téléphone jamais loggué en clair
//   - Valide les champs obligatoires
//
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
    const { prenom, nom, telephone, code_secret, date_naissance, emp_token } = body;

    // ── 1. Validation champs obligatoires ────────────────────────────────
    if (!telephone || typeof telephone !== 'string' || !telephone.trim()) {
      return json({ error: 'telephone requis' }, 400);
    }
    if (!prenom && !nom && !emp_token) {
      // Auto-inscription minimale requiert prenom
      return json({ error: 'prenom requis' }, 400);
    }

    const tel = telephone.trim();
    const telMasked = '…' + tel.slice(-4);

    // ── 2. Vérification emp_token (optionnel — requis pour employee flow) ─
    let empRole: string | null = null;
    if (emp_token) {
      const secret = Deno.env.get('EMP_TOKEN_SECRET') ?? 'kbb-default-secret-change-me';
      const empPayload = await verifyEmpToken(emp_token, secret);
      if (!empPayload) {
        return json({ error: 'Token employé invalide ou expiré — reconnectez-vous' }, 401);
      }
      empRole = empPayload.role;
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY'))!
    );

    // ── 3. Vérifier unicité téléphone ─────────────────────────────────────
    const { data: existing, error: checkErr } = await supabase
      .from('clients')
      .select('id')
      .eq('telephone', tel)
      .limit(1);

    if (checkErr) {
      console.error('[create-client] check unicité:', checkErr.message);
      return json({ error: 'Erreur base de données' }, 500);
    }
    if (existing && existing.length > 0) {
      return json({ error: 'duplicate', code: '23505' }, 409);
    }

    // ── 4. Insertion ──────────────────────────────────────────────────────
    const payload: Record<string, unknown> = {
      telephone:   tel,
      prenom:      (prenom ?? '').trim(),
      nom:         (nom ?? '').trim(),
      email:       '',
      points:      0,
      cagnotte:    0,
      points_cumul: 0,
      passages:    0,
      code_secret: code_secret ?? '',
    };
    if (date_naissance) payload.date_naissance = date_naissance;

    const { data: inserted, error: insertErr } = await supabase
      .from('clients')
      .insert(payload)
      .select('*')
      .maybeSingle();

    if (insertErr) {
      console.error('[create-client] insert:', insertErr.message);
      // Doublon concurrent (race condition)
      if (insertErr.code === '23505') {
        return json({ error: 'duplicate', code: '23505' }, 409);
      }
      return json({ error: 'Erreur base de données' }, 500);
    }

    console.log(`[create-client] créé tel=${telMasked} id=${inserted?.id} par=${empRole ?? 'auto-inscription'}`);
    return json({ ok: true, client: inserted });

  } catch (err) {
    console.error('[create-client] erreur fatale:', (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});
