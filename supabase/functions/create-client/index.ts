// Supabase Edge Function — create-client
//
// Crée un nouveau client fidélité.
// Accepte deux modes :
//   1. Auto-inscription client : sans emp_token
//   2. Création par employé    : emp_token valide requis
//
// Sécurité :
//   - Rate-limiting : max 3 créations par IP par heure (via table rate_limits)
//   - Validation format téléphone français (06/07/+33)
//   - Vérifie l'unicité du téléphone avant insertion
//   - Insertion via service_role (bypass RLS)
//   - Téléphone jamais loggué en clair
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

// Valide le format téléphone français : 06/07 ou +336/+337 (10 chiffres)
function isValidFrenchPhone(tel: string): boolean {
  const cleaned = tel.replace(/[\s.\-()]/g, '');
  // Format +33 6/7 XX XX XX XX (12 chars) ou 06/07 XX XX XX XX (10 chars)
  return /^(?:\+33[67]\d{8}|0[67]\d{8})$/.test(cleaned);
}

// Normalise le téléphone : +33 → 0
function normalizeTel(tel: string): string {
  const cleaned = tel.replace(/[\s.\-()]/g, '');
  if (cleaned.startsWith('+33')) return '0' + cleaned.slice(3);
  return cleaned;
}

const RATE_LIMIT_MAX = 3;       // max créations par IP
const RATE_LIMIT_WINDOW = 3600; // fenêtre en secondes (1h)

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
      return json({ error: 'prenom requis' }, 400);
    }

    const rawTel = telephone.trim();

    // ── 2. Validation format téléphone français ──────────────────────────
    if (!isValidFrenchPhone(rawTel)) {
      return json({ error: 'Format téléphone invalide — attendu : 06/07 ou +33 6/7' }, 400);
    }

    const tel = normalizeTel(rawTel);
    const telMasked = '…' + tel.slice(-4);

    // ── 3. Vérification emp_token (optionnel) ────────────────────────────
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

    // ── 4. Rate-limiting par IP (auto-inscription uniquement) ────────────
    if (!empRole) {
      const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        || req.headers.get('cf-connecting-ip')
        || 'unknown';

      const cutoff = new Date(Date.now() - RATE_LIMIT_WINDOW * 1000).toISOString();
      const { count, error: rlErr } = await supabase
        .from('pin_attempts')
        .select('*', { count: 'exact', head: true })
        .eq('identifier', 'create_client_' + clientIP)
        .gte('created_at', cutoff);

      if (!rlErr && (count ?? 0) >= RATE_LIMIT_MAX) {
        console.warn(`[create-client] rate limit atteint pour IP ${clientIP.slice(-6)}`);
        return json({ error: 'Trop de tentatives — réessayez dans une heure' }, 429);
      }

      // Enregistrer la tentative
      await supabase.from('pin_attempts').insert({
        identifier: 'create_client_' + clientIP,
        created_at: new Date().toISOString(),
      }).catch(() => {}); // best-effort
    }

    // ── 5. Vérifier unicité téléphone ─────────────────────────────────────
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

    // ── 6. Insertion ──────────────────────────────────────────────────────
    const payload: Record<string, unknown> = {
      telephone:   tel,
      prenom:      (prenom ?? '').trim(),
      nom:         (nom ?? '').trim(),
      email:       '',
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
