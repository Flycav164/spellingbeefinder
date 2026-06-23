var CACHE = 'sbf-v5';
var ASSETS = [
  '/',
  '/index.html',
  '/answers.html',
  '/about.html',
  '/contact.html',
  '/disclaimer.html',
  '/privacy.html',
  '/gear.html',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.json',
  '/answers/spelling-bee-june-13-2026.html',
  '/answers/spelling-bee-june-14-2026.html',
  '/answers/spelling-bee-june-15-2026.html',
  '/answers/spelling-bee-june-16-2026.html',
  '/answers/spelling-bee-june-17-2026.html',
  '/answers/spelling-bee-june-18-2026.html',
  '/answers/spelling-bee-june-19-2026.html',
  '/answers/spelling-bee-june-20-2026.html',
  '/answers/spelling-bee-june-21-2026.html',
  '/answers/spelling-bee-june-22-2026.html',
  '/spelling-bee-buddy.html',
  '/spelling-bee-solver.html',
  '/spelling-bee-words.html'
];
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(c) { return c.addAll(ASSETS); })
  );
  self.skipWaiting();
});
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k){return k!==CACHE;}).map(function(k){return caches.delete(k);}));
    })
  );
  self.clients.claim();
});
self.addEventListener('fetch', function(e) {
  if(e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      return cached || fetch(e.request).then(function(resp) {
        return resp;
      }).catch(function() { return caches.match('/index.html'); });
    })
  );
});
