import type {
  AgencyInfo,
  Departure,
  FeedStatus,
  Itinerary,
  Place,
  PlanResponse,
  RouteSummary,
  ServiceAlert,
  StopSummary,
  Vehicle,
} from '@shared/api.ts';

export type {
  AgencyInfo,
  Departure,
  FeedStatus,
  Itinerary,
  Leg,
  Mode,
  Place,
  PlanResponse,
  RouteSummary,
  ServiceAlert,
  StopSummary,
  TransitLeg,
  Vehicle,
  WalkLeg,
} from '@shared/api.ts';

export interface StopDetail {
  stop: StopSummary;
  groupedStopIds: string[];
  departures: Departure[];
  alerts: ServiceAlert[];
}

export interface RouteDetail {
  route: RouteSummary;
  directions: {
    directionId: number;
    headsign: string;
    stops: StopSummary[];
    geometry: [number, number][];
  }[];
  alerts: ServiceAlert[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Where a user-chosen API address is remembered. */
const API_OVERRIDE_KEY = 'livetrains.apiUrl';

/**
 * Resolves which API server to talk to.
 *
 * Three sources, in order of precedence:
 *
 *  1. A runtime override the user set in the app. This is what makes a static
 *     deployment (GitHub Pages) usable: the same published page can be pointed
 *     at a hosted API, at a laptop running `npm run dev`, or at anything else,
 *     without rebuilding.
 *  2. `VITE_API_URL`, baked in at build time for a known deployment.
 *  3. The page's own origin, which is correct for local development and for the
 *     single-process production mode where one server serves both.
 *
 * Deliberately read from localStorage rather than a query parameter: a `?api=`
 * link would let anyone hand someone a URL that silently points the app at a
 * server of their choosing.
 */
export function getApiBase(): string {
  try {
    const override = window.localStorage.getItem(API_OVERRIDE_KEY);
    if (override) return override.replace(/\/$/, '');
  } catch {
    // Private browsing can throw on access; fall through to the defaults.
  }
  const built = import.meta.env.VITE_API_URL?.trim();
  if (built) return built.replace(/\/$/, '');
  return window.location.origin;
}

/** Stores the API address to use, or clears it when given null. */
export function setApiBase(url: string | null): void {
  try {
    if (url === null) window.localStorage.removeItem(API_OVERRIDE_KEY);
    else window.localStorage.setItem(API_OVERRIDE_KEY, url.trim().replace(/\/$/, ''));
  } catch {
    // Nothing useful to do if storage is unavailable.
  }
}

/** True when the app is talking to a server other than the one that served it. */
export function isRemoteApi(): boolean {
  return getApiBase() !== window.location.origin;
}

async function get<T>(path: string, params?: Record<string, string | number | undefined>, signal?: AbortSignal): Promise<T> {
  const url = new URL(path, `${getApiBase()}/`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, { signal });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // A non-JSON error body is not worth reporting in detail.
    }
    throw new ApiError(message, response.status);
  }
  return (await response.json()) as T;
}

export const api = {
  status: (signal?: AbortSignal) => get<FeedStatus>('/api/status', undefined, signal),
  agency: (signal?: AbortSignal) => get<AgencyInfo>('/api/agency', undefined, signal),
  routes: (signal?: AbortSignal) => get<RouteSummary[]>('/api/routes', undefined, signal),
  route: (routeId: string, signal?: AbortSignal) =>
    get<RouteDetail>(`/api/routes/${encodeURIComponent(routeId)}`, undefined, signal),

  nearbyStops: (lat: number, lon: number, radius = 800, limit = 20, signal?: AbortSignal) =>
    get<StopSummary[]>('/api/stops/nearby', { lat, lon, radius, limit }, signal),

  stopsWithin: (bbox: [number, number, number, number], limit = 300, signal?: AbortSignal) =>
    get<StopSummary[]>('/api/stops/within', { bbox: bbox.join(','), limit }, signal),

  stop: (stopId: string, limit = 15, signal?: AbortSignal) =>
    get<StopDetail>(`/api/stops/${encodeURIComponent(stopId)}`, { limit }, signal),

  vehicles: (signal?: AbortSignal) =>
    get<{ vehicles: Vehicle[]; timestamp: number | null }>('/api/vehicles', undefined, signal),

  geocode: (q: string, near?: { lat: number; lon: number }, signal?: AbortSignal) =>
    get<Place[]>('/api/geocode', { q, lat: near?.lat, lon: near?.lon }, signal),

  reverseGeocode: (lat: number, lon: number, signal?: AbortSignal) =>
    get<Place>('/api/reverse-geocode', { lat, lon }, signal),

  plan: (
    params: {
      fromLat: number;
      fromLon: number;
      toLat: number;
      toLon: number;
      departAt?: number;
      arriveBy?: boolean;
      maxWalk?: number;
      maxTransfers?: number;
    },
    signal?: AbortSignal,
  ) =>
    get<PlanResponse>(
      '/api/plan',
      {
        fromLat: params.fromLat,
        fromLon: params.fromLon,
        toLat: params.toLat,
        toLon: params.toLon,
        departAt: params.departAt,
        arriveBy: params.arriveBy ? 'true' : undefined,
        maxWalk: params.maxWalk,
        maxTransfers: params.maxTransfers,
      },
      signal,
    ),

  alerts: (signal?: AbortSignal) => get<{ alerts: ServiceAlert[] }>('/api/alerts', undefined, signal),
};

export type ItineraryList = Itinerary[];
