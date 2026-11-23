'use strict';
/* Tiny offline helper. Network first, cached copy only as a fallback, so a new
   deploy is never stuck behind an old cached page. Only same-origin GETs. */
const CACHE = 'cyburrhunee-v3';
const CORE = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', function(event){
  event.waitUntil(
    caches.open(CACHE).then(function(cache){ return cache.addAll(CORE); })
      .then(function(){ return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){ return k !== CACHE; })
        .map(function(k){ return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(event){
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req).then(function(res){
      if (res && res.ok){
        const copy = res.clone();
        caches.open(CACHE).then(function(cache){ return cache.put(req, copy); });
      }
      return res;
    }).catch(function(){
      return caches.match(req).then(function(hit){ return hit || caches.match('/index.html'); });
    })
  );
});
