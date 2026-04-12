// Supabase Edge Function — send-push-notification
//
// Envoie une notification Web Push à un client identifié par son numéro de téléphone.
// Implémente VAPID (ES256) + chiffrement RFC 8291 (aes128gcm) via Deno Web Crypto API.
//
// Modes d'appel :
//   { client_tel, title, body, emp_token }       → depuis le dashboard employé
//   { client_tel, title, body, internal_secret } → depuis une autre Edge Function (update-commande)
//
// Gestion 410 Gone : supprime automatiquement push_subscription du client.
//
// Secrets requis :
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY  (clés VAPID P-256 en base64url)
//   EMP_TOKEN_SECRET                      (partagé avec update-commande)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injectés)
//
// Déploiement : supabase functions deploy send-push-notification

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// ── Base64url ─────────────────────────────────────────────────────────────────

function b64uEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64uDecode(s: string): Uint8Array {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ── HKDF (Extract + Expand) ───────────────────────────────────────────────────

async function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Promise<CryptoKey> {
  const saltKey = await crypto.subtle.importKey(
    'raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const prk = await crypto.subtle.sign('HMAC', saltKey, ikm);
  return crypto.subtle.importKey(
    'raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
}

async function hkdfExpand(prk: CryptoKey, info: Uint8Array, length: number): Promise<Uint8Array> {
  const result = new Uint8Array(length);
  let t = new Uint8Array(0);
  let pos = 0;
  for (let counter = 1; pos < length; counter++) {
    const input = new Uint8Array(t.length + info.length + 1);
    input.set(t, 0);
    input.set(info, t.length);
    input[t.length + info.length] = counter;
    t = new Uint8Array(await crypto.subtle.sign('HMAC', prk, input));
    const take = Math.min(length - pos, t.length);
    result.set(t.slice(0, take), pos);
    pos += take;
  }
  return result;
}

// ── VAPID JWT (ES256) ─────────────────────────────────────────────────────────

async function buildVapidJwt(endpoint: string): Promise<{ jwt: string; pubKey: string }> {
  const vapidPub  = Deno.env.get('VAPID_PUBLIC_KEY')!;
  const vapidPriv = Deno.env.get('VAPID_PRIVATE_KEY')!;

  // Uncompressed public key: 0x04 ‖ x(32) ‖ y(32)
  const pubBytes = b64uDecode(vapidPub);
  if (pubBytes[0] !== 0x04 || pubBytes.length !== 65) {
    throw new Error('VAPID_PUBLIC_KEY invalide — attendu 65 octets non compressés');
  }
  const x = b64uEncode(pubBytes.slice(1, 33));
  const y = b64uEncode(pubBytes.slice(33, 65));

  const privKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', d: vapidPriv, x, y, key_ops: ['sign'] },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  const url = new URL(endpoint);
  const aud = `${url.protocol}//${url.host}`;
  const exp = Math.floor(Date.now() / 1000) + 43200; // 12 h

  const header  = b64uEncode(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64uEncode(new TextEncoder().encode(JSON.stringify({
    aud,
    exp,
    sub: 'mailto:contact@kbb.fr',
  })));

  const sigInput = new TextEncoder().encode(`${header}.${payload}`);
  // Web Crypto retourne ECDSA en IEEE P1363 (r‖s, 64 octets) — pas en DER
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, privKey, sigInput
  );

  return { jwt: `${header}.${payload}.${b64uEncode(sig)}`, pubKey: vapidPub };
}

// ── RFC 8291 / 8188 payload encryption (aes128gcm) ───────────────────────────

async function encryptPayload(
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  plaintext: string
): Promise<Uint8Array> {
  const receiverPub = b64uDecode(sub.keys.p256dh); // 65-byte uncompressed point
  const authSecret  = b64uDecode(sub.keys.auth);   // 16-byte auth secret
  const ptBytes     = new TextEncoder().encode(plaintext);

  // Import receiver's public key for ECDH
  const receiverKey = await crypto.subtle.importKey(
    'raw', receiverPub, { name: 'ECDH', namedCurve: 'P-256' }, true, []
  );

  // Generate ephemeral sender key pair
  const senderPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  );
  const senderPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', senderPair.publicKey));

  // ECDH shared secret (256 bits → 32 bytes)
  const sharedBits   = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: receiverKey }, senderPair.privateKey, 256
  );
  const sharedSecret = new Uint8Array(sharedBits);

  // Random 16-byte salt (per RFC 8188)
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // ── RFC 8291 §3.4 key derivation ─────────────────────────────────────────
  // PRK_key = HKDF-Extract(salt=auth_secret, IKM=shared_secret)
  const prkKey = await hkdfExtract(authSecret, sharedSecret);

  // key_info = "WebPush: info\0" ‖ receiver_pub(65) ‖ sender_pub(65)
  const keyInfoPrefix = new TextEncoder().encode('WebPush: info\0');
  const keyInfo = new Uint8Array(keyInfoPrefix.length + receiverPub.length + senderPubRaw.length);
  keyInfo.set(keyInfoPrefix, 0);
  keyInfo.set(receiverPub, keyInfoPrefix.length);
  keyInfo.set(senderPubRaw, keyInfoPrefix.length + receiverPub.length);

  // IKM = HKDF-Expand(PRK_key, key_info, 32)
  const ikm = await hkdfExpand(prkKey, keyInfo, 32);

  // ── RFC 8188 §2.1 content key + nonce ────────────────────────────────────
  // PRK = HKDF-Extract(salt=salt, IKM=IKM)
  const prk = await hkdfExtract(salt, ikm);

  const cek   = await hkdfExpand(prk, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfExpand(prk, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);

  const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);

  // Padding delimiter: plaintext ‖ 0x02 (no padding, record ends here)
  const padded = new Uint8Array(ptBytes.length + 1);
  padded.set(ptBytes, 0);
  padded[ptBytes.length] = 0x02;

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cekKey, padded)
  );

  // ── Binary content body (RFC 8188 §2) ────────────────────────────────────
  // salt(16) ‖ rs(uint32BE=4096) ‖ idlen(1=65) ‖ sender_pub(65) ‖ ciphertext
  const body = new Uint8Array(16 + 4 + 1 + 65 + ciphertext.length);
  let off = 0;
  body.set(salt, off); off += 16;
  new DataView(body.buffer).setUint32(off, 4096, false); off += 4;
  body[off++] = 65;
  body.set(senderPubRaw, off); off += 65;
  body.set(ciphertext, off);

  return body;
}

// ── Envoi HTTP vers le push endpoint ─────────────────────────────────────────

async function pushToEndpoint(
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  notification: { title: string; body: string }
): Promise<number> {
  const payload  = JSON.stringify({
    title: notification.title,
    body:  notification.body,
    icon:  './icon-kbb.png',
    badge: './icon-kbb.png',
  });

  const [encrypted, { jwt, pubKey }] = await Promise.all([
    encryptPayload(sub, payload),
    buildVapidJwt(sub.endpoint),
  ]);

  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Authorization':    `vapid t=${jwt},k=${pubKey}`,
      'Content-Type':     'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL':              '86400',
    },
    body: encrypted,
  });

  return res.status;
}

// ── Vérification token employé (même logique que update-commande) ─────────────

async function verifyEmpToken(token: string, secret: string): Promise<boolean> {
  try {
    const dot = token.lastIndexOf('.');
    if (dot === -1) return false;
    const data   = token.slice(0, dot);
    const sigB64 = token.slice(dot + 1);
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const sig   = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(data));
    if (!valid) return false;
    const payload = JSON.parse(atob(data));
    return payload.exp && payload.exp > Date.now();
  } catch {
    return false;
  }
}

// ── Handler principal ─────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json();
    const { client_tel, title, body: msgBody, emp_token, internal_secret } = body;

    // ── Authentification ──────────────────────────────────────────────────────
    const empSecret = Deno.env.get('EMP_TOKEN_SECRET') ?? 'kbb-default-secret-change-me';

    const isInternal = typeof internal_secret === 'string' && internal_secret === empSecret;
    const isEmployee = !isInternal && typeof emp_token === 'string'
      && await verifyEmpToken(emp_token, empSecret);

    if (!isInternal && !isEmployee) {
      return json({ error: 'Non autorisé' }, 401);
    }

    // ── Validation ────────────────────────────────────────────────────────────
    if (!client_tel || typeof client_tel !== 'string') return json({ error: 'client_tel requis' }, 400);
    if (!title     || typeof title !== 'string')       return json({ error: 'title requis' }, 400);
    if (!msgBody   || typeof msgBody !== 'string')     return json({ error: 'body requis' }, 400);

    // ── Lecture de l'abonnement en base ───────────────────────────────────────
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const tel = client_tel.trim();
    const { data: rows, error: fetchErr } = await supabase
      .from('clients')
      .select('id, push_subscription')
      .eq('telephone', tel)
      .limit(1);

    if (fetchErr) {
      console.error('send-push-notification: SELECT client:', fetchErr.message);
      return json({ error: 'Erreur base de données' }, 500);
    }
    if (!rows || rows.length === 0) return json({ error: 'Client introuvable' }, 404);

    const clientId = rows[0].id;
    const sub      = rows[0].push_subscription;

    if (!sub || !sub.endpoint || !sub.keys) {
      return json({ ok: false, reason: 'Aucun abonnement push enregistré' });
    }

    // ── Envoi ─────────────────────────────────────────────────────────────────
    let status: number;
    try {
      status = await pushToEndpoint(sub, { title, body: msgBody });
    } catch (pushErr) {
      console.error('send-push-notification: pushToEndpoint:', pushErr);
      return json({ error: `Erreur envoi push: ${(pushErr as Error).message}` }, 500);
    }

    // 410 Gone → abonnement expiré, on nettoie la DB
    if (status === 410) {
      console.log(`send-push-notification: 410 Gone pour tel=${tel.slice(-4)} — suppression abonnement`);
      await supabase.from('clients').update({ push_subscription: null }).eq('id', clientId);
      return json({ ok: false, reason: 'Abonnement expiré (410) — supprimé automatiquement' });
    }

    if (status === 201 || status === 200) {
      console.log(`send-push-notification: envoyée (${status}) à tel=${tel.slice(-4)}`);
      return json({ ok: true, status });
    }

    console.warn(`send-push-notification: endpoint a répondu ${status} pour tel=${tel.slice(-4)}`);
    return json({ ok: false, reason: `Push endpoint a répondu ${status}` });

  } catch (err) {
    console.error('send-push-notification error:', err);
    return json({ error: (err as Error).message }, 500);
  }
});
