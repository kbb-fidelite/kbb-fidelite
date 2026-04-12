const VERSION = 'kbb-v143';
const CACHE = VERSION;

// Fichiers critiques — l'app ne fonctionne pas sans eux
const ASSETS_CRITICAL = [
  './',
  './index.html'
];

// Fichiers optionnels — mis en cache si disponibles (pas de 404 bloquant)
const ASSETS_OPTIONAL = [
  './manifest.json',
  './manifest-kiosque.json',
  './icon-192x192.png',
  './icon-512x512.png',
  './apple-touch-icon.png',
  './favicon.ico'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(async cache => {
      // Critiques : doit réussir
      await cache.addAll(ASSETS_CRITICAL);
      // Optionnels : on ignore les erreurs individuelles
      await Promise.allSettled(
        ASSETS_OPTIONAL.map(url => cache.add(url).catch(() => null))
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.hostname.includes('supabase')) return;
  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(e.request);
      const fetchPromise = fetch(e.request).then(response => {
        if (response && response.status === 200) {
          cache.put(e.request, response.clone());
        }
        return response;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
