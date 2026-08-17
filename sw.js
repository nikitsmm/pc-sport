/* ПЦ Спорт — service worker.
   Оболочка приложения кешируется, запросы к API Яндекса идут только по сети. */

var CACHE = 'pcsport-v4';
var SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'storage.js',
  'video.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);

  if (e.request.method !== 'GET') return;
  if (url.hostname.indexOf('yandex.net') !== -1 || url.hostname.indexOf('yandex.ru') !== -1) return;

  /* шрифты и оболочка: сначала кеш, потом сеть */
  e.respondWith(
    caches.match(e.request).then(function (hit) {
      if (hit) return hit;
      return fetch(e.request).then(function (res) {
        if (res && res.status === 200 && (url.origin === location.origin || url.hostname.indexOf('gstatic') !== -1 || url.hostname.indexOf('googleapis') !== -1)) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        }
        return res;
      }).catch(function () { return caches.match('index.html'); });
    })
  );
});
