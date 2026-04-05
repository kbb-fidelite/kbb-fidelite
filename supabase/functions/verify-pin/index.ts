// Supabase Edge Function — verify-pin
// Vérifie le PIN employé côté serveur, retourne un token JWT signé (8h)
// Secrets requis :
//   supabase secrets set EMP_TOKEN_SECRET=<chaîne aléatoire longue>
//
// Déploiement :
//   supabase functions deploy verify-pin

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MAX_ATTEMPTS   = 3;
const LOCK_MINUTES   = 15;
const TOKEN_HOURS    = 8;
const IDENTIFIER     = 'emp_global'; // compteur global — toutes tentatives confondues

async function signToken(payload: Record<string, unknown>, secret: string): Promise<string> {
  const data = btoa(JSON.stringify(payload));
  const key  = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig    = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return data + '.' + sigB64;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { pin } = await req.json();

    if (!pin || pin.length !== 4 || !/^\d{4}$/.test(pin)) {
      return new Response(
        JSON.stringify({ error: 'PIN invalide — 4 chiffres requis' }),
        { status: 400, headers: corsHeaders }
      );
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // ── 1. Vérifier le verrouillage ──────────────────────────────
    const { data: attempt } = await supabase
      .from('pin_attempts')
      .select('*')
      .eq('identifier', IDENTIFIER)
      .maybeSingle();

    if (attempt?.locked_until && new Date(attempt.locked_until) > new Date()) {
      const remaining_ms      = new Date(attempt.locked_until).getTime() - Date.now();
      const remaining_minutes = Math.ceil(remaining_ms / 60000);
      return new Response(
        JSON.stringify({ error: 'locked', remaining_minutes }),
        { status: 429, headers: corsHeaders }
      );
    }

    // ── 2. Lire les PIN depuis config (service_role bypass RLS) ──
    const { data: configs, error: cfgErr } = await supabase
      .from('config')
      .select('key, value')
      .in('key', ['pin_employe', 'pin_patron', 'pin_cuisine', 'pin_comptoir']);

    if (cfgErr || !configs?.length) {
      console.error('Config error:', cfgErr);
      return new Response(
        JSON.stringify({ error: 'Configuration serveur manquante' }),
        { status: 500, headers: corsHeaders }
      );
    }

    const pinMap: Record<string, string> = {};
    for (const c of configs) pinMap[c.key] = c.value;

    // ── 3. Comparer le PIN ────────────────────────────────────────
    let matchedRole: string | null = null;
    if      (pin === pinMap['pin_patron'])   matchedRole = 'patron';
    else if (pin === pinMap['pin_employe'])  matchedRole = 'employe';
    else if (pin === pinMap['pin_cuisine'])  matchedRole = 'cuisine';
    else if (pin === pinMap['pin_comptoir']) matchedRole = 'comptoir';

    if (!matchedRole) {
      const newAttempts = (attempt?.attempts ?? 0) + 1;
      const locked_until = newAttempts >= MAX_ATTEMPTS
        ? new Date(Date.now() + LOCK_MINUTES * 60 * 1000).toISOString()
        : null;

      if (attempt) {
        await supabase.from('pin_attempts')
          .update({ attempts: newAttempts, locked_until, last_attempt: new Date().toISOString() })
          .eq('identifier', IDENTIFIER);
      } else {
        await supabase.from('pin_attempts')
          .insert({ identifier: IDENTIFIER, attempts: newAttempts, locked_until });
      }

      const remaining = Math.max(0, MAX_ATTEMPTS - newAttempts);
      return new Response(
        JSON.stringify({ error: 'wrong_pin', remaining }),
        { status: 401, headers: corsHeaders }
      );
    }

    // ── 4. Succès — réinitialiser les tentatives ─────────────────
    if (attempt) {
      await supabase.from('pin_attempts').delete().eq('identifier', IDENTIFIER);
    }

    // ── 5. Générer token HMAC-SHA256 (8h) ────────────────────────
    const secret  = Deno.env.get('EMP_TOKEN_SECRET') ?? 'kbb-default-secret-change-me';
    const exp     = Date.now() + TOKEN_HOURS * 60 * 60 * 1000;
    const payload = { role: matchedRole, exp, iat: Date.now() };
    const token   = await signToken(payload, secret);

    return new Response(
      JSON.stringify({ token, role: matchedRole, exp }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('verify-pin error:', err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: corsHeaders }
    );
  }
});
