import { api, getApiBase, type StopDetail, type RouteDetail } from './api.ts';
import { TransitEngine, type EngineStatus } from '../engine/client.ts';
import { resolveAgency } from '../engine/agency.ts';
import type {
  AgencyInfo,
  FeedStatus,
  Place,
  PlanResponse,
  RouteSummary,
  ServiceAlert,
  StopSummary,
  Vehicle,
} from './api.ts';

/**
 * One data interface, two backends.
 *
 * The app can get its data either from the Node API server or from the transit
 * engine running in a Web Worker in this same tab. Both answer identical
 * questions, so everything above this line is written once.
 *
 * Browser mode is what makes a static deployment possible: GitHub Pages cannot
 * run a server, but Metro Transit serves every feed with permissive CORS, so
 * the browser can do the whole job itself.
 */

export type DataMode = 'browser' | 'server';

const MODE_KEY = 'livetrains.dataMode';

/**
 * Chooses the backend.
 *
 * A stored preference wins, so the deployed page can be pointed at a local
 * server for debugging without a rebuild. Otherwise the build decides, which
 * lets the Pages build default to browser mode and local development default
 * to the server that `npm run dev` already starts.
 */
export function resolveMode(): DataMode {
  try {
    const stored = window.localStorage.getItem(MODE_KEY);
    if (stored === 'browser' || stored === 'server') return stored;
  } catch {
    // Storage can throw in private browsing; fall through to the build default.
  }
  return import.meta.env.VITE_DATA_MODE === 'browser' ? 'browser' : 'server';
}

export function setMode(mode: DataMode | null): void {
  try {
    if (mode === null) window.localStorage.removeItem(MODE_KEY);
    else window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Nothing useful to do.
  }
}

export interface DataSource {
  mode: DataMode;
  /** Starts background work. Only browser mode has any. */
  start(): void;
  /** Tears down background work. Named to avoid colliding with `stop(stopId)`. */
  dispose(): void;
  /** Load progress; server mode reports ready immediately. */
  onStatus(listener: (status: EngineStatus) => void): () => void;
  /** Live vehicle pushes. Only browser mode pushes; server mode uses SSE. */
  onVehicles(
    listener: (payload: { vehicles: Vehicle[]; timestamp: number | null; error: string | null }) => void,
  ): () => void;
  setRouteFilter(routeId?: string): void;
  refresh(hard?: boolean): void;

  status(signal?: AbortSignal): Promise<FeedStatus>;
  agency(signal?: AbortSignal): Promise<AgencyInfo>;
  routes(signal?: AbortSignal): Promise<RouteSummary[]>;
  route(routeId: string, signal?: AbortSignal): Promise<RouteDetail>;
  nearbyStops(lat: number, lon: number, radius?: number, limit?: number, signal?: AbortSignal): Promise<StopSummary[]>;
  stopsWithin(bbox: [number, number, number, number], limit?: number, signal?: AbortSignal): Promise<StopSummary[]>;
  stop(stopId: string, limit?: number, signal?: AbortSignal): Promise<StopDetail>;
  geocode(q: string, near?: { lat: number; lon: number }, signal?: AbortSignal): Promise<Place[]>;
  reverseGeocode(lat: number, lon: number, signal?: AbortSignal): Promise<Place>;
  plan(params: Parameters<typeof api.plan>[0], signal?: AbortSignal): Promise<PlanResponse>;
  alerts(signal?: AbortSignal): Promise<{ alerts: ServiceAlert[] }>;
}

/** Backed by the transit engine in a worker. */
class BrowserSource implements DataSource {
  readonly mode = 'browser' as const;
  private readonly engine = new TransitEngine(resolveAgency());

  start(): void {
    this.engine.start();
  }
  dispose(): void {
    this.engine.stop();
  }
  onStatus(listener: (status: EngineStatus) => void): () => void {
    return this.engine.onStatus(listener);
  }
  onVehicles(
    listener: (payload: { vehicles: Vehicle[]; timestamp: number | null; error: string | null }) => void,
  ): () => void {
    return this.engine.onVehicles(listener);
  }
  setRouteFilter(routeId?: string): void {
    this.engine.setRouteFilter(routeId);
  }
  refresh(hard = false): void {
    this.engine.refresh(hard);
  }

  status = () => this.engine.request<FeedStatus>('status');
  agency = () => this.engine.request<AgencyInfo>('agency');
  routes = () => this.engine.request<RouteSummary[]>('routes');
  route = (routeId: string) => this.engine.request<RouteDetail>('route', { routeId });
  nearbyStops = (lat: number, lon: number, radius = 800, limit = 20) =>
    this.engine.request<StopSummary[]>('nearbyStops', { lat, lon, radius, limit });
  stopsWithin = (bbox: [number, number, number, number], limit = 300) =>
    this.engine.request<StopSummary[]>('stopsWithin', { bbox: bbox.join(','), limit });
  stop = (stopId: string, limit = 15) => this.engine.request<StopDetail>('stop', { stopId, limit });
  geocode = (q: string, near?: { lat: number; lon: number }) =>
    this.engine.request<Place[]>('geocode', { q, lat: near?.lat, lon: near?.lon });
  reverseGeocode = (lat: number, lon: number) => this.engine.request<Place>('reverseGeocode', { lat, lon });
  plan = (params: Parameters<typeof api.plan>[0]) =>
    this.engine.request<PlanResponse>('plan', params as unknown as Record<string, unknown>);
  alerts = () => this.engine.request<{ alerts: ServiceAlert[] }>('alerts');
}

/** Backed by the Node API server over HTTP. */
class ServerSource implements DataSource {
  readonly mode = 'server' as const;
  private readonly statusListeners = new Set<(status: EngineStatus) => void>();

  start(): void {
    // The server does its own loading; report ready so the UI does not wait.
    for (const listener of this.statusListeners) {
      listener({ state: 'ready', progress: null, error: null });
    }
  }
  dispose(): void {
    this.statusListeners.clear();
  }
  onStatus(listener: (status: EngineStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener({ state: 'ready', progress: null, error: null });
    return () => this.statusListeners.delete(listener);
  }
  onVehicles(): () => void {
    // Server mode receives vehicles over SSE, handled by VehicleTracker.
    return () => undefined;
  }
  setRouteFilter(): void {
    // Filtering happens on the SSE subscription instead.
  }
  refresh(): void {
    // The server refreshes its own feed on a schedule.
  }

  status = api.status;
  agency = api.agency;
  routes = api.routes;
  route = api.route;
  nearbyStops = api.nearbyStops;
  stopsWithin = api.stopsWithin;
  stop = api.stop;
  geocode = api.geocode;
  reverseGeocode = api.reverseGeocode;
  plan = api.plan;
  alerts = api.alerts;
}

export function createDataSource(mode: DataMode = resolveMode()): DataSource {
  return mode === 'browser' ? new BrowserSource() : new ServerSource();
}

export { getApiBase };
export type { EngineStatus };
