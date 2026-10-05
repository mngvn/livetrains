/**
 * livetrains aircraft relay — a Cloudflare Worker.
 *
 * The community ADS-B feeds the map's planes come from (adsb.lol, adsb.fi)
 * publish openly with no key, but send no CORS headers, so a page on a
 * static host cannot read them. This relays exactly one question — "which
 * aircraft are within this radius of this point?" — and adds the headers.
 *
 * It is not an open proxy: it answers that one path, asks only these feeds,
 * caps the radius, and rounds the centre so every visitor to one city shares
 * a cached answer (five seconds), however many tabs are open.
 *
 * Deploy (free tier is ample):
 *
 *   npx wrangler deploy relay/planes-worker.js --name livetrains-planes \
 *     --compatibility-date 2026-01-01
 *
 * then build the site with
 *
 *   VITE_PLANES_URL=https://livetrains-planes.<you>.workers.dev/planes/{lat}/{lon}/{radius}
 *
 * (on GitHub Pages: the repository variable PLANES_URL). To accept requests
 * only from your own site, set the variable ALLOWED_ORIGINS to a comma-
 * separated list of origins; by default any origin may ask.
 */

const FEEDS = [
  { source: 'adsb.lol', url: (lat, lon, nm) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${nm}` },
  { source: 'adsb.fi', url: (lat, lon, nm) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${nm}` },
];

/** A metro never needs more; the feeds themselves stop at 250. */
const MAX_RADIUS_NM = 100;
const CACHE_SECONDS = 5;
const PATH = /^\/planes\/(-?\d{1,2}(?:\.\d+)?)\/(-?\d{1,3}(?:\.\d+)?)\/(\d{1,3})$/;

/** The origin to allow, or null when this one is not welcome. */
function allowedOrigin(request, env) {
  const origin = request.headers.get('origin');
  const list = (env?.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) return '*';
  return origin && list.includes(origin) ? origin : null;
}

function corsHeaders(origin) {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-max-age': '86400',
    ...(origin === '*' ? {} : { vary: 'Origin' }),
  };
}

function json(body, status, origin, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(origin), ...extra },
  });
}

export default {
  async fetch(request, env, ctx) {
    const origin = allowedOrigin(request, env);
    if (origin === null) return new Response('Forbidden', { status: 403 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method !== 'GET') return json({ error: 'Only GET' }, 405, origin);

    const match = PATH.exec(new URL(request.url).pathname);
    if (!match) return json({ error: 'Ask for /planes/{lat}/{lon}/{radius}' }, 404, origin);
    const lat = Number(match[1]);
    const lon = Number(match[2]);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return json({ error: 'No such place' }, 400, origin);
    // Two decimals is about a kilometre: close enough to share a cache.
    const area = [lat.toFixed(2), lon.toFixed(2), Math.min(MAX_RADIUS_NM, Math.max(1, Number(match[3])))];

    const cache = typeof caches !== 'undefined' ? caches.default : null;
    const key = new Request(`https://planes-relay.invalid/${area.join('/')}`);
    const hit = cache ? await cache.match(key) : null;
    if (hit) return new Response(hit.body, { status: 200, headers: { ...Object.fromEntries(hit.headers), ...corsHeaders(origin) } });

    // Every feed's answer, so a failure says which refused and how.
    const failures = [];
    for (const feed of FEEDS) {
      try {
        const upstream = await fetch(feed.url(...area), {
          headers: { 'user-agent': 'livetrains-relay (+https://github.com/mngvn/livetrains)', accept: 'application/json' },
          signal: AbortSignal.timeout(8000),
        });
        if (!upstream.ok) throw new Error(`${feed.source} answered ${upstream.status}`);
        const body = await upstream.json();
        body.source = feed.source;
        const response = json(body, 200, origin, { 'cache-control': `public, max-age=${CACHE_SECONDS}` });
        if (cache) ctx?.waitUntil?.(cache.put(key, response.clone()));
        return response;
      } catch (err) {
        failures.push(err instanceof Error ? err.message : String(err));
      }
    }
    return json({ error: `No aircraft feed answered: ${failures.join('; ')}` }, 502, origin);
  },
};
