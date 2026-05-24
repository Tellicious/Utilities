// Service worker for Utilities PWA
// Cache-first strategy: app shell + sub-app assets cached on install,
// updated on version bump.

const VERSION = 'utilities-v1';
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './assets/styles.css',
  './assets/app.js',
  './apps/resistor/index.html',
  './apps/resistor/resistor.css',
  './apps/resistor/resistor.js',
  './apps/resistor/camera.js',
  './apps/resistor/cv.js',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/icon-180.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => {
      return Promise.allSettled(
        SHELL_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] skip cache for', url, err.message);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        // Cache successful same-origin responses
        if (res && res.status === 200 && req.url.startsWith(self.location.origin)) {
          const clone = res.clone();
          caches.open(VERSION).then((cache) => cache.put(req, clone));
        }
        return res;
      }).catch(() => {
        // Offline fallback: try shell
        if (req.mode === 'navigate') return caches.match('./index.html');
      });
    })
  );
});
