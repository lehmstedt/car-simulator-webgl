// Service worker of the installed app: lets the game start offline and instantly.
// Every same-origin file and the Google font are served from the cache when there,
// and refreshed from the network behind the scenes, so a new version shows up on
// the launch after it's published. No file list to keep up to date: the page sends
// the files it already loaded (see index.html), and the rest is cached as it's fetched.
const CACHE = 'car-sim-v1';
const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', 'manifest.webmanifest', 'icons/icon-192.png'])));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// The page's list of what it loaded before this worker was in charge.
self.addEventListener('message', (e) => {
  const urls = (e.data?.cache || []).filter(cacheable);
  e.waitUntil(caches.open(CACHE).then(async (c) => {
    for (const u of urls) if (!(await c.match(u))) await c.add(u).catch(() => {});
  }));
});

function cacheable(url) {
  const u = new URL(url, self.location);
  return u.origin === self.location.origin || FONTS.test(u.href);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || !cacheable(req.url)) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // The page itself is the same whatever the query (?debug).
    const key = req.mode === 'navigate' ? './' : req;
    const hit = await cache.match(key, { ignoreSearch: req.mode === 'navigate' });
    const fresh = fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') cache.put(key, res.clone());
      return res;
    });
    if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }
    return fresh;
  })());
});
