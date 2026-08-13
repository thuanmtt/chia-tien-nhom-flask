const CACHE_VERSION = 'v7';
const STATIC_CACHE = `chia-tien-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `chia-tien-runtime-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  '/',
  '/manifest.json',
  '/static/app.css',
  '/static/app.js',
  '/static/split.js',
  '/static/auth.js',
  '/static/icons/icon.svg',
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png',
  '/static/icons/apple-touch-icon.png',
  '/static/icons/favicon.ico',
  '/static/icons/favicon-96x96.png',
  '/static/banks.json'
];

// Asset lõi của app thay đổi theo mỗi lần deploy (không có hash trong tên
// file) → network-first để người dùng luôn nhận bản mới, offline vẫn có cache
const NETWORK_FIRST_PATHS = new Set([
  '/static/app.css',
  '/static/app.js',
  '/static/split.js',
  '/static/auth.js'
]);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== STATIC_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // API calls: network-first, fall back to cache if offline
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Navigation requests: network-first so users get the latest HTML
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, '/'));
    return;
  }

  // App core assets (JS/CSS): network-first to avoid serving stale code
  if (NETWORK_FIRST_PATHS.has(url.pathname)) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Static assets: cache-first
  event.respondWith(cacheFirst(request));
});

const PRECACHE_SET = new Set(PRECACHE_URLS);

// KHÔNG cache response cá nhân hóa: request kèm Authorization (vd
// /api/events/<code> trả can_edit/is_owner theo tài khoản) hay /api/my-events —
// offline không được phát lại dữ liệu của người dùng khác/phiên khác.
function shouldCacheResponse(request, url) {
  if (request.headers.get('Authorization')) return false;
  if (url.pathname === '/api/my-events') return false;
  return true;
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    const url = new URL(request.url);
    if (response.ok && shouldCacheResponse(request, url)) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    return cached || Response.error();
  }
}

async function networkFirst(request, fallbackUrl) {
  try {
    const response = await fetch(request);
    const url = new URL(request.url);
    if (response.ok && shouldCacheResponse(request, url)) {
      // Đường dẫn đã precache: ghi đè bản precache trong STATIC_CACHE —
      // nếu ghi vào RUNTIME_CACHE, lúc offline caches.match() sẽ tìm thấy
      // bản precache CŨ trong STATIC_CACHE trước và trả về bản ôi.
      const cacheName = PRECACHE_SET.has(url.pathname) ? STATIC_CACHE : RUNTIME_CACHE;
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (fallbackUrl) {
      const fallback = await caches.match(fallbackUrl);
      if (fallback) return fallback;
    }
    return Response.error();
  }
}
