// Module partagé — Uber Direct OAuth2
// Cache en mémoire : persiste entre les requêtes sur une instance Deno chaude.
// En cas de cold start, le token est re-demandé automatiquement.
//
// Secrets requis : UBER_CLIENT_ID, UBER_CLIENT_SECRET

let _token: string | null = null;
let _tokenExpiry = 0;

// Scopes Uber Direct à essayer dans l'ordre selon le type de compte
// Uber Direct (anciennement Postmates) → 'eats.deliveries'
// Certains comptes entreprise → 'direct.organizations'
const UBER_OAUTH_SCOPE = 'eats.deliveries';

export async function getUberToken(): Promise<string> {
  // Réutiliser le token si encore valide (marge 60 s)
  if (_token && Date.now() < _tokenExpiry - 60_000) {
    console.log('[uber-auth] token en cache valide');
    return _token;
  }

  // ── Étape 1 : vérifier les secrets ─────────────────────────────────────────
  const clientId     = Deno.env.get('UBER_CLIENT_ID');
  const clientSecret = Deno.env.get('UBER_CLIENT_SECRET');

  console.log(`[uber-auth] step 1 — secrets: UBER_CLIENT_ID=${clientId ? 'OK ('+clientId.slice(0,4)+'...)' : 'MANQUANT'} | UBER_CLIENT_SECRET=${clientSecret ? 'OK' : 'MANQUANT'}`);

  if (!clientId || !clientSecret) {
    throw new Error('Secrets Supabase manquants : UBER_CLIENT_ID et/ou UBER_CLIENT_SECRET non configurés — ajoutez-les via supabase secrets set');
  }

  // ── Étape 2 : appel OAuth2 ─────────────────────────────────────────────────
  console.log(`[uber-auth] step 2 — OAuth2 POST https://auth.uber.com/oauth/v2/token | scope: ${UBER_OAUTH_SCOPE}`);

  let res: Response;
  try {
    res = await fetch('https://auth.uber.com/oauth/v2/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        client_id:     clientId,
        client_secret: clientSecret,
        grant_type:    'client_credentials',
        scope:         UBER_OAUTH_SCOPE,
      }).toString(),
    });
  } catch (netErr) {
    throw new Error(`[uber-auth] Erreur réseau vers auth.uber.com: ${(netErr as Error).message}`);
  }

  const rawBody = await res.text();
  console.log(`[uber-auth] OAuth2 réponse HTTP ${res.status} | body: ${rawBody.slice(0, 300)}`);

  if (!res.ok) {
    throw new Error(`Uber OAuth2 échoué (HTTP ${res.status}): ${rawBody.slice(0, 300)}`);
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(rawBody);
  } catch {
    throw new Error(`Uber OAuth2: réponse non-JSON (HTTP ${res.status}): ${rawBody.slice(0, 200)}`);
  }

  if (!data.access_token) {
    throw new Error(`Uber OAuth2: access_token absent. Champs reçus: ${Object.keys(data).join(', ')}`);
  }

  _token       = data.access_token as string;
  _tokenExpiry = Date.now() + (Number(data.expires_in) || 2_592_000) * 1000;

  console.log(`[uber-auth] ✅ token obtenu | expire dans ${Math.round((Number(data.expires_in) || 2_592_000) / 3600)} h | scope retourné: ${data.scope ?? '—'}`);
  return _token;
}

// Adresse restaurant — lue à l'appel (pas au niveau module) pour éviter
// les problèmes d'initialisation en cold start Deno Deploy.
export function getRestaurant() {
  return {
    name:         'KBB à la braise',
    address:      Deno.env.get('RESTAURANT_ADDRESS') ?? '',
    phone_number: Deno.env.get('RESTAURANT_PHONE')   ?? '',
    email:        'contact@kbb.fr',
  };
}
