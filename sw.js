const CACHE = 'caribu-v14';
const ASSETS = [
  '/', '/styles.css',
  '/js/app.js', '/js/chart.js', '/js/heater.js', '/js/bms.js', '/js/victron.js', '/js/imou.js',
  '/js/history.js', '/js/weather.js', '/js/campsites.js', '/js/notifications.js', '/js/maintenance.js',
  '/icons/icon.svg', '/manifest.json',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow('/'));
});
