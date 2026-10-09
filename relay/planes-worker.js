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
 * ALLOWED_ORIGINS is a browser control: browsers send an honest Origin header
 * and enforce the answer, so other sites cannot use this relay from their
 * pages. A script outside a browser can claim any origin it likes; what
 * keeps that cheap is the shared five-second cache, not the origin check.
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

/**
 * The fields the map reads from each aircraft. A feed sends forty-odd per
 * aircraft (signal strength, message counts, accuracy codes); passing on
 * only these makes each answer about a third the size, which is what a free
 * host's bandwidth allowance is measured in.
 */
const KEEP = [
  'hex', 'flight', 'r', 't', 'desc', 'ownOp', 'category', 'lat', 'lon', 'alt_baro', 'alt_geom', 'gs',
  'track', 'true_heading', 'mag_heading', 'baro_rate', 'geom_rate', 'squawk', 'emergency', 'seen_pos', 'seen',
];

function trim(body) {
  const list = Array.isArray(body.ac) ? 'ac' : Array.isArray(body.aircraft) ? 'aircraft' : null;
  if (!list) return { now: body.now };
  return {
    now: body.now,
    [list]: body[list].map((a) => {
      const kept = {};
      for (const key of KEEP) if (a && a[key] !== undefined) kept[key] = a[key];
      return kept;
    }),
  };
}

/**
 * The last answer for each area, held in memory and shared by every request
 * this copy of the relay serves, so a crowd of visitors costs the feed one
 * request every few seconds. (In memory rather than a platform cache so it
 * works the same on Cloudflare, Deno and Node.)
 */
const answers = new Map();
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
    // The answer is data, never something for a browser to sniff into a page.
    'x-content-type-options': 'nosniff',
    ...(origin === '*' ? {} : { vary: 'Origin' }),
  };
}

function json(body, status, origin, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(origin), ...extra },
  });
}

const CACHE_HEADER = { 'cache-control': `public, max-age=${CACHE_SECONDS}` };

/**
 * A held answer with its clock moved on by however long it was held, so the
 * map reads its positions as exactly as old as they are. The feeds keep time
 * in milliseconds (adsb.lol) or seconds (adsb.fi).
 */
function aged({ at, body }) {
  const ms = Date.now() - at;
  if (typeof body.now !== 'number') return body;
  return { ...body, now: body.now + (body.now > 1e11 ? ms : ms / 1000) };
}

export default {
  async fetch(request, env) {
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

    const key = area.join('/');
    const held = answers.get(key);
    if (held && Date.now() - held.at < CACHE_SECONDS * 1000) return json(aged(held), 200, origin, CACHE_HEADER);

    // Every feed's answer, so a failure says which refused and how.
    const failures = [];
    for (const feed of FEEDS) {
      try {
        const upstream = await fetch(feed.url(...area), {
          headers: { 'user-agent': 'livetrains-relay (+https://github.com/mngvn/livetrains)', accept: 'application/json' },
          signal: AbortSignal.timeout(8000),
        });
        if (!upstream.ok) throw new Error(`${feed.source} answered ${upstream.status}`);
        const body = { ...trim(await upstream.json()), source: feed.source };
        if (answers.size > 50) answers.clear();
        answers.set(key, { at: Date.now(), body });
        return json(body, 200, origin, CACHE_HEADER);
      } catch (err) {
        failures.push(err instanceof Error ? err.message : String(err));
      }
    }
    return json({ error: `No aircraft feed answered: ${failures.join('; ')}` }, 502, origin);
  },
};
