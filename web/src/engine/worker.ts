/// <reference lib="webworker" />
import type { AgencyInfo, FeedStatus, PlanRequest, Vehicle } from '../../../server/src/shared/api.js';
import type { AgencyDefinition } from '../../../server/src/agencies/types.js';
import { GtfsStore } from '../../../server/src/gtfs/store.js';
import { Planner } from '../../../server/src/planner/index.js';
import { majorStops, stopWithRoutes } from '../../../server/src/departures.js';
import { reachableFrom } from '../../../server/src/reachability.js';
import {
  routeDetail,
  searchTransit,
  sortedRoutes,
  stopDetail,
  vehicleTrip,
} from '../../../server/src/queries.js';
import { RealtimeState, TRIP_UPDATE_MAX_AGE_SECONDS } from '../../../server/src/realtime/state.js';
import {
  decodeAlerts,
  decodeTripUpdates,
  decodeVehiclePositions,
} from '../../../server/src/realtime/decode.js';
import { Geocoder } from '../../../server/src/geocode.js';
import { buildRouteNetwork, type RouteNetwork } from '../../../server/src/network.js';
import { loadGtfsFiles, clearGtfsCache } from './gtfsSource.js';
import type { EngineMethod, FromWorker, ToWorker } from './protocol.js';

/**
 * The transit engine, running inside a Web Worker.
 *
 * This is the whole server, in the browser. Parsing 868,000 stop times and
 * building the routing indexes takes seconds of solid CPU — on the main thread
 * that would freeze the page, including the map. In a worker it happens beside
 * a progress bar.
 *
 * Every module here is shared verbatim with the Node server: the same parser,
 * the same RAPTOR implementation, the same realtime decoding. There is no
 * second implementation to keep in step.
 */

const scope = self as unknown as DedicatedWorkerGlobalScope;

let agency: AgencyDefinition | null = null;
let store: GtfsStore | null = null;
let planner: Planner | null = null;
let geocoder: Geocoder | null = null;
let loadError: string | null = null;
let loadedAt: number | null = null;
/** Built on first request and kept: the geometry never changes mid-session. */
let network: RouteNetwork | null = null;

const realtime = new RealtimeState();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollSeconds = 15;
let routeFilter: string | undefined;
let pollInFlight = false;

function post(message: FromWorker): void {
  scope.postMessage(message);
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function load(hard = false): Promise<void> {
  if (!agency) throw new Error('No agency selected');
  if (hard) await clearGtfsCache();

  loadError = null;
  const files = await loadGtfsFiles(agency, (progress) => post({ type: 'progress', progress }));

  post({ type: 'progress', progress: { phase: 'parsing', detail: 'Reading the timetable' } });
  const loaded = GtfsStore.load(files);

  post({ type: 'progress', progress: { phase: 'indexing', detail: 'Building the trip planner' } });
  // Constructing the Planner derives stop patterns and the walking-transfer
  // graph, which is the expensive half of startup.
  const builtPlanner = new Planner(loaded, realtime, {
    maxWalkMeters: 1200,
    walkSpeed: 1.33,
    maxTransfers: 3,
    maxTransfersPerStop: 12,
  });

  store = loaded;
  planner = builtPlanner;
  network = null; // a reloaded feed invalidates the drawn network
  geocoder = new Geocoder(loaded, agency.id);
  loadedAt = Math.floor(Date.now() / 1000);

  post({ type: 'progress', progress: { phase: 'ready' } });
  post({ type: 'ready' });

  startPolling();
}

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

async function fetchFeed(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { mode: 'cors', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Polls the agency's GTFS-Realtime feeds directly from the browser.
 *
 * Each feed is applied independently, so a failing alerts feed never costs us
 * live vehicle positions — the thing riders actually notice.
 */
async function poll(): Promise<void> {
  if (!agency || pollInFlight) return;
  pollInFlight = true;
  // The next poll is due a fixed interval after this one started.
  const nextPollAt = Date.now() + pollSeconds * 1000;

  const { vehiclePositions, tripUpdates, alerts } = agency.realtime;
  const errors: string[] = [];
  const tasks: Promise<void>[] = [];
  let vehiclesOk = true;

  if (vehiclePositions) {
    tasks.push(
      fetchFeed(vehiclePositions)
        .then((buffer) => realtime.setVehicles(decodeVehiclePositions(buffer, store), store))
        .catch((err: unknown) => {
          vehiclesOk = false;
          errors.push(`vehicles (${describe(err)})`);
        }),
    );
  }
  if (tripUpdates) {
    tasks.push(
      fetchFeed(tripUpdates)
        .then((buffer) => realtime.setTripUpdates(decodeTripUpdates(buffer), store))
        .catch((err: unknown) => {
          errors.push(`trip updates (${describe(err)})`);
        }),
    );
  }
  if (alerts) {
    tasks.push(
      fetchFeed(alerts)
        .then((buffer) => realtime.setAlerts(decodeAlerts(buffer)))
        .catch((err: unknown) => {
          errors.push(`alerts (${describe(err)})`);
        }),
    );
  }

  await Promise.all(tasks);
  pollInFlight = false;
  realtime.lastError = errors.length > 0 ? errors.join('; ') : null;
  // Offline, or the feed is down: stop presenting old delays as live.
  if (errors.length > 0) realtime.expireTripUpdates(TRIP_UPDATE_MAX_AGE_SECONDS);

  post({
    type: 'vehicles',
    vehicles: filterVehicles([...realtime.vehicles.values()], routeFilter),
    timestamp: realtime.lastVehicleUpdate,
    error: realtime.lastError,
    vehiclesOk,
    nextPollAt,
  });
}

function startPolling(): void {
  if (pollTimer !== null) clearInterval(pollTimer);
  void poll();
  pollTimer = setInterval(() => void poll(), pollSeconds * 1000);
}

function filterVehicles(vehicles: Vehicle[], routeId?: string): Vehicle[] {
  if (!routeId) return vehicles;
  const wanted = new Set(
    routeId
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean),
  );
  if (wanted.size === 0) return vehicles;
  return vehicles.filter((v) => v.routeId !== undefined && wanted.has(v.routeId));
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

function requireReady(): { store: GtfsStore; planner: Planner; geocoder: Geocoder } {
  if (!store || !planner || !geocoder) {
    throw new Error(loadError ?? 'The timetable is still loading');
  }
  return { store, planner, geocoder };
}

function agencyInfo(): AgencyInfo {
  if (!agency) throw new Error('No agency selected');
  return {
    id: agency.id,
    name: agency.name,
    timezone: store?.timezone ?? agency.timezone,
    bbox: agency.bbox,
    center: agency.center,
    hasVehicles: Boolean(agency.realtime.vehiclePositions),
  };
}

function status(): FeedStatus {
  return {
    agency: agencyInfo(),
    mock: false,
    gtfs: {
      loaded: store !== null,
      loadedAt,
      stops: store?.stops.length ?? 0,
      routes: store?.routes.length ?? 0,
      trips: store?.tripIds.length ?? 0,
      stopTimes: store?.stopTimeCount ?? 0,
      version: store?.feedVersion,
      error: loadError ?? undefined,
    },
    realtime: {
      vehicles: realtime.vehicles.size,
      tripUpdates: realtime.tripUpdates.size,
      alerts: realtime.alerts.length,
      lastVehicleUpdate: realtime.lastVehicleUpdate,
      lastTripUpdate: realtime.lastTripUpdate,
      lastError: realtime.lastError,
    },
  };
}

const num = (value: unknown, fallback = 0): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

function handle(method: EngineMethod, params: Record<string, unknown>): unknown {
  switch (method) {
    case 'status':
      return status();

    case 'agency':
      return agencyInfo();

    case 'routes':
      return sortedRoutes(requireReady().store);

    case 'route': {
      const { store: s, planner: p } = requireReady();
      const detail = routeDetail(s, p.patterns, realtime, String(params.routeId));
      if (!detail) throw new Error(`Unknown route "${String(params.routeId)}"`);
      return detail;
    }

    case 'nearbyStops': {
      const { store: s } = requireReady();
      return s
        .nearbyStops(num(params.lat), num(params.lon), num(params.radius, 800), num(params.limit, 20))
        .map(({ index, distance }) => stopWithRoutes(s, index, distance));
    }

    case 'reachable': {
      const { store: s, planner: p } = requireReady();
      const result = reachableFrom(s, p, String(params.stopId), num(params.minutes, 30));
      if (!result) throw new Error(`Unknown stop "${String(params.stopId)}"`);
      return result;
    }

    case 'majorStops': {
      const { store: s } = requireReady();
      return majorStops(s);
    }

    case 'stopsWithin': {
      const { store: s } = requireReady();
      const [west, south, east, north] = String(params.bbox ?? '').split(',').map(Number);
      if (![west, south, east, north].every(Number.isFinite)) {
        throw new Error('"bbox" must be "west,south,east,north"');
      }
      const limit = num(params.limit, 300);
      const out = [];
      for (let i = 0; i < s.stops.length && out.length < limit; i++) {
        const stop = s.stops[i];
        if (stop.lat < south || stop.lat > north || stop.lon < west || stop.lon > east) continue;
        out.push(stopWithRoutes(s, i));
      }
      return out;
    }

    case 'stop': {
      const { store: s, planner: p } = requireReady();
      const detail = stopDetail(
        s,
        p.patterns,
        realtime,
        String(params.stopId),
        num(params.limit, 15),
        params.day === true,
      );
      if (!detail) throw new Error(`Unknown stop "${String(params.stopId)}"`);
      return detail;
    }

    case 'vehicleTrip': {
      const { store: s } = requireReady();
      // Null rather than an error: many vehicles report no trip at all.
      return vehicleTrip(s, realtime, String(params.vehicleId), Math.floor(Date.now() / 1000));
    }

    case 'search': {
      const { store: s } = requireReady();
      return searchTransit(s, String(params.q ?? ''), num(params.limit, 12));
    }

    case 'vehicles':
      return {
        vehicles: filterVehicles(
          [...realtime.vehicles.values()],
          params.routeId ? String(params.routeId) : undefined,
        ),
        timestamp: realtime.lastVehicleUpdate,
      };

    case 'geocode': {
      const { geocoder: g } = requireReady();
      const query = String(params.q ?? '').trim();
      if (!query) return [];
      const lat = params.lat === undefined ? undefined : Number(params.lat);
      const lon = params.lon === undefined ? undefined : Number(params.lon);
      // The worker uses only the local index; address lookup would need a
      // third-party geocoder, which a static build deliberately avoids.
      return g.searchLocal(query, {
        limit: num(params.limit, 8),
        nearLat: Number.isFinite(lat) ? lat : undefined,
        nearLon: Number.isFinite(lon) ? lon : undefined,
      });
    }

    case 'reverseGeocode': {
      const { geocoder: g } = requireReady();
      return g.reverse(num(params.lat), num(params.lon));
    }

    case 'plan': {
      const { planner: p } = requireReady();
      const request: PlanRequest = {
        fromLat: num(params.fromLat),
        fromLon: num(params.fromLon),
        toLat: num(params.toLat),
        toLon: num(params.toLon),
        departAt: params.departAt === undefined ? undefined : num(params.departAt),
        arriveBy: params.arriveBy === true || params.arriveBy === 'true',
        maxWalkMeters: params.maxWalk === undefined ? undefined : num(params.maxWalk),
        maxTransfers: params.maxTransfers === undefined ? undefined : num(params.maxTransfers),
        walkSpeed: params.walkSpeed === undefined ? undefined : num(params.walkSpeed),
      };
      return p.plan(request);
    }

    case 'routeNetwork': {
      const { store: s, planner: p } = requireReady();
      network ??= buildRouteNetwork(s, p.patterns);
      return network;
    }

    case 'alerts':
      return { alerts: realtime.alerts };

    default:
      throw new Error(`Unknown method "${String(method)}"`);
  }
}

// ---------------------------------------------------------------------------
// Message loop
// ---------------------------------------------------------------------------

scope.addEventListener('message', (event: MessageEvent<ToWorker>) => {
  const message = event.data;

  switch (message.type) {
    case 'init': {
      agency = message.agency;
      pollSeconds = message.pollSeconds;
      load().catch((err: unknown) => {
        loadError = describe(err);
        post({ type: 'failed', error: loadError });
      });
      return;
    }

    case 'setFilter': {
      routeFilter = message.routeId;
      // Push immediately so the map reflects the new filter without waiting
      // for the next poll.
      post({
        type: 'vehicles',
        vehicles: filterVehicles([...realtime.vehicles.values()], routeFilter),
        timestamp: realtime.lastVehicleUpdate,
        error: realtime.lastError,
      });
      return;
    }

    case 'refresh': {
      load(message.hard).catch((err: unknown) => {
        loadError = describe(err);
        post({ type: 'failed', error: loadError });
      });
      return;
    }

    case 'request': {
      try {
        post({ type: 'response', id: message.id, ok: true, data: handle(message.method, message.params) });
      } catch (err) {
        post({ type: 'response', id: message.id, ok: false, error: describe(err) });
      }
      return;
    }
  }
});
