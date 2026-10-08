/* Shima World service worker: offline shell + versioned precache. */
const BUILD = '__BUILD_VERSION__';
const CACHE = 'shima-core-' + BUILD;

self.addEventListener('install', (e) => {
  // Does NOT skipWaiting: updates apply when the player presses UPDATE (or on next restart).
  e.waitUntil((async () => {
    const res = await fetch('./asset-manifest.json', { cache: 'no-store' });
    const m = await res.json();
    const cache = await caches.open(CACHE);
    const urls = ['./', ...Object.keys(m.bundles.core.files).map((p) => '.' + p)];
    let done = 0;
    for (const u of urls) {
      await cache.add(new Request(u, { cache: 'reload' }));
      done++;
      const clients = await self.clients.matchAll({ includeUncontrolled: true });
      clients.forEach((c) => c.postMessage({ type: 'progress', done, total: urls.length }));
    }
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('shima-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
  if (e.data === 'version') e.source && e.source.postMessage({ type: 'version', version: BUILD });
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.endsWith('asset-manifest.json')) return; // always network for update checks
  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try { return await fetch(req); }
    catch { return (await caches.match('./')) || Response.error(); }
  })());
});
