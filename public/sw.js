/**
 * Service Worker für das Stimmgerät.
 *
 * Chrome auf Android legt nur dann eine echte App (WebAPK ohne URL-Leiste) an,
 * wenn Manifest *und* ein Service Worker vorhanden sind. Nebeneffekt: die App
 * startet offline.
 *
 * Strategie:
 *   - Navigationen: erst Netz, dann Cache  → Updates kommen sofort an.
 *   - /assets/*:    erst Cache, dann Netz  → Dateinamen sind gehasht, also
 *                                            unveränderlich.
 *   - Rest (Icons): Cache, im Hintergrund aktualisieren.
 */

const VERSION = 'v1';
const CACHE = `stimmgeraet-${VERSION}`;

// Relativ zur sw.js aufgelöst – funktioniert auch unter /<repo-name>/ auf
// GitHub Pages.
const SHELL = ['./', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('./', copy));
          return response;
        })
        .catch(() => caches.match('./').then((hit) => hit ?? Response.error())),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => hit ?? Response.error());

      // Gehashte Build-Assets ändern sich nie – Cache-Treffer sofort ausliefern.
      return hit ?? network;
    }),
  );
});
