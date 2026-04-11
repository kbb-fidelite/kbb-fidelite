// Supabase Edge Function — get-presence-code
// Retourne le code de présence actuel (4 chiffres) pour l'affichage comptoir.
// Code généré via HMAC-SHA256(EMP_TOKEN_SECRET, slot) — impossible à deviner côté client.
// Slot = Math.floor(Date.now() / 900_000) — change à HH:00, HH:15, HH:30, HH:45.
//
// Requiert un token employé valide (rôle : comptoir | employe | patron).
// Secrets requis : EMP_TOKEN_SECRET (auto-injecté)
// Déploiement : supabase functions deploy get-presence-code

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Vérification du token employé (identique aux autres Edge Functions) ──────
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

// ── Génère le code à 4 chiffres pour un slot donné ───────────────────────────
async function generateCode(secret: string, slot: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(slot)));
  const bytes = new Uint8Array(sig);
  // Prendre les 4 premiers octets → entier 32 bits → mod 10000 → zero-pad 4 chiffres
  const num = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  return String(num % 10000).padStart(4, '0');
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
    const { emp_token } = await req.json();

    if (!emp_token || typeof emp_token !== 'string') {
      return json({ error: 'Token manquant' }, 401);
    }

    const secret  = Deno.env.get('EMP_TOKEN_SECRET') ?? 'kbb-default-secret-change-me';
    const payload = await verifyEmpToken(emp_token, secret);
    if (!payload) {
      return json({ error: 'Token invalide ou expiré — reconnectez-vous' }, 401);
    }

    // Rôles autorisés : comptoir, employe, patron
    const allowed = ['comptoir', 'employe', 'patron'];
    if (!allowed.includes(payload.role)) {
      return json({ error: 'Accès non autorisé' }, 403);
    }

    const nowMs    = Date.now();
    const slotMs   = 900_000; // 15 min en ms
    const slot     = Math.floor(nowMs / slotMs);
    const slotAge  = nowMs % slotMs; // ms écoulées depuis le début du slot

    const code = await generateCode(secret, slot);

    // Temps restant avant le prochain changement
    const expiresInMs = slotMs - slotAge;
    const expiresInSec = Math.floor(expiresInMs / 1000);

    // Heure du slot courant (HH:MM)
    const slotStart = new Date(slot * slotMs);
    const hh = String(slotStart.getUTCHours()).padStart(2, '0');
    const mm = String(slotStart.getUTCMinutes()).padStart(2, '0');
    // Correction timezone Paris (UTC+1 hiver / UTC+2 été)
    const localSlot = new Date(slot * slotMs);
    const localHH = String(localSlot.getHours()).padStart(2, '0');
    const localMM = String(localSlot.getMinutes()).padStart(2, '0');

    console.log(`get-presence-code: code=${code} slot=${slot} role=${payload.role} expires_in=${expiresInSec}s`);

    return json({
      code,
      expires_in: expiresInSec,   // secondes avant le prochain changement
      slot_label: `${localHH}:${localMM}`, // heure de début du slot
    });

  } catch (err) {
    console.error('get-presence-code error:', err);
    return json({ error: (err as Error).message }, 500);
  }
});
