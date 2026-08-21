/* ПЦ Спорт — service worker.

   Раньше файлы оболочки отдавались "кэш сначала, потом сеть" — это и
   было причиной, что после каждого обновления на GitHub люди видели
   старую версию, пока вручную не чистили данные сайта. Теперь наоборот:
   "сеть сначала, кэш — только как запасной вариант офлайн". Пока
   телефон в сети, всегда грузится свежее; кэш нужен только когда сети
   вообще нет. */

var CACHE = 'pcsport-v43';
var SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'storage.js',
  'video.js',
  'log.js',
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

  var isFont = url.hostname.indexOf('gstatic') !== -1 || url.hostname.indexOf('googleapis') !== -1;

  if (isFont) {
    /* Шрифты меняются редко — тут кэш сначала оправдан. */
    e.respondWith(
      caches.match(e.request).then(function (hit) {
        if (hit) return hit;
        return fetch(e.request).then(function (res) {
          if (res && res.status === 200) {
            var copy = res.clone();
            caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
          }
          return res;
        });
      })
    );
    return;
  }

  /* Файлы самого приложения (index.html, app.js, styles.css, ...):
     сеть сначала. Кэш обновляется при каждом удачном запросе и служит
     только запасным вариантом, если телефон офлайн. */
  e.respondWith(
    fetch(e.request).then(function (res) {
      if (res && res.status === 200) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(e.request).then(function (hit) { return hit || caches.match('index.html'); });
    })
  );
});

/* ============================================================
   Push-уведомления. Приходят даже когда приложение полностью закрыто —
   этим Push API отличается от Notification API, который работал только
   пока вкладка жива хотя бы в фоне. На iPhone работает только для
   приложения, добавленного на «Экран Домой» (см. backend/index.py).
   ============================================================ */
self.addEventListener('push', function (e) {
  var data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) {}
  var title = data.title || 'ПЦ Спорт';

  e.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || 'Новое сообщение',
      tag: data.tag || 'pcsport-chat',
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      renotify: true
    })
  );
});

/* Тап по самому уведомлению — открывает приложение (или переключает
   на уже открытую вкладку, если она есть, вместо нового окна). */
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if ('focus' in list[i]) return list[i].focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});
