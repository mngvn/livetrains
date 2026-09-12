import type { AgencyDefinition } from '../../../server/src/agencies/types.js';
import type { Vehicle } from '../../../server/src/shared/api.js';
import type { LoadProgress } from './gtfsSource.js';

/**
 * The message contract between the page and the transit worker.
 *
 * Kept to plain serialisable shapes so everything crosses the worker boundary
 * by structured clone without special handling.
 */

/** Every query the engine can answer. Mirrors the HTTP API's surface. */
export type EngineMethod =
  | 'status'
  | 'agency'
  | 'routes'
  | 'route'
  | 'routeNetwork'
  | 'nearbyStops'
  | 'stopsWithin'
  | 'stop'
  | 'vehicles'
  | 'geocode'
  | 'reverseGeocode'
  | 'plan'
  | 'alerts';

export interface EngineRequest {
  type: 'request';
  id: number;
  method: EngineMethod;
  params: Record<string, unknown>;
}

export interface EngineInit {
  type: 'init';
  /**
   * The agency to serve, resolved on the main thread.
   *
   * Passed whole rather than by id so a build-time override reaches the worker
   * without the worker needing to read build environment of its own.
   */
  agency: AgencyDefinition;
  /** Poll interval for the realtime feeds, in seconds. */
  pollSeconds: number;
}

/** Narrows the live vehicle push to one route, matching the server's filter. */
export interface EngineSetFilter {
  type: 'setFilter';
  routeId?: string;
}

export interface EngineRefresh {
  type: 'refresh';
  /** Discard the cached archive and re-download. */
  hard?: boolean;
}

export type ToWorker = EngineInit | EngineRequest | EngineSetFilter | EngineRefresh;

export interface EngineProgress {
  type: 'progress';
  progress: LoadProgress;
}

export interface EngineReady {
  type: 'ready';
}

export interface EngineFailed {
  type: 'failed';
  error: string;
}

export interface EngineResponse {
  type: 'response';
  id: number;
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** Pushed on every realtime poll, the worker's equivalent of the SSE stream. */
export interface EngineVehicles {
  type: 'vehicles';
  vehicles: Vehicle[];
  timestamp: number | null;
  error: string | null;
}

export type FromWorker = EngineProgress | EngineReady | EngineFailed | EngineResponse | EngineVehicles;
