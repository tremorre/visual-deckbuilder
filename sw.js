
const IMG_CACHE = 'rev-img-v1';
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
      if (resp && (resp.ok || resp.type === 'opaque')) {
        cache.put(req, resp.clone()).catch(() => {});
      }
      return resp;
    } catch (err) {
      throw err;
    }
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'clear-img-cache') {
    event.waitUntil(caches.delete(IMG_CACHE));
  }
});
