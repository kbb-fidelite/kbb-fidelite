// Supabase Edge Function — update-horaires
// Met à jour les horaires d'ouverture dans settings (key='horaires').
// Requiert un token employé valide avec rôle "patron" (émis par verify-pin).
// Utilise SUPABASE_SERVICE_ROLE_KEY pour bypasser les RLS.
// L'écriture directe depuis le navigateur (anon) est impossible par RLS.
//
// Secrets requis : EMP_TOKEN_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injectés)
// Déploiement : supabase functions deploy update-horaires

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Vérification HMAC-SHA256 — identique à verify-pin / manage-flash
async function verifyEmpToken(
  token: string,
  secret: string
): Promise<{ role: string; exp: number } | null> {
  try {
    const dot = token.lastIndexOf('.');
    if (dot === -1) return null;
    const data   = token.slice(0, dot);
    const sigB64 = token.slice(dot + 1);
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const sig   = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(data));
    if (!valid) return null;
    const payload = JSON.parse(atob(data));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

// Valide la structure du JSON horaires avant écriture
// Accepte le nouveau format {services:[{open,close},...]} et l'ancien {open,close}
function isValidSchedule(s: unknown): boolean {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return false;
  const obj = s as Record<string, unknown>;
  for (const day of ['0','1','2','3','4','5','6']) {
    if (!(day in obj)) return false;
    const v = obj[day];
    if (v === null) continue; // fermé ce jour
    if (typeof v !== 'object' || Array.isArray(v)) return false;
    const d = v as Record<string, unknown>;

    if ('services' in d) {
      // Nouveau format : {services: [{open,close}, ...]}
      const svcs = d.services;
      if (!Array.isArray(svcs) || svcs.length === 0 || svcs.length > 2) return false;
      for (const svc of svcs as unknown[]) {
        if (!svc || typeof svc !== 'object' || Array.isArray(svc)) return false;
        const sv = svc as Record<string, unknown>;
        if (typeof sv.open !== 'string' || typeof sv.close !== 'string') return false;
        if (!/^\d{2}:\d{2}$/.test(sv.open) || !/^\d{2}:\d{2}$/.test(sv.close)) return false;
        if (toMin(sv.close as string) <= toMin(sv.open as string)) return false;
      }
      // Si 2 services : le service 2 doit commencer après la fin du service 1
      if (svcs.length === 2) {
        const sv1 = svcs[0] as Record<string, string>;
        const sv2 = svcs[1] as Record<string, string>;
        if (toMin(sv2.open) <= toMin(sv1.close)) return false;
      }
    } else {
      // Ancien format : {open,close} — rétrocompatibilité
      if (typeof d.open !== 'string' || typeof d.close !== 'string') return false;
      if (!/^\d{2}:\d{2}$/.test(d.open) || !/^\d{2}:\d{2}$/.test(d.close)) return false;
      if (toMin(d.close as string) <= toMin(d.open as string)) return false;
    }
  }
  if (!Array.isArray(obj.exceptions)) return false;
  for (const ex of obj.exceptions as unknown[]) {
    if (typeof ex !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ex)) return false;
  }
  return true;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { schedule, emp_token } = await req.json();

    // ── 1. Token requis ───────────────────────────────────────────
    if (!emp_token || typeof emp_token !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Token manquant' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── 2. Vérification HMAC + expiration ─────────────────────────
    const secret  = Deno.env.get('EMP_TOKEN_SECRET') ?? 'kbb-default-secret-change-me';
    const payload = await verifyEmpToken(emp_token, secret);
    if (!payload) {
      return new Response(
        JSON.stringify({ error: 'Token invalide ou expiré — reconnectez-vous' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── 3. Rôle patron obligatoire ────────────────────────────────
    if (payload.role !== 'patron') {
      return new Response(
        JSON.stringify({ error: 'Accès réservé au patron' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── 4. Validation de la structure horaires ────────────────────
    if (!isValidSchedule(schedule)) {
      return new Response(
        JSON.stringify({ error: 'Format horaires invalide — vérifiez les champs open/close (HH:MM) et exceptions (YYYY-MM-DD)' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── 5. Écriture via service_role (bypass RLS) ─────────────────
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { error } = await supabase
      .from('settings')
      .upsert(
        { key: 'horaires', value: schedule, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );

    if (error) throw new Error('Supabase settings upsert: ' + error.message);

    console.log('update-horaires: horaires mis à jour par patron —', JSON.stringify(schedule));
    return new Response(
      JSON.stringify({ ok: true }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('update-horaires error:', err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
