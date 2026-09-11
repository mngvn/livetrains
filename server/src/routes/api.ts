import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PlanRequest, RouteSummary, Vehicle } from '../shared/api.js';
import { departuresForStops, groupedStopIndices, stopWithRoutes } from '../departures.js';
import { routeSummary } from '../planner/index.js';
import type { TransitService } from '../service.js';
import { parseCoordinates } from '../geocode.js';

function numberParam(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function requireCoordinate(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new BadRequest(`"${name}" must be a number`);
  return n;
}

class BadRequest extends Error {
  readonly statusCode = 400;
}

/** 503 until the feed has finished loading, so clients can retry sensibly. */
function requireReady(service: TransitService): asserts service is TransitService & {
  store: NonNullable<TransitService['store']>;
  patterns: NonNullable<TransitService['patterns']>;
  planner: NonNullable<TransitService['planner']>;
  geocoder: NonNullable<TransitService['geocoder']>;
} {
  if (!service.ready) {
    const error = new Error(
      service.loadError
        ? `The transit feed could not be loaded: ${service.loadError}`
        : 'The transit feed is still loading. Try again in a moment.',
    ) as Error & { statusCode?: number };
    error.statusCode = 503;
    throw error;
  }
}

export async function registerApi(app: FastifyInstance, service: TransitService): Promise<void> {
  app.setErrorHandler((error: unknown, _request, reply) => {
    const status = (error as { statusCode?: number })?.statusCode ?? 500;
    const message = error instanceof Error ? error.message : 'Internal server error';
    if (status >= 500) app.log.error(error);
    void reply.status(status).send({ error: message });
  });

  // ---------------------------------------------------------------------
  // Status and reference data
  // ---------------------------------------------------------------------

  app.get('/api/status', async () => service.status());

  app.get('/api/agency', async () => service.agencyInfo());

  app.get('/api/routes', async () => {
    requireReady(service);
    const routes: RouteSummary[] = service.store.routes.map(routeSummary);
    // Rail first, then buses by number — how riders scan a route list.
    const modeRank: Record<string, number> = { rail: 0, metro: 0, tram: 0, ferry: 1, bus: 2 };
    return routes.sort((a, b) => {
      const rank = (modeRank[a.mode] ?? 3) - (modeRank[b.mode] ?? 3);
      if (rank !== 0) return rank;
      const numeric = Number(a.shortName) - Number(b.shortName);
      if (!Number.isNaN(numeric) && numeric !== 0) return numeric;
      return a.shortName.localeCompare(b.shortName, undefined, { numeric: true });
    });
  });

  /** A route's stops and drawn shape, for the route detail panel. */
  app.get('/api/routes/:routeId', async (request: FastifyRequest<{ Params: { routeId: string } }>) => {
    requireReady(service);
    const { store, patterns } = service;
    const routeIndex = store.routeIndexById.get(request.params.routeId);
    if (routeIndex === undefined) throw new BadRequest(`Unknown route "${request.params.routeId}"`);

    const route = store.routes[routeIndex];
    const directions = [0, 1].map((directionId) => {
      // A route has many patterns (short turns, branches); the one with the
      // most stops is the best single representation of the line.
      const candidates = patterns.patterns.filter(
        (p) => p.routeIndex === routeIndex && p.directionId === directionId,
      );
      if (candidates.length === 0) return null;
      const longest = candidates.reduce((a, b) => (b.stops.length > a.stops.length ? b : a));
      const representativeTrip = longest.trips[0];

      return {
        directionId,
        headsign: store.tripHeadsigns[representativeTrip] || route.longName,
        stops: [...longest.stops].map((stopIndex) => stopWithRoutes(store, stopIndex)),
        geometry: store.tripGeometry(representativeTrip),
      };
    });

    return {
      route: routeSummary(route),
      directions: directions.filter((d) => d !== null),
      alerts: service.realtime.alertsFor([route.id], []),
    };
  });

  // ---------------------------------------------------------------------
  // Stops and departures
  // ---------------------------------------------------------------------

  app.get(
    '/api/stops/nearby',
    async (request: FastifyRequest<{ Querystring: { lat?: string; lon?: string; radius?: string; limit?: string } }>) => {
      requireReady(service);
      const lat = requireCoordinate(request.query.lat, 'lat');
      const lon = requireCoordinate(request.query.lon, 'lon');
      const radius = Math.min(numberParam(request.query.radius, 800), 5_000);
      const limit = Math.min(numberParam(request.query.limit, 20), 100);

      return service.store
        .nearbyStops(lat, lon, radius, limit)
        .map(({ index, distance }) => stopWithRoutes(service.store!, index, distance));
    },
  );

  /** Stops inside a map viewport, so the client can draw them while panning. */
  app.get(
    '/api/stops/within',
    async (request: FastifyRequest<{ Querystring: { bbox?: string; limit?: string } }>) => {
      requireReady(service);
      const parts = (request.query.bbox ?? '').split(',').map(Number);
      if (parts.length !== 4 || !parts.every(Number.isFinite)) {
        throw new BadRequest('"bbox" must be "west,south,east,north"');
      }
      const [west, south, east, north] = parts;
      const limit = Math.min(numberParam(request.query.limit, 300), 1_000);

      const out = [];
      for (let i = 0; i < service.store.stops.length && out.length < limit; i++) {
        const stop = service.store.stops[i];
        if (stop.lat < south || stop.lat > north || stop.lon < west || stop.lon > east) continue;
        out.push(stopWithRoutes(service.store, i));
      }
      return out;
    },
  );

  app.get(
    '/api/stops/:stopId',
    async (request: FastifyRequest<{ Params: { stopId: string }; Querystring: { limit?: string; grouped?: string } }>) => {
      requireReady(service);
      const { store, patterns } = service;
      const stopIndex = store.stopIndexById.get(request.params.stopId);
      if (stopIndex === undefined) throw new BadRequest(`Unknown stop "${request.params.stopId}"`);

      const grouped = request.query.grouped !== 'false';
      const indices = grouped ? groupedStopIndices(store, stopIndex) : [stopIndex];
      const limit = Math.min(numberParam(request.query.limit, 15), 50);

      return {
        stop: stopWithRoutes(store, stopIndex),
        // Which GTFS stops were merged, so the UI can say "both directions".
        groupedStopIds: indices.map((i) => store.stops[i].id),
        departures: departuresForStops(store, patterns, service.realtime, indices, { limit }),
        alerts: service.realtime.alertsFor(
          store.routesAtStop[stopIndex].map((r) => store.routes[r].id),
          indices.map((i) => store.stops[i].id),
        ),
      };
    },
  );

  // ---------------------------------------------------------------------
  // Live vehicles
  // ---------------------------------------------------------------------

  app.get(
    '/api/vehicles',
    async (request: FastifyRequest<{ Querystring: { routeId?: string; bbox?: string } }>) => {
      const all = [...service.realtime.vehicles.values()];
      const filtered = filterVehicles(all, request.query.routeId, request.query.bbox);
      return { vehicles: filtered, timestamp: service.realtime.lastVehicleUpdate };
    },
  );

  /**
   * A live stream of vehicle positions over Server-Sent Events.
   *
   * SSE rather than WebSockets: the traffic is one-directional and periodic,
   * which is exactly what SSE is for, and it survives proxies and reconnects
   * on its own without a heartbeat protocol to maintain.
   */
  app.get(
    '/api/vehicles/stream',
    (request: FastifyRequest<{ Querystring: { routeId?: string; bbox?: string } }>, reply: FastifyReply) => {
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Disable proxy buffering, which would otherwise hold events back.
        'x-accel-buffering': 'no',
      });

      const send = (event: string, data: unknown) => {
        if (reply.raw.writableEnded) return;
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      const push = () => {
        const vehicles = filterVehicles(
          [...service.realtime.vehicles.values()],
          request.query.routeId,
          request.query.bbox,
        );
        send('vehicles', { vehicles, timestamp: service.realtime.lastVehicleUpdate });
      };

      push();
      const unsubscribe = service.onVehiclesUpdated(push);
      // Comment frames keep intermediaries from closing an idle connection.
      const keepAlive = setInterval(() => {
        if (!reply.raw.writableEnded) reply.raw.write(': keep-alive\n\n');
      }, 25_000);

      const close = () => {
        clearInterval(keepAlive);
        unsubscribe();
        if (!reply.raw.writableEnded) reply.raw.end();
      };
      request.raw.on('close', close);
      request.raw.on('error', close);
    },
  );

  // ---------------------------------------------------------------------
  // Search and trip planning
  // ---------------------------------------------------------------------

  app.get(
    '/api/geocode',
    async (request: FastifyRequest<{ Querystring: { q?: string; lat?: string; lon?: string; limit?: string } }>) => {
      requireReady(service);
      const query = (request.query.q ?? '').trim();
      if (!query) return [];
      const nearLat = request.query.lat !== undefined ? Number(request.query.lat) : undefined;
      const nearLon = request.query.lon !== undefined ? Number(request.query.lon) : undefined;
      return service.geocoder.search(query, {
        limit: Math.min(numberParam(request.query.limit, 8), 20),
        nearLat: Number.isFinite(nearLat) ? nearLat : undefined,
        nearLon: Number.isFinite(nearLon) ? nearLon : undefined,
      });
    },
  );

  app.get(
    '/api/reverse-geocode',
    async (request: FastifyRequest<{ Querystring: { lat?: string; lon?: string } }>) => {
      requireReady(service);
      return service.geocoder.reverse(
        requireCoordinate(request.query.lat, 'lat'),
        requireCoordinate(request.query.lon, 'lon'),
      );
    },
  );

  app.get(
    '/api/plan',
    async (
      request: FastifyRequest<{
        Querystring: {
          from?: string;
          to?: string;
          fromLat?: string;
          fromLon?: string;
          toLat?: string;
          toLon?: string;
          departAt?: string;
          arriveBy?: string;
          maxWalk?: string;
          maxTransfers?: string;
          walkSpeed?: string;
        };
      }>,
    ) => {
      requireReady(service);
      const query = request.query;

      // Accept either explicit lat/lon pairs or "lat,lon" strings, which is
      // what falls out of a URL the user can share.
      const from = parseCoordinates(query.from ?? '') ?? null;
      const to = parseCoordinates(query.to ?? '') ?? null;

      const plan: PlanRequest = {
        fromLat: from ? from.lat : requireCoordinate(query.fromLat, 'fromLat'),
        fromLon: from ? from.lon : requireCoordinate(query.fromLon, 'fromLon'),
        toLat: to ? to.lat : requireCoordinate(query.toLat, 'toLat'),
        toLon: to ? to.lon : requireCoordinate(query.toLon, 'toLon'),
        departAt: query.departAt ? numberParam(query.departAt, 0) || undefined : undefined,
        arriveBy: query.arriveBy === 'true' || query.arriveBy === '1',
        maxWalkMeters: query.maxWalk ? numberParam(query.maxWalk, 0) || undefined : undefined,
        maxTransfers: query.maxTransfers !== undefined ? numberParam(query.maxTransfers, 3) : undefined,
        walkSpeed: query.walkSpeed ? numberParam(query.walkSpeed, 0) || undefined : undefined,
      };

      const started = Date.now();
      const result = service.planner.plan(plan);
      request.log.info({ ms: Date.now() - started, found: result.itineraries.length }, 'plan');
      return result;
    },
  );

  app.get('/api/alerts', async () => ({ alerts: service.realtime.alerts }));
}

/** Applies the optional route and viewport filters to a vehicle list. */
function filterVehicles(vehicles: Vehicle[], routeId?: string, bbox?: string): Vehicle[] {
  let result = vehicles;

  if (routeId) {
    const wanted = new Set(routeId.split(',').map((r) => r.trim()).filter(Boolean));
    if (wanted.size > 0) result = result.filter((v) => v.routeId !== undefined && wanted.has(v.routeId));
  }

  if (bbox) {
    const parts = bbox.split(',').map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite)) {
      const [west, south, east, north] = parts;
      result = result.filter((v) => v.lat >= south && v.lat <= north && v.lon >= west && v.lon <= east);
    }
  }

  return result;
}
