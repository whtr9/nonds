const CACHE_NAME = 'nds-pwa-v2.1';
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './storage.js',
    './manifest.webmanifest',
    './core/desmond.js',   // Было desmume.js
    './core/desmond.wasm'  // Было desmume.wasm
];

// Событие install: Открытие кэша и принудительное кэширование всех статических ассетов[cite: 1]
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('Кэширование файлов...');
            return cache.addAll(ASSETS_TO_CACHE);
        }).then(() => {
            // Вызов self.skipWaiting() для немедленной активации новой версии[cite: 1]
            return self.skipWaiting();
        })
    );
});

// Событие activate: Очистка старых версий кэша[cite: 1]
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('Удаление старого кэша:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => {
            // Вызов self.clients.claim() для немедленного контроля над клиентами[cite: 1]
            return self.clients.claim();
        })
    );
});

// Событие fetch: Стратегия Cache First, falling back to Network[cite: 1]
self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            // Запросы сначала ищутся в локальном кэше, что гарантирует мгновенный запуск[cite: 1]
            if (cachedResponse) {
                return cachedResponse;
            }
            return fetch(event.request);
        })
    );
});
