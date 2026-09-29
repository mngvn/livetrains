/*
 * livetrains service worker: the app, and the map you last looked at, with
 * no connection.
 *
 * What it keeps, and how:
 *   - The page itself: network first, so a new deploy is picked up the
 *     moment it is live, falling back to the last copy when offline.
 *   - The app's own scripts and styles: their file names change with every
 *     build, so a cached copy is never stale; served from cache first.
 *   - Map tiles, styles and fonts: served from cache while a fresh copy is
 *     fetched behind them, capped so a long pan across the planet cannot
 *     fill the phone.
 *
 * What it deliberately does not touch: realtime feeds (an old vehicle
 * position must never be served as a current one — the app keeps its own
 * clearly-dated last-known positions instead), the timetable archive (the
 * app caches that itself, with its own freshness rule), walking directions
 * and the API server.
 */

const SHELL = 'livetrains-shell-v1';
const MAP = 'livetrains-map-v1';
const MAX_MAP_ENTRIES = 3000;

const MAP_HOSTS = new Set(['tiles.openfreemap.org', 'server.arcgisonline.com']);

const scope = new URL(self.registration.scope);
const INDEX = scope.href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.add(new Request(INDEX, { cache: 'reload' })))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('livetrains-') && key !== SHELL && key !== MAP && !key.startsWith('livetrains-gtfs'))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/**
 * The page sends the files it actually loaded. Everything fetched before this
 * worker took control — the first visit's scripts, the engine worker — is
 * cached now, and files from earlier builds that this page no longer uses
 * are dropped.
 */
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'cache-assets' || !Array.isArray(data.urls)) return;
  const wanted = data.urls
    .map((u) => {
      try {
        return new URL(u, scope);
      } catch {
        return null;
      }
    })
    .filter((u) => u && u.origin === scope.origin && u.href.startsWith(scope.href) && isAsset(u))
    .map((u) => u.href);
  event.waitUntil(
    caches.open(SHELL).then(async (cache) => {
      await Promise.all(wanted.map((url) => cache.match(url).then((hit) => hit || cache.add(url)).catch(() => undefined)));
      // Only prune against a list that plainly describes a whole build; a
      // truncated one must not empty the cache.
      if (!wanted.some((u) => u.endsWith('.js')) || !wanted.some((u) => u.endsWith('.css'))) return;
      const keep = new Set(wanted);
      for (const request of await cache.keys()) {
        const url = new URL(request.url);
        if (isAsset(url) && !keep.has(url.href)) await cache.delete(request);
      }
    }),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === scope.origin) {
    if (!url.href.startsWith(scope.href) || url.pathname.includes('/api/') || url.pathname.endsWith('/sw.js')) return;
    if (request.mode === 'navigate') {
      event.respondWith(networkFirstPage(request));
      return;
    }
    if (isAsset(url)) {
      event.respondWith(cacheFirst(SHELL, request));
    }
    return;
  }

  if (MAP_HOSTS.has(url.hostname)) {
    event.respondWith(staleWhileRevalidate(MAP, request));
  }
});

/** Hashed build output: safe to serve from cache indefinitely. */
function isAsset(url) {
  return /\/assets\//.test(url.pathname);
}

async function networkFirstPage(request) {
  const cache = await caches.open(SHELL);
  try {
    const response = await fetch(request);
    // Every in-app URL is the same page with a different query string, so
    // one copy of the page serves them all offline.
    if (response.ok) await cache.put(INDEX, response.clone());
    return response;
  } catch (err) {
    const cached = (await cache.match(INDEX)) || (await cache.match(request, { ignoreSearch: true }));
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(name, request) {
  const cache = await caches.open(name);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

let mapWrites = 0;

async function staleWhileRevalidate(name, request) {
  const cache = await caches.open(name);
  const cached = await cache.match(request);
  const refresh = fetch(request)
    .then(async (response) => {
      if (response.ok && (response.type === 'cors' || response.type === 'basic')) {
        await cache.put(request, response.clone());
        if (++mapWrites % 100 === 0) await trim(cache, MAX_MAP_ENTRIES);
      }
      return response;
    })
    .catch(() => undefined);
  if (cached) {
    // Keep the refresh alive after the response is returned.
    refresh.catch(() => undefined);
    return cached;
  }
  const response = await refresh;
  if (response) return response;
  // Fail exactly as the network would have, so the map's own handling of an
  // unreachable basemap (falling back to a plain background) still applies.
  return Response.error();
}

/** Drops the oldest entries past a cap; keys come back in insertion order. */
async function trim(cache, max) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}
