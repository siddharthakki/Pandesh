/*
 * Pandesh Mobile service worker: caches the app's own files so it opens (and can say "can't reach your PC") without
 * a connection. It never touches /api/: conversations, approvals, audio and pairing always go to the PC and are
 * never stored. The version below is filled in by the PC from the app files, so each build replaces the old cache.
 */
'use strict';

var VERSION = '__PANDESH_SHELL_VERSION__';
var CACHE = 'pandesh-shell-' + VERSION;
var SHELL = [
  '/',
  '/lib.js',
  '/app.js',
  '/app.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(SHELL.map(function (url) { return new Request(url, { cache: 'no-cache' }); })); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys
          .filter(function (key) { return key.indexOf('pandesh-shell-') === 0 && key !== CACHE; })
          .map(function (key) { return caches.delete(key); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

/** The cache key for a request this worker handles, or null to leave the request alone. */
function shellKey(request) {
  if (request.method !== 'GET') return null;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return null;
  if (url.pathname.indexOf('/api/') === 0) return null;
  // Every page address (including /?pair=CODE) is the same page: cache it as '/', so no code is ever stored.
  if (request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') return '/';
  return SHELL.indexOf(url.pathname) >= 0 ? url.pathname : null;
}

self.addEventListener('fetch', function (event) {
  var key = shellKey(event.request);
  if (!key) return;
  // Network first, so a new build shows at once; the cached copy only when the PC cannot be reached.
  event.respondWith(
    fetch(event.request).then(function (response) {
      if (response && response.ok && response.type === 'basic') {
        var copy = response.clone();
        caches.open(CACHE).then(function (cache) { return cache.put(key, copy); }).catch(function () { /* full storage */ });
      }
      return response;
    }).catch(function () {
      return caches.match(key).then(function (hit) {
        return hit || new Response('Pandesh is offline.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      });
    })
  );
});
