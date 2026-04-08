// Supabase Edge Function — manage-flash
// Gère l'offre flash (SET / DELETE) dans la table settings.
// Requiert un token employé valide avec rôle "patron" (émis par verify-pin).
// Utilise SUPABASE_SERVICE_ROLE_KEY pour bypasser les RLS → anon ne peut plus écrire dans settings.
//
// Secrets requis : EMP_TOKEN_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injectés)
// Déploiement : supabase functions deploy manage-flash

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Réplication de la vérification HMAC-SHA256 identique à verify-pin
async function verifyEmpToken(
  token: string,
  secret: string
): Promise<{ role: string; exp: number } | null> {
  try {
    const dot = token.lastIndexOf('.');
    if (dot === -1) return null;
    const data  = token.slice(0, dot);
    const sigB64 = token.slice(dot + 1);

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const sig   = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(data));
    if (!valid) return null;

    const payload = JSON.parse(atob(data));
    if (!payload.exp || payload.exp < Date.now()) return null; // token expiré
    return payload;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { action, flash, emp_token } = await req.json();

    // ── 1. Vérifier le token employé ─────────────────────────────
    if (!emp_token || typeof emp_token !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Token manquant' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const secret  = Deno.env.get('EMP_TOKEN_SECRET') ?? 'kbb-default-secret-change-me';
    const payload = await verifyEmpToken(emp_token, secret);

    if (!payload) {
      return new Response(
        JSON.stringify({ error: 'Token invalide ou expiré — reconnectez-vous' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── 2. Vérifier le rôle patron ───────────────────────────────
    if (payload.role !== 'patron') {
      return new Response(
        JSON.stringify({ error: 'Accès réservé au patron' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── 3. Initialiser le client service_role (bypass RLS) ───────
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // ── 4. Exécuter l'action ─────────────────────────────────────
    if (action === 'set') {
      if (!flash || typeof flash.msg !== 'string' || typeof flash.end !== 'number') {
        return new Response(
          JSON.stringify({ error: 'Données flash invalides (msg et end requis)' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      if (flash.end <= Date.now()) {
        return new Response(
          JSON.stringify({ error: 'Durée flash déjà expirée' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const { error } = await supabase
        .from('settings')
        .upsert(
          { key: 'flash', value: flash, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        );

      if (error) throw new Error('Supabase settings upsert: ' + error.message);

      console.log('manage-flash: offre flash activée par patron —', flash.msg);
      return new Response(
        JSON.stringify({ ok: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (action === 'delete') {
      const { error } = await supabase.from('settings').delete().eq('key', 'flash');
      if (error) throw new Error('Supabase settings delete: ' + error.message);

      console.log('manage-flash: offre flash arrêtée par patron');
      return new Response(
        JSON.stringify({ ok: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ error: 'Action inconnue (attendu: set | delete)' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('manage-flash error:', err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
