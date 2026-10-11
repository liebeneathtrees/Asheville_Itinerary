/**
 * Asheville NC Travel Planner — Service Worker
 * Version: avl-v3.1
 *
 * Strategy:
 *   Shell (HTML + CDN scripts/styles): Network-first, cache fallback
 *   Map tiles (CartoDB):               Cache-first, max 500 tiles LRU
 *   Everything else:                   Network pass-through
 *
 * Requires HTTPS (or localhost) to activate — silently ignored on file://
 */

const SW_VERSION   = 'avl-v3.1';
const CACHE_SHELL  = SW_VERSION + '-shell';
const CACHE_TILES  = SW_VERSION + '-tiles';
const TILE_MAX     = 500;   // ~20 MB at ~40 KB/tile

// Files to precache on install
const SHELL_URLS = [
  './asheville_itinerary_v3.html',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/Sortable.min.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

// ── Install: precache shell ────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_SHELL)
      .then(cache => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] Install cache error (network unavailable?):', err))
  );
});

// ── Activate: delete old caches ────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k !== CACHE_SHELL && k !== CACHE_TILES)
          .map(k => { console.log('[SW] Deleting old cache:', k); return caches.delete(k); })
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: route by resource type ─────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Map tiles — Cache-first with LRU eviction cap
  if (isTileRequest(url)) {
    event.respondWith(tileStrategy(event.request));
    return;
  }

  // Shell resources — Network-first with cache fallback
  if (isShellRequest(url)) {
    event.respondWith(shellStrategy(event.request));
    return;
  }

  // Everything else (alltrails, nps.gov, external links) — network only
});

// ── Tile detection ─────────────────────────────────────────────────────────────
function isTileRequest(url) {
  return url.hostname.includes('cartocdn.com') ||
         url.hostname.includes('basemaps.cartocdn.com');
}

// ── Shell detection ────────────────────────────────────────────────────────────
function isShellRequest(url) {
  if (url.pathname.endsWith('.html')) return true;
  if (url.hostname === 'unpkg.com') return true;
  if (url.hostname === 'cdn.jsdelivr.net') return true;
  if (url.pathname.endsWith('.webmanifest')) return true;
  if (url.pathname.endsWith('.png')) return true;
  return false;
}

// ── Shell strategy: network-first, cache fallback ─────────────────────────────
async function shellStrategy(request) {
  try {
    const networkResp = await fetch(request);
    if (networkResp.ok) {
      const cache = await caches.open(CACHE_SHELL);
      cache.put(request, networkResp.clone());
    }
    return networkResp;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    // If the HTML itself is requested offline and not cached, return a minimal fallback
    if (request.url.endsWith('.html')) {
      return new Response(
        '<html><body style="font-family:sans-serif;padding:2rem;text-align:center;">' +
        '<h2>&#127963; Asheville Planner</h2>' +
        '<p>You appear to be offline. Open the planner while connected once to cache it for offline use.</p>' +
        '</body></html>',
        { headers: { 'Content-Type': 'text/html' } }
      );
    }
    throw new Error('Network unavailable and no cache hit for: ' + request.url);
  }
}

// ── Tile strategy: cache-first with LRU eviction ──────────────────────────────
async function tileStrategy(request) {
  const cache  = await caches.open(CACHE_TILES);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const networkResp = await fetch(request);
    if (networkResp.ok) {
      // LRU eviction: if over the cap, delete the oldest entry
      await evictOldestTileIfNeeded(cache);
      cache.put(request, networkResp.clone());
    }
    return networkResp;
  } catch {
    // Offline with no tile cached — return a 1x1 transparent PNG placeholder
    return new Response(
      atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
      { headers: { 'Content-Type': 'image/png' } }
    );
  }
}

async function evictOldestTileIfNeeded(cache) {
  try {
    const keys = await cache.keys();
    if (keys.length >= TILE_MAX) {
      // Delete the oldest cached tile (first in insertion order)
      await cache.delete(keys[0]);
    }
  } catch (e) {
    // Eviction failure is non-fatal
  }
}
