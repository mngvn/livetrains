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
 * `VITE_PLANES_URL`, a URL template with `{lat}`, `{lon}` and `{radius}` —
 * such as the one-file Cloudflare Worker in `relay/`.
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

/** Asks the feed for every aircraft over an agency's area. */
export function planeFetcher(template: string, bbox: [number, number, number, number]): PlaneFetcher {
  const url = fillPlaneUrl(template, planeArea(bbox));
  return async (signal) => {
    const response = await fetch(url, { signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`The aircraft feed answered ${response.status}`);
    const read = readPlanes(await response.json());
    return { ...read, source: read.source ?? guessSource(url) };
  };
}

/** Which network a relayed feed came from, when the relay did not say: for the credit. */
function guessSource(url: string): string | undefined {
  const plain = decodeURIComponent(url);
  if (plain.includes('adsb.lol')) return 'adsb.lol';
  if (plain.includes('adsb.fi')) return 'adsb.fi';
  return undefined;
}
