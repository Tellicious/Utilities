// Service worker for Utilities PWA
//
// Strategy: NETWORK-FIRST with cache fallback.
// On every page load, every request goes to the network first. If the
// network responds, we serve that (and refresh the cache copy). The cache
// is only used when offline. This means users always get the latest
// version when online — no need to reinstall the PWA to see updates.

const VERSION = 'utilities-v4-toolkit-polish';

// Minimal pre-cache: only what's needed to render *something* offline.
// Everything else gets cached opportunistically as it's fetched.
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) =>
      Promise.allSettled(
        PRECACHE_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] precache skip', url, err.message);
          })
        )
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Listen for an explicit "skipWaiting" message from the page —
// used to activate a pending SW immediately without waiting for
// all tabs to close.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Only handle same-origin requests; let everything else go straight to network.
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(networkFirst(req));
});

/**
 * Network-first: try the network. On success, update the cache and return
 * the fresh response. On failure (offline / network error), fall back to
 * any cached copy. If nothing's cached either, return a synthetic offline
 * response for navigations.
 */
async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  try {
    // `cache: 'no-store'` makes the browser bypass HTTP cache too,
    // so we always hit the actual server.
    const fresh = await fetch(request, { cache: 'no-store' });
    if (fresh && fresh.status === 200) {
      // Update cache in the background — don't await, so we return ASAP.
      cache.put(request, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (err) {
    // Network failed — try cache.
    const cached = await cache.match(request);
    if (cached) return cached;

    // For navigations, fall back to the shell.
    if (request.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }

    // Nothing we can do — return a stub so the fetch promise resolves.
    return new Response('Offline and no cached copy available.', {
      status: 503,
      statusText: 'Offline',
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}
