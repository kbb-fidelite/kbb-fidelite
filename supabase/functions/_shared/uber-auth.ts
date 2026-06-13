// Module partagé — Uber Direct OAuth2
// Cache en mémoire : persiste entre les requêtes sur une instance Deno chaude.
// En cas de cold start, le token est re-demandé automatiquement.
//
// Secrets requis : UBER_CLIENT_ID, UBER_CLIENT_SECRET

let _token: string | null = null;
let _tokenExpiry = 0;

export async function getUberToken(): Promise<string> {
  // Réutiliser le token si encore valide (marge 60 s)
  if (_token && Date.now() < _tokenExpiry - 60_000) {
    return _token;
  }

  const clientId     = Deno.env.get('UBER_CLIENT_ID');
  const clientSecret = Deno.env.get('UBER_CLIENT_SECRET');

  if (!clientId || !clientSecret) {
    throw new Error('UBER_CLIENT_ID ou UBER_CLIENT_SECRET non configurés dans les secrets Supabase');
  }

  const res = await fetch('https://auth.uber.com/oauth/v2/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      grant_type:    'client_credentials',
      scope:         'eats.deliveries',
    }).toString(),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Uber OAuth2 échoué (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Uber OAuth2: access_token absent de la réponse');
  }

  _token       = data.access_token as string;
  _tokenExpiry = Date.now() + (data.expires_in ?? 2_592_000) * 1000;

  console.log(`[uber-auth] token obtenu | expire dans ${Math.round((data.expires_in ?? 2_592_000) / 3600)} h`);
  return _token;
}

// Constantes restaurant (pickup)
export const RESTAURANT = {
  name:         'KBB à la braise',
  address:      Deno.env.get('RESTAURANT_ADDRESS') ?? '1 Rue de la Braise, 75001 Paris, France',
  phone_number: Deno.env.get('RESTAURANT_PHONE')   ?? '+33100000000',
  email:        'contact@kbb.fr',
} as const;
