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

async function get<T>(path: string, params?: Record<string, string | number | undefined>, signal?: AbortSignal): Promise<T> {
  const url = new URL(path, window.location.origin);
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
