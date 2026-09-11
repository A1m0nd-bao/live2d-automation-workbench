/* Serves a user-imported Cubism package from Cache Storage at same-origin URLs.
   The package is supplied by the page and is never uploaded to a server. */
const CACHE = 'morph-native-runtime-v1';

self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  const data = event.data || {};
  const reply = (payload) => event.ports[0]?.postMessage(payload);
  if (data.type === 'cache-runtime-package') {
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(data.files.map(async (file) => {
        await cache.put(file.url, new Response(file.bytes, {
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
        }));
      }));
      reply({ ok: true });
    })().catch((error) => reply({ ok: false, error: String(error) })));
  }
  if (data.type === 'clear-runtime-package') {
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE);
      await Promise.all((data.urls || []).map((url) => cache.delete(url)));
    })());
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.includes('/native-runtime/')) return;
  event.respondWith(caches.open(CACHE).then(async (cache) => (
    await cache.match(event.request) || new Response('Missing local Cubism package file.', { status: 404 })
  )));
});
