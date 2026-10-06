import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AlertsResponse, PlanRequest, Vehicle } from '../shared/api.js';
import { MAX_BOARD_DEPARTURES, majorStops, stopWithRoutes } from '../departures.js';
import { alertPlaces, routeDetail, searchTransit, sortedRoutes, stopDetail, vehicleTrip } from '../queries.js';
import { buildRouteNetwork, type RouteNetwork } from '../network.js';
import type { TransitService } from '../service.js';
import { parseCoordinates } from '../geocode.js';
import { reachableFrom } from '../reachability.js';
import { PlaneRelay } from '../planes.js';
import { ConnectionCounter, RateLimiter } from '../rateLimit.js';

function numberParam(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** A whole-number parameter held to a range: a negative limit is not a request for fewer than none. */
function intParam(value: unknown, fallback: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(numberParam(value, fallback))));
}

/** A latitude or longitude, which must be a number and on the Earth. */
function requireCoordinate(value: unknown, name: string, bound: 90 | 180): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n) || Math.abs(n) > bound) {
    throw new BadRequest(`"${name}" must be a number between -${bound} and ${bound}`);
  }
  return n;
}

const latitude = (value: unknown, name = 'lat') => requireCoordinate(value, name, 90);
const longitude = (value: unknown, name = 'lon') => requireCoordinate(value, name, 180);

/** Longest search text worth reading; nobody types a paragraph into a stop search. */
const MAX_QUERY_LENGTH = 200;

function queryText(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_QUERY_LENGTH) : '';
}

/** Live vehicle streams across every client, whatever each one holds. */
const MAX_STREAMS_OVERALL = 5_000;

/** Paths that run a full timetable search, and so have a budget of their own. */
const EXPENSIVE_PATH = /^\/api\/(plan|stops\/[^/]+\/reachable)$/;

/** An error whose message is written for the client, whatever its status. */
class BadRequest extends Error {
  readonly statusCode = 400;
  readonly expose = true;
}

/** One Server-Sent Events frame. */
function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
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
    ) as Error & { statusCode?: number; expose?: boolean };
    error.statusCode = 503;
    error.expose = true;
    throw error;
  }
}

export async function registerApi(app: FastifyInstance, service: TransitService): Promise<void> {
  app.setErrorHandler((error: unknown, request, reply) => {
    const { statusCode, expose } = (error ?? {}) as { statusCode?: unknown; expose?: unknown };
    const status = typeof statusCode === 'number' && statusCode >= 400 && statusCode < 600 ? statusCode : 500;
    // A client error's message is about the request and is meant to be read.
    // An unexpected failure's message is about the server — a file path, an
    // internal name — so it goes to the log, and the client gets a plain
    // answer, unless it was written for them (the 503 while loading, say).
    const readable = status < 500 || expose === true;
    if (status >= 500) request.log.error(error);
    const message = readable && error instanceof Error ? error.message : 'Internal server error';
    void reply.status(status).send({ error: message });
  });

  // --- Budgets ---------------------------------------------------------------
  // Every API request counts against a generous per-client budget; trip plans
  // and reachability maps, which are whole timetable searches, also against a
  // tighter one. The live stream is limited by connections instead.
  const general = new RateLimiter(service.config.rateLimitPerMinute);
  const expensive = new RateLimiter(service.config.planRateLimitPerMinute);
  const streams = new ConnectionCounter(service.config.maxStreamsPerClient, MAX_STREAMS_OVERALL);
  app.addHook('onClose', async () => {
    general.stop();
    expensive.stop();
  });
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?', 1)[0];
    if (!path.startsWith('/api/') || path === '/api/vehicles/stream') return;
    const decision = general.take(request.ip);
    const heavy = EXPENSIVE_PATH.test(path) ? expensive.take(request.ip) : null;
    const refused = !decision.allowed ? decision : heavy && !heavy.allowed ? heavy : null;
    if (!refused) return;
    void reply.header('retry-after', String(refused.retryAfterSeconds));
    return reply.status(429).send({ error: 'Too many requests from this address. Try again in a moment.' });
  });

  // ---------------------------------------------------------------------
  // Status and reference data
  // ---------------------------------------------------------------------

  app.get('/api/status', async () => service.status());

  app.get('/api/agency', async () => service.agencyInfo());

  // ---------------------------------------------------------------------
  // Aircraft overhead
  // ---------------------------------------------------------------------

  const planes = new PlaneRelay(service.config.agency, service.config.planeFeeds, service.config.mock);

  /** Aircraft over the agency's area, relayed from a community ADS-B feed. */
  app.get('/api/planes', async (_request, reply) => {
    if (!planes.enabled) {
      return reply.status(404).send({ error: 'Aircraft are turned off on this server (PLANES_FEEDS is empty).' });
    }
    void reply.header('cache-control', 'no-store');
    return planes.planes();
  });

  app.get('/api/routes', async () => {
    requireReady(service);
    return sortedRoutes(service.store);
  });

  /** A route's stops and drawn shape, for the route detail panel. */
  app.get('/api/routes/:routeId', async (request: FastifyRequest<{ Params: { routeId: string } }>) => {
    requireReady(service);
    const detail = routeDetail(service.store, service.patterns, service.realtime, request.params.routeId);
    if (!detail) throw new BadRequest(`Unknown route "${request.params.routeId}"`);
    return detail;
  });

  // ---------------------------------------------------------------------
  // Stops and departures
  // ---------------------------------------------------------------------

  app.get(
    '/api/stops/nearby',
    async (request: FastifyRequest<{ Querystring: { lat?: string; lon?: string; radius?: string; limit?: string } }>) => {
      requireReady(service);
      const lat = latitude(request.query.lat);
      const lon = longitude(request.query.lon);
      const radius = intParam(request.query.radius, 800, 0, 5_000);
      const limit = intParam(request.query.limit, 20, 1, 100);

      return service.store
        .nearbyStops(lat, lon, radius, limit)
        .map(({ index, distance }) => stopWithRoutes(service.store!, index, distance));
    },
  );

  /** Stations, interchanges and busy stops: what the map shows before you zoom in. */
  app.get('/api/stops/major', async () => {
    requireReady(service);
    return majorStops(service.store);
  });

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
      const limit = intParam(request.query.limit, 300, 1, 1_000);

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
    async (request: FastifyRequest<{ Params: { stopId: string }; Querystring: { limit?: string; day?: string } }>) => {
      requireReady(service);
      // `day=1` asks for the full departure board: everything left today.
      const restOfDay = request.query.day === '1' || request.query.day === 'true';
      const limit = intParam(request.query.limit, 15, 1, restOfDay ? MAX_BOARD_DEPARTURES : 50);
      const detail = stopDetail(service.store, service.patterns, service.realtime, request.params.stopId, limit, restOfDay);
      if (!detail) throw new BadRequest(`Unknown stop "${request.params.stopId}"`);
      return detail;
    },
  );

  /** Everywhere you can get to from a stop, leaving now, within `minutes`. */
  app.get(
    '/api/stops/:stopId/reachable',
    async (request: FastifyRequest<{ Params: { stopId: string }; Querystring: { minutes?: string } }>) => {
      requireReady(service);
      const result = reachableFrom(
        service.store,
        service.planner,
        request.params.stopId,
        numberParam(request.query.minutes, 30),
      );
      if (!result) throw new BadRequest(`Unknown stop "${request.params.stopId}"`);
      return result;
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

  /** A live vehicle's trip: its path, and every stop scheduled against predicted. */
  app.get(
    '/api/vehicles/:vehicleId/trip',
    async (request: FastifyRequest<{ Params: { vehicleId: string } }>, reply: FastifyReply) => {
      requireReady(service);
      const trip = vehicleTrip(service.store, service.realtime, request.params.vehicleId, Math.floor(Date.now() / 1000));
      // Not an error: plenty of vehicles report no trip, or one this timetable
      // does not contain. The client shows what it has from the position alone.
      if (!trip) return reply.status(404).send({ error: 'No trip is known for that vehicle right now.' });
      return trip;
    },
  );

  /**
   * A live stream of vehicle positions over Server-Sent Events.
   *
   * SSE rather than WebSockets: the traffic is one-directional and periodic,
   * which is exactly what SSE is for, and it survives proxies and reconnects
   * on its own without a heartbeat protocol to maintain.
   */
  /**
   * The last unfiltered frame, serialised once and shared.
   *
   * Every open map without a filter gets the same bytes on each update, so
   * a hundred viewers cost one JSON.stringify of the fleet rather than a
   * hundred. Keyed on the fleet object (replaced on every poll) and the
   * trip-update version (delays are recomputed in place when predictions
   * land), so it can never serve a frame older than the data.
   */
  let sharedFrame: { vehicles: Map<string, Vehicle>; version: number; text: string } | null = null;
  const vehicleFrame = (routeId?: string, bbox?: string): string => {
    const realtime = service.realtime;
    if (!routeId && !bbox) {
      if (sharedFrame?.vehicles !== realtime.vehicles || sharedFrame.version !== realtime.tripUpdateVersion) {
        sharedFrame = {
          vehicles: realtime.vehicles,
          version: realtime.tripUpdateVersion,
          text: sseEvent('vehicles', { vehicles: [...realtime.vehicles.values()], timestamp: realtime.lastVehicleUpdate }),
        };
      }
      return sharedFrame.text;
    }
    const vehicles = filterVehicles([...realtime.vehicles.values()], routeId, bbox);
    return sseEvent('vehicles', { vehicles, timestamp: realtime.lastVehicleUpdate });
  };

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
      // Each stream holds a socket and a listener for as long as it is open,
      // so they are counted per client rather than per request.
      const release = streams.acquire(request.ip);
      if (!release) {
        void reply
          .status(429)
          .header('retry-after', '30')
          .send({ error: 'Too many live streams are open from this address.' });
        return;
      }

      // From here the response is written by hand. Hijacking tells Fastify so,
      // and the headers its hooks have already set — CORS above all, without
      // which a client on another origin cannot read the stream — are carried
      // into the head explicitly.
      reply.hijack();
      const carried = Object.fromEntries(
        Object.entries(reply.getHeaders()).filter((entry): entry is [string, string | number | string[]] => entry[1] !== undefined),
      );
      reply.raw.writeHead(200, {
        ...carried,
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-content-type-options': 'nosniff',
        // Disable proxy buffering, which would otherwise hold events back.
        'x-accel-buffering': 'no',
      });

      const { routeId, bbox } = request.query;
      const write = (text: string) => {
        if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.write(text);
      };
      const push = () => write(vehicleFrame(routeId, bbox));

      push();
      const unsubscribe = service.onVehiclesUpdated(push);
      // Comment frames keep intermediaries from closing an idle connection.
      const keepAlive = setInterval(() => write(': keep-alive\n\n'), 25_000);

      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepAlive);
        unsubscribe();
        release();
        if (!reply.raw.writableEnded) reply.raw.end();
      };
      // The response closes when the client goes away, whichever way it goes.
      reply.raw.on('close', close);
      reply.raw.on('error', close);
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
      const query = queryText(request.query.q);
      if (!query) return [];
      const nearLat = request.query.lat !== undefined ? Number(request.query.lat) : undefined;
      const nearLon = request.query.lon !== undefined ? Number(request.query.lon) : undefined;
      const near =
        nearLat !== undefined && nearLon !== undefined && Math.abs(nearLat) <= 90 && Math.abs(nearLon) <= 180;
      return service.geocoder.search(query, {
        limit: intParam(request.query.limit, 8, 1, 20),
        nearLat: near ? nearLat : undefined,
        nearLon: near ? nearLon : undefined,
      });
    },
  );

  /** Routes and stops by name, number or stop code. */
  app.get('/api/search', async (request: FastifyRequest<{ Querystring: { q?: string; limit?: string } }>) => {
    requireReady(service);
    return searchTransit(service.store, queryText(request.query.q), intParam(request.query.limit, 12, 1, 30));
  });

  app.get(
    '/api/reverse-geocode',
    async (request: FastifyRequest<{ Querystring: { lat?: string; lon?: string } }>) => {
      requireReady(service);
      return service.geocoder.reverse(latitude(request.query.lat), longitude(request.query.lon));
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
        fromLat: from ? from.lat : latitude(query.fromLat, 'fromLat'),
        fromLon: from ? from.lon : longitude(query.fromLon, 'fromLon'),
        toLat: to ? to.lat : latitude(query.toLat, 'toLat'),
        toLon: to ? to.lon : longitude(query.toLon, 'toLon'),
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

  /**
   * The drawn shape of every route.
   *
   * Built once and held: the geometry cannot change without the feed being
   * reloaded, and rebuilding it per request would be pure waste.
   */
  let network: RouteNetwork | null = null;
  app.get('/api/network', async () => {
    requireReady(service);
    network ??= buildRouteNetwork(service.store, service.planner.patterns);
    return network;
  });

  app.get('/api/alerts', async (): Promise<AlertsResponse> => {
    const alerts = service.realtime.alerts;
    return { alerts, places: alertPlaces(service.store, alerts) };
  });
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
