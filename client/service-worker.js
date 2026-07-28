var CACHE_NAME = 'snapdrop-cache-v3';
var urlsToCache = [
  'index.html',
  './',
  'styles.css',
  'scripts/network.js',
  'scripts/ui.js',
  'scripts/clipboard.js',
  'scripts/theme.js',
  'sounds/blop.mp3',
  'images/favicon-96x96.png'
];

self.addEventListener('install', function(event) {
  // Activate the updated worker immediately instead of waiting for all
  // old tabs to close — otherwise code changes never reach an open page.
  self.skipWaiting();
  // Perform install steps
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function(cache) {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
  );
});


self.addEventListener('fetch', function(event) {
  // Network-first, falling back to cache. Cache-first served stale JS and
  // kept code fixes from ever loading; network-first always delivers the
  // latest scripts while still working offline via the cache fallback.
  event.respondWith(
    fetch(event.request)
      .then(function(response) {
        if (response && response.ok && event.request.method === 'GET') {
          var copy = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, copy);
          });
        }
        return response;
      })
      .catch(function() {
        return caches.match(event.request);
      })
  );
});


self.addEventListener('activate', function(event) {
  console.log('Updating Service Worker...')
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames.filter(function(cacheName) {
          // Return true if you want to remove this cache,
          // but remember that caches are shared across
          // the whole origin
          return true
        }).map(function(cacheName) {
          return caches.delete(cacheName);
        })
      );
    }).then(function() {
      // Take control of already-open pages so the new worker (and fresh
      // scripts) apply without needing every tab to be closed first.
      return self.clients.claim();
    })
  );
});
