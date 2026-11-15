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
 * Asked with `?stream=1` it keeps the connection open and sends the answer
 * again every fifteen seconds, as Server-Sent Events. That is what makes a
 * free host's allowance last: hosts count requests, and a map left open then
 * costs one request for the whole visit instead of one every poll.
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

/** Fetches in flight, by area, so everyone asking at once shares the one. */
const asking = new Map();

/**
 * The aircraft over an area: `{ body }`, or `{ error }` when no feed answers.
 * A held answer under five seconds old is given again rather than asked for.
 */
function latest(area) {
  const key = area.join('/');
  const held = answers.get(key);
  if (held && Date.now() - held.at < CACHE_SECONDS * 1000) return Promise.resolve({ body: aged(held) });
  let pending = asking.get(key);
  if (!pending) {
    pending = askFeeds(area, key).finally(() => asking.delete(key));
    asking.set(key, pending);
  }
  return pending;
}

/** The feed that answered last, asked first next time. */
let preferred = 0;

async function askFeeds(area, key) {
  // Every feed's answer, so a failure says which refused and how.
  const failures = [];
  for (let i = 0; i < FEEDS.length; i++) {
    const index = (preferred + i) % FEEDS.length;
    const feed = FEEDS[index];
    try {
      const upstream = await fetch(feed.url(...area), {
        headers: { 'user-agent': 'livetrains-relay (+https://github.com/mngvn/livetrains)', accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!upstream.ok) throw new Error(`${feed.source} answered ${upstream.status}`);
      const body = { ...trim(await upstream.json()), source: feed.source };
      if (answers.size > 50) answers.clear();
      answers.set(key, { at: Date.now(), body });
      // A feed that is timing out costs eight seconds every time it is
      // asked first, so stay with the one that works.
      preferred = index;
      return { body };
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { error: `No aircraft feed answered: ${failures.join('; ')}` };
}

/** How often a stream sends the sky again: the rhythm the map used to poll at. */
const STREAM_SECONDS = 15;

/**
 * How long one stream runs before it says goodbye and the map opens another.
 * It bounds what a connection whose far end has silently gone can cost, and
 * gives a map that fell back to a second relay its turn to come home.
 */
const STREAM_MINUTES = 30;

/**
 * The same answer as a poll gets, sent again every `STREAM_SECONDS` for as
 * long as the page is listening.
 *
 * Every stream sends on the same beat of the clock, so however many are open
 * they share one request to the feed per beat rather than each making its
 * own. When the feeds are down it says so (`event: problem`) and keeps the
 * connection, since the next beat may well succeed.
 */
function stream(area, origin) {
  const encoder = new TextEncoder();
  const beat = STREAM_SECONDS * 1000;
  const until = Date.now() + STREAM_MINUTES * 60_000;
  let timer;
  let closed = false;
  const body = new ReadableStream({
    start(controller) {
      const write = (text) => controller.enqueue(encoder.encode(text));
      const send = async () => {
        const result = await latest(area);
        if (closed) return;
        try {
          if (result.body) write(`data: ${JSON.stringify(result.body)}\n\n`);
          else write(`event: problem\ndata: ${JSON.stringify({ error: result.error })}\n\n`);
          if (Date.now() >= until) {
            write('event: bye\ndata: {}\n\n');
            closed = true;
            controller.close();
            return;
          }
        } catch {
          // The page has gone and the stream with it.
          closed = true;
          return;
        }
        // On the next beat, or the one after when that is all but here.
        let wait = beat - (Date.now() % beat);
        if (wait < beat / 3) wait += beat;
        timer = setTimeout(send, wait);
      };
      // Tells the page how long to wait before reconnecting, should it drop.
      write('retry: 2000\n\n');
      send();
    },
    cancel() {
      closed = true;
      clearTimeout(timer);
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      // Never held or rewritten on the way: each event is for now.
      'cache-control': 'no-store, no-transform',
      'x-accel-buffering': 'no',
      ...corsHeaders(origin),
    },
  });
}

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request, env);
    if (origin === null) return new Response('Forbidden', { status: 403 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method !== 'GET') return json({ error: 'Only GET' }, 405, origin);

    const url = new URL(request.url);
    const match = PATH.exec(url.pathname);
    if (!match) return json({ error: 'Ask for /planes/{lat}/{lon}/{radius}' }, 404, origin);
    const lat = Number(match[1]);
    const lon = Number(match[2]);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return json({ error: 'No such place' }, 400, origin);
    // Two decimals is about a kilometre: close enough to share a cache.
    const area = [lat.toFixed(2), lon.toFixed(2), Math.min(MAX_RADIUS_NM, Math.max(1, Number(match[3])))];

    if (url.searchParams.has('stream')) return stream(area, origin);

    const result = await latest(area);
    if (result.body) return json(result.body, 200, origin, CACHE_HEADER);
    return json({ error: result.error }, 502, origin);
  },
};
