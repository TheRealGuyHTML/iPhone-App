/**
 * service-worker.js – App-Shell-Precaching (cache-first) + Offline-Support
 * + Push-/Notification-Handling für Erinnerungen.
 *
 * Hinweis: Echte "Web Push" (Zustellung bei geschlossener App) verlangt laut
 * Spezifikation einen Push-Server, der über den Push-Dienst (z.B. Apples
 * Push-Service) verschlüsselte Nachrichten an den Browser sendet – das ist
 * technisch NICHT ohne Backend möglich. Da Kernroutine bewusst ohne Server
 * arbeitet, nutzen wir stattdessen "self.registration.showNotification()",
 * ausgelöst durch einen Timer, solange die App im Hintergrund/Vordergrund
 * lebt (Best-Effort-Erinnerung). Der 'push'-Handler bleibt vorbereitet,
 * falls später ein optionaler eigener Push-Server ergänzt wird.
 */

const CACHE_NAME = 'kernroutine-shell-v1';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './db.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Cache-first für statische Assets, Netzwerk-Fallback nur falls nötig
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});

// Lokale Erinnerung anzeigen (vom Client via postMessage angestoßen)
self.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg && msg.type === 'SHOW_REMINDER') {
    self.registration.showNotification(msg.title, {
      body: msg.body,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      tag: msg.tag || 'kernroutine-reminder',
      renotify: true,
      data: { goalId: msg.goalId }
    });
  }
});

// Vorbereitet für optionalen zukünftigen Push-Server (VAPID)
self.addEventListener('push', (event) => {
  let payload = { title: 'Kernroutine', body: 'Zeit für deine Routine.' };
  try { payload = event.data ? event.data.json() : payload; } catch (e) {}
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png'
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clientsArr) => {
      if (clientsArr.length > 0) {
        clientsArr[0].focus();
        clientsArr[0].postMessage({ type: 'NOTIFICATION_CLICK', goalId: event.notification.data && event.notification.data.goalId });
      } else {
        self.clients.openWindow('./index.html');
      }
    })
  );
});
