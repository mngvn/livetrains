import { decodePolyline } from './polyline.ts';

/**
 * Real walking directions, over a real street network.
 *
 * The planner measures walks geometrically — a straight line, corrected for
 * street circuity — because it has to weigh thousands of candidate stop pairs
 * and cannot afford a routing call for each. That is fine for *choosing* a
 * trip, and wrong for *drawing* one: a straight line between a bus stop and a
 * platform cuts through buildings, over the Mississippi, and across the middle
 * of I-94, which is not a walk anyone can take.
 *
 * So the chosen itineraries get their walking legs re-routed properly. This is
 * how trip planners generally do it: estimate to search, route to present. A
 * plan has two to four walking legs, so it costs a handful of requests rather
 * than thousands.
 *
 * Everything here degrades to the straight line it replaced. A router that is
 * unreachable, slow, rate-limited or nonsense leaves the app exactly as it was
 * before this module existed.
 */

export interface WalkPath {
  /** [lon, lat] along the street network. */
  geometry: [number, number][];
  /** Metres along that path. */
  distanceMeters: number;
  /** Seconds, as the router reckons them. */
  durationSeconds: number;
}

export interface LatLon {
  lat: number;
  lon: number;
}

/**
 * The public Valhalla run by FOSSGIS for the OpenStreetMap community.
 *
 * Keyless and CORS-enabled, which is what makes real walking directions
 * possible from a static site with no server and no sign-up. It is a demo
 * endpoint: fine for one person's map, not something to point real traffic at.
 * `VITE_WALK_ROUTER_URL` moves this to your own Valhalla; an empty value turns
 * re-routing off and restores straight lines.
 */
const DEFAULT_ROUTER = 'https://valhalla1.openstreetmap.de/route';

/** Valhalla encodes shapes at six decimal places, not Google's five. */
const VALHALLA_PRECISION = 6;

/** Give up rather than leave a rider watching a spinner. */
const TIMEOUT_MS = 6_000;

/**
 * Longest walk worth routing.
 *
 * Beyond this the leg is almost certainly the app offering a walk in place of
 * a bus, where the shape of the path matters much less than the fact that it
 * is a long way, and the request is proportionally slower.
 */
const MAX_ROUTED_METERS = 5_000;

/**
 * Walks remembered at once. Transfers repeat, so a few hundred cover a day's
 * planning; beyond that the least recently used go, rather than a long
 * session holding every path it ever drew.
 */
const CACHE_SIZE = 300;

/** How long a refusal is believed before the router is asked again. */
const FAILURE_TTL_MS = 5 * 60_000;

export function walkRouterUrl(): string {
  const configured = import.meta.env.VITE_WALK_ROUTER_URL;
  return configured === undefined ? DEFAULT_ROUTER : configured.trim();
}

/**
 * Rounds a coordinate to about a tenth of a metre for cache keys.
 *
 * Two riders walking from the same platform should share one answer; two
 * queries differing in the fifteenth decimal place are the same query.
 */
function key(from: LatLon, to: LatLon): string {
  const r = (n: number) => n.toFixed(6);
  return `${r(from.lat)},${r(from.lon)}>${r(to.lat)},${r(to.lon)}`;
}

/**
 * Walking directions, cached while the page is open.
 *
 * Transfers repeat heavily — the same two platforms, every plan through that
 * station — so the cache does most of the work after the first few trips.
 * Failures are cached too, as `null`: a router that just refused is not going
 * to be persuaded by asking again for every leg of every subsequent plan —
 * but only for a few minutes, so a phone that was briefly offline gets real
 * paths again once it is back.
 */
export class WalkRouter {
  private readonly cache = new Map<string, { path: Promise<WalkPath | null>; failedAt?: number }>();

  constructor(private readonly url = walkRouterUrl()) {}

  get enabled(): boolean {
    return this.url.length > 0;
  }

  /** Walks currently remembered, for tests. */
  get cached(): number {
    return this.cache.size;
  }

  /**
   * Routes one walk, or resolves null to mean "use the straight line".
   *
   * Never rejects: a walking path is an improvement to a plan that already
   * works, so a failure here must not fail the plan.
   */
  route(from: LatLon, to: LatLon, straightMeters: number): Promise<WalkPath | null> {
    if (!this.enabled || straightMeters > MAX_ROUTED_METERS) return Promise.resolve(null);

    const cacheKey = key(from, to);
    const hit = this.cache.get(cacheKey);
    if (hit && (hit.failedAt === undefined || Date.now() - hit.failedAt < FAILURE_TTL_MS)) {
      // Most recently used goes to the back of the line for eviction.
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, hit);
      return hit.path;
    }

    const entry: { path: Promise<WalkPath | null>; failedAt?: number } = {
      path: this.fetchRoute(from, to)
        .catch((err: unknown) => {
          // Expected often enough — offline, rate-limited, CORS, a timeout —
          // that it is not worth more than a debug line.
          console.debug('livetrains: walking directions unavailable', err);
          return null;
        })
        .then((path) => {
          if (path === null) entry.failedAt = Date.now();
          return path;
        }),
    };
    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, entry);
    while (this.cache.size > CACHE_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return entry.path;
  }

  private async fetchRoute(from: LatLon, to: LatLon): Promise<WalkPath | null> {
    const query = {
      locations: [
        { lat: from.lat, lon: from.lon, type: 'break' },
        { lat: to.lat, lon: to.lon, type: 'break' },
      ],
      costing: 'pedestrian',
      // Sidewalks and crossings are the whole point; stairs are fine on foot.
      costing_options: { pedestrian: { use_ferry: 0 } },
      directions_type: 'none',
      units: 'kilometers',
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${this.url}?json=${encodeURIComponent(JSON.stringify(query))}`, {
        signal: controller.signal,
      });
      if (!response.ok) return null;
      return readValhalla(await response.json());
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Reads a Valhalla route response.
 *
 * Written defensively because the response is external and this is not worth
 * breaking the page over: anything unexpected becomes null, which means the
 * straight line stays.
 */
export function readValhalla(body: unknown): WalkPath | null {
  if (typeof body !== 'object' || body === null) return null;
  const trip = (body as { trip?: unknown }).trip;
  if (typeof trip !== 'object' || trip === null) return null;

  const legs = (trip as { legs?: unknown }).legs;
  if (!Array.isArray(legs) || legs.length === 0) return null;

  const geometry: [number, number][] = [];
  for (const leg of legs) {
    const shape = (leg as { shape?: unknown }).shape;
    if (typeof shape !== 'string') continue;
    const points = decodePolyline(shape, VALHALLA_PRECISION);
    // Consecutive legs repeat the point they meet at.
    geometry.push(...(geometry.length > 0 ? points.slice(1) : points));
  }
  if (geometry.length < 2) return null;

  const summary = (trip as { summary?: { length?: unknown; time?: unknown } }).summary ?? {};
  const km = typeof summary.length === 'number' ? summary.length : null;
  const seconds = typeof summary.time === 'number' ? summary.time : null;
  if (km === null || seconds === null || !Number.isFinite(km) || !Number.isFinite(seconds)) {
    return null;
  }

  return {
    geometry,
    distanceMeters: Math.round(km * 1_000),
    durationSeconds: Math.round(seconds),
  };
}
