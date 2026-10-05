import type { AgencyDefinition } from './agencies/index.js';
import { log } from './log.js';
import { mockPlanes } from './mock/planes.js';
import { fillPlaneUrl, planeArea, readPlanes, type PlaneArea, type PlanesResponse } from './shared/planes.js';

/**
 * The aircraft feeds asked, in order, until one answers.
 *
 * adsb.lol (data under ODbL) and adsb.fi both publish what their community
 * receivers hear, with no key, in the same format. Neither sends CORS
 * headers, which is why the browser cannot ask them itself and this relay
 * exists.
 */
export const DEFAULT_PLANE_FEEDS = [
  'https://api.adsb.lol/v2/point/{lat}/{lon}/{radius}',
  'https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{radius}',
];

/**
 * How long one answer is shared between clients.
 *
 * Every open tab polls every ten seconds; with this, a hundred of them cost
 * the upstream feed one request every few seconds rather than ten a second.
 */
const CACHE_MS = 4_000;

/**
 * Relays the aircraft over the agency's area to the browser.
 *
 * One fetch serves every client at once, and concurrent requests share the
 * one in flight. In mock mode the sky is simulated and nothing is fetched.
 */
export class PlaneRelay {
  private readonly area: PlaneArea;
  private cached: { at: number; response: PlanesResponse } | null = null;
  private inFlight: Promise<PlanesResponse> | null = null;
  /** The feed that answered last, tried first next time. */
  private preferred = 0;

  constructor(
    agency: AgencyDefinition,
    private readonly feeds: string[],
    private readonly mock: boolean,
  ) {
    this.area = planeArea(agency.bbox);
  }

  /** Whether there is anywhere to get aircraft from. */
  get enabled(): boolean {
    return this.mock || this.feeds.length > 0;
  }

  async planes(): Promise<PlanesResponse> {
    if (this.mock) return mockPlanes();
    if (!this.cached || Date.now() - this.cached.at >= CACHE_MS) {
      this.inFlight ??= this.fetchAny().finally(() => {
        this.inFlight = null;
      });
      await this.inFlight;
    }
    return this.aged();
  }

  /**
   * The cached answer with its clock moved on by however long it has been
   * held, so the browser reads its positions as exactly as old as they are
   * rather than as fresh.
   */
  private aged(): PlanesResponse {
    const { at, response } = this.cached!;
    return { ...response, now: response.now + (Date.now() - at) / 1000 };
  }

  private async fetchAny(): Promise<PlanesResponse> {
    let lastError: unknown = null;
    for (let i = 0; i < this.feeds.length; i++) {
      const index = (this.preferred + i) % this.feeds.length;
      const url = fillPlaneUrl(this.feeds[index], this.area);
      try {
        const response = await fetch(url, {
          headers: { 'user-agent': 'livetrains/0.1 (+https://github.com/mngvn/livetrains)', accept: 'application/json' },
          signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const read = readPlanes(await response.json());
        const result: PlanesResponse = { ...read, source: new URL(url).hostname.replace(/^(api|opendata)\./, '') };
        this.preferred = index;
        this.cached = { at: Date.now(), response: result };
        return result;
      } catch (err) {
        lastError = err;
        log.warn(`planes: ${new URL(url).hostname} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Every feed is down: keep serving the last answer for a minute, so a
    // blip upstream reads as a slightly old sky rather than an empty one.
    if (this.cached && Date.now() - this.cached.at < 60_000) return this.cached.response;
    const error = new Error(
      `No aircraft feed answered${lastError instanceof Error ? ` (${lastError.message})` : ''}`,
    ) as Error & { statusCode?: number };
    error.statusCode = 502;
    throw error;
  }
}
