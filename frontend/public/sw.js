// ============================================================
// MATHX Service Worker
// ------------------------------------------------------------
// Strategy:
//   - Network-first for navigation (HTML) so new deploys are
//     picked up immediately and never cause a stale-asset 404.
//   - Cache-first for static images / icons (logo, manifest).
//   - All other requests pass straight through to the network
//     (we never want to cache hashed JS/CSS bundles or API calls).
//
// Lifecycle:
//   - skipWaiting()  → new SW activates immediately
//   - clients.claim() → new SW takes control of open tabs
//   - activate handler → deletes any old cache versions
//
// IMPORTANT: bump CACHE_VERSION on every release that changes
// the structure of cached assets.
// ============================================================

const CACHE_VERSION = 'sca-v3';
const STATIC_ASSETS = [
    '/manifest.json',
    '/logo.png',
];

// ── Install ───────────────────────────────────────────────────
self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_VERSION).then((cache) => cache.addAll(STATIC_ASSETS))
    );
});

// ── Activate: delete every cache that isn't the current one ──
self.addEventListener('activate', (event) => {
    event.waitUntil(
        (async () => {
            const keys = await caches.keys();
            await Promise.all(
                keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
            );
            await self.clients.claim();
        })()
    );
});

// ── Fetch ─────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
    const req = event.request;

    // Only handle GET. Never intercept POST/PUT/etc — those are API calls.
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    // Pass through cross-origin and API calls untouched.
    if (url.origin !== self.location.origin) return;
    if (url.pathname.startsWith('/api/') ||
        url.pathname.startsWith('/solve') ||
        url.pathname.startsWith('/study/') ||
        url.pathname.startsWith('/ocr') ||
        url.pathname.startsWith('/hints') ||
        url.pathname.startsWith('/generate_title') ||
        url.pathname.startsWith('/admin')) {
        return;
    }

    // Navigation requests (HTML) → network-first.
    // This guarantees button IDs in the HTML always match the latest app.js.
    if (req.mode === 'navigate' || req.destination === 'document') {
        event.respondWith(
            fetch(req).catch(() => caches.match(req).then((r) => r || caches.match('/')))
        );
        return;
    }

    // Static assets we explicitly precached → cache-first.
    if (STATIC_ASSETS.includes(url.pathname)) {
        event.respondWith(
            caches.match(req).then((cached) => cached || fetch(req))
        );
        return;
    }

    // Everything else (hashed JS/CSS bundles) → straight to network.
    // We must NEVER cache these — the file names change every deploy.
});
