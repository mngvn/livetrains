import { fillPlaneUrl, planeArea, readPlanes } from '@shared/planes.ts';
import { getApiBase } from './api.ts';
import type { DataMode } from './dataSource.ts';
import type { PlaneFetcher } from './planeTracker.ts';

/**
 * Where the browser gets aircraft from.
 *
 * The community ADS-B feeds do not send CORS headers, so a page cannot read
 * them directly: something has to relay them. In server mode that is this
 * app's own API server. A static build needs a relay named at build time —
 * `VITE_PLANES_URL`, a URL template with `{lat}`, `{lon}` and `{radius}`, or
 * several separated by spaces to fail over between — such as those in
 * `relay/`.
 */

const OVERRIDE_KEY = 'livetrains.planesUrl';

/**
 * The aircraft feed URL template, or null when there is nowhere to ask.
 *
 * A value stored in the browser wins, like the API address does, so the
 * published page can be pointed at a relay without a rebuild. An empty value,
 * stored or built in, turns planes off.
 */
export function planeFeedTemplate(mode: DataMode): string | null {
  try {
    const stored = window.localStorage.getItem(OVERRIDE_KEY);
    if (stored !== null) return stored.trim() || null;
  } catch {
    // Storage unavailable; fall through to the build's choice.
  }
  const built = import.meta.env.VITE_PLANES_URL;
  if (built !== undefined) return built.trim() || null;
  if (mode === 'server') return `${getApiBase()}/api/planes`;
  return null;
}

/**
 * The relay addresses in a template: one, or several separated by spaces or
 * commas, tried in turn.
 */
export function planeFeedUrls(template: string): string[] {
  return template.split(/[\s,]+/).filter(Boolean);
}

/**
 * Asks the feed for every aircraft over an agency's area.
 *
 * Given several relays, it keeps to the one that last answered and moves on
 * to the next the moment it fails — out of its free allowance, asleep, or
 * down — so free tiers on different hosts add up rather than each being a
 * single point of failure.
 */
export function planeFetcher(
  template: string,
  bbox: [number, number, number, number],
  request: typeof fetch = (input, init) => fetch(input, init),
): PlaneFetcher {
  const area = planeArea(bbox);
  const urls = planeFeedUrls(template).map((t) => fillPlaneUrl(t, area));
  let preferred = 0;
  let movedAt = 0;
  return async (signal) => {
    // Listed first means preferred: after a spell on a fallback, try the
    // first again, in case it has woken up or its allowance has reset.
    if (preferred !== 0 && Date.now() - movedAt > RETRY_FIRST_MS) preferred = 0;
    let lastError: unknown = new Error('No aircraft relay is configured');
    for (let i = 0; i < urls.length; i++) {
      const index = (preferred + i) % urls.length;
      const url = urls[index];
      // Each relay gets a few seconds, so one that is asleep or stuck hands
      // over to the next rather than holding up the whole poll.
      const attempt = new AbortController();
      const abort = () => attempt.abort();
      signal.addEventListener('abort', abort);
      const timer = urls.length > 1 ? setTimeout(abort, RELAY_TIMEOUT_MS) : undefined;
      try {
        const response = await request(url, { signal: attempt.signal, cache: 'no-store' });
        if (!response.ok) throw new Error(`The aircraft feed answered ${response.status}`);
        const read = readPlanes(await response.json());
        if (index !== preferred) movedAt = Date.now();
        preferred = index;
        return { ...read, source: read.source ?? guessSource(url) };
      } catch (err) {
        // Giving up the whole poll is for the tracker to decide.
        if (signal.aborted) throw err;
        lastError = err;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      }
    }
    throw lastError;
  };
}

/** How long one of several relays gets before the next is tried. */
const RELAY_TIMEOUT_MS = 7_000;

/** How long to stay on a fallback before trying the first relay again. */
const RETRY_FIRST_MS = 5 * 60_000;

/** Which network a relayed feed came from, when the relay did not say: for the credit. */
function guessSource(url: string): string | undefined {
  const plain = decodeURIComponent(url);
  if (plain.includes('adsb.lol')) return 'adsb.lol';
  if (plain.includes('adsb.fi')) return 'adsb.fi';
  return undefined;
}
