// Supabase Edge Function — verify-presence-code
// Vérifie le code de présence soumis par le client.
// Rate-limit : 3 tentatives/minute par client_tel.
// Accepte le slot courant + le slot précédent si ≤ 2 min après le changement.
// Si valide : retourne un presence_token signé HMAC (valide 10 min).
// Le presence_token est vérifié par create-commande et create-checkout.
//
// Secrets requis : EMP_TOKEN_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Déploiement : supabase functions deploy verify-presence-code

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SLOT_MS        = 900_000;  // 15 min
const GRACE_MS       = 120_000;  // 2 min de tolérance après changement
const TOKEN_TTL_MS   = 600_000;  // 10 min de validité du presence_token
const MAX_ATTEMPTS   = 3;        // tentatives max par minute

// ── Génère le code HMAC pour un slot ────────────────────────────────────────
async function generateCode(secret: string, slot: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig   = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(slot)));
  const bytes = new Uint8Array(sig);
  const num   = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  return String(num % 10000).padStart(4, '0');
}

// ── Génère le presence_token signé ──────────────────────────────────────────
async function generatePresenceToken(secret: string, clientTel: string): Promise<string> {
  const payload = btoa(JSON.stringify({ exp: Date.now() + TOKEN_TTL_MS, tel: clientTel, t: 'presence' }));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig  = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return `${payload}.${sigB64}`;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { code, client_tel } = await req.json();

    if (!code || typeof code !== 'string' || !/^\d{4}$/.test(code.trim())) {
      return json({ error: 'Code invalide — 4 chiffres requis', code: 'CODE_INVALIDE' }, 400);
    }
    if (!client_tel || typeof client_tel !== 'string') {
      return json({ error: 'client_tel requis', code: 'ERREUR' }, 400);
    }

    const secret   = Deno.env.get('EMP_TOKEN_SECRET') ?? 'kbb-default-secret-change-me';
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const tel   = String(client_tel).trim();
    const submitted = code.trim();

    // ── Rate-limiting : max 3 tentatives/minute par client_tel ───────────────
    const oneMinAgo = new Date(Date.now() - 60_000).toISOString();
    const { count: recentAttempts } = await supabase
      .from('presence_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('client_tel', tel)
      .gte('created_at', oneMinAgo);

    if ((recentAttempts ?? 0) >= MAX_ATTEMPTS) {
      // Logger la tentative bloquée
      await supabase.from('presence_attempts').insert({
        client_tel: tel,
        code_soumis: submitted,
        success: false,
        bloque: true,
      });
      console.warn(`verify-presence-code: RATE_LIMIT tel=${tel} tentatives=${recentAttempts}`);
      return json({ error: 'Trop de tentatives — réessayez dans 1 minute', code: 'TROP_DE_TENTATIVES' }, 429);
    }

    // ── Vérification du code HMAC ─────────────────────────────────────────────
    const nowMs   = Date.now();
    const slot    = Math.floor(nowMs / SLOT_MS);
    const slotAge = nowMs % SLOT_MS;

    // Slots valides : courant + précédent si ≤ 2 min après changement
    const validSlots = [slot];
    if (slotAge < GRACE_MS) validSlots.push(slot - 1);

    const validCodes = await Promise.all(validSlots.map(s => generateCode(secret, s)));
    const isValid    = validCodes.includes(submitted);

    // Logger la tentative (non bloquant — erreur ignorée si table absente)
    const { error: logErr } = await supabase.from('presence_attempts').insert({
      client_tel: tel,
      code_soumis: submitted,
      success: isValid,
      bloque: false,
    });
    if (logErr) console.warn('presence_attempts log:', logErr.message);

    if (!isValid) {
      // Distinguer code invalide vs code expiré (slot trop vieux)
      const prevCode = await generateCode(secret, slot - 1);
      const isExpired = submitted === prevCode && slotAge >= GRACE_MS;
      console.warn(`verify-presence-code: ${isExpired?'EXPIRE':'INVALIDE'} tel=${tel} submitted=${submitted}`);
      if (isExpired) {
        return json({ error: 'Ce code a expiré — demandez le nouveau code au comptoir', code: 'CODE_EXPIRE' }, 400);
      }
      return json({ error: 'Code incorrect — demandez le code au comptoir', code: 'CODE_INVALIDE' }, 400);
    }

    // ── Code valide → générer le presence_token ───────────────────────────────
    const presence_token = await generatePresenceToken(secret, tel);
    console.log(`verify-presence-code: OK tel=${tel} slot=${slot}`);
    return json({ ok: true, presence_token });

  } catch (err) {
    console.error('verify-presence-code error:', err);
    return json({ error: (err as Error).message }, 500);
  }
});
