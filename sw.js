// Service worker: cache-first for card images.
//
// Keeps every image we've ever successfully fetched, keyed by full URL
// (including the ?v=<multiverseId> stamp), so switching decks — or going
// offline entirely — still paints the cards you've already seen. The cache
// is cleared explicitly from the UI ("Clear images" button).

const IMG_CACHE = 'rev-img-v1';
// Hosts whose /img/ URLs we own: Revolution's cards live under cajun's
// repo, Voyager's under voyager-mtg.github.io.
const IMG_HOSTS = [
  'raw.githubusercontent.com/cajunwritescode/Revolution',
  'voyager-mtg.github.io',
];

self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = req.url;
  if (!url.includes('/img/')) return;
  if (!IMG_HOSTS.some(h => url.includes(h))) return;

  event.respondWith((async () => {
    const cache = await caches.open(IMG_CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    try {
      const resp = await fetch(req);
      // Opaque responses (type === 'opaque', status 0) are fine to store and
      // fine to use as <img> sources; we just can't introspect them.
      if (resp && (resp.ok || resp.type === 'opaque')) {
        cache.put(req, resp.clone()).catch(() => {});
      }
      return resp;
    } catch (err) {
      // Offline and no cached copy — let the <img> error handler run.
      throw err;
    }
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'clear-img-cache') {
    event.waitUntil(caches.delete(IMG_CACHE));
  }
});
