import type { GtfsStore } from './gtfs/store.js';
import { candidateServiceDays, epochFor, type ServiceDate } from './gtfs/time.js';
import type { PatternSet } from './planner/patterns.js';
import type { RealtimeState } from './realtime/state.js';
import type {
  AlertPlace,
  CrashReport,
  PathwaySummary,
  RouteDetail,
  RouteSummary,
  ServiceAlert,
  StopDetail,
  TransitSearchResult,
  TripStop,
  VehicleTrip,
} from './shared/api.js';
import { departuresForStops, groupedStopIndices, stopWithRoutes } from './departures.js';
import { isCrashAlert } from './shared/incidents.js';
import { routeSummary, stopSummary } from './summaries.js';

/**
 * The questions the client asks, answered once for both backends.
 *
 * The HTTP API and the in-browser engine used to carry their own copies of
 * these, line for line. Every field added to one had to be remembered in the
 * other, and a miss only showed in whichever mode nobody was looking at.
 */

/** Rail first, then buses by number — how riders scan a route list. */
export function sortedRoutes(store: GtfsStore): RouteSummary[] {
  const modeRank: Record<string, number> = { rail: 0, metro: 0, tram: 0, ferry: 1, bus: 2 };
  return store.routes
    .map((route) => routeSummary(store, route))
    .sort((a, b) => {
      const rank = (modeRank[a.mode] ?? 3) - (modeRank[b.mode] ?? 3);
      if (rank !== 0) return rank;
      const numeric = Number(a.shortName) - Number(b.shortName);
      if (!Number.isNaN(numeric) && numeric !== 0) return numeric;
      return a.shortName.localeCompare(b.shortName, undefined, { numeric: true });
    });
}

export function routeDetail(
  store: GtfsStore,
  patterns: PatternSet,
  realtime: RealtimeState,
  routeId: string,
): RouteDetail | null {
  const routeIndex = store.routeIndexById.get(routeId);
  if (routeIndex === undefined) return null;
  const route = store.routes[routeIndex];

  const directions = [0, 1]
    .map((directionId) => {
      const candidates = patterns.patterns.filter(
        (pattern) => pattern.routeIndex === routeIndex && pattern.directionId === directionId,
      );
      if (candidates.length === 0) return null;
      // A route has many patterns (short turns, branches); the longest is the
      // best single representation of the line.
      const longest = candidates.reduce((a, b) => (b.stops.length > a.stops.length ? b : a));
      const trip = longest.trips[0];
      return {
        directionId,
        headsign: store.tripHeadsigns[trip] || route.longName,
        stops: [...longest.stops].map((stopIndex) => stopWithRoutes(store, stopIndex)),
        geometry: store.tripGeometry(trip),
      };
    })
    .filter((direction) => direction !== null);

  return { route: routeSummary(store, route), directions, alerts: realtime.alertsForRoute(route.id) };
}

export function stopDetail(
  store: GtfsStore,
  patterns: PatternSet,
  realtime: RealtimeState,
  stopId: string,
  limit: number,
  /** The whole rest of the service day, for the departure board. */
  restOfServiceDay = false,
): StopDetail | null {
  const stopIndex = store.stopIndexById.get(stopId);
  if (stopIndex === undefined) return null;

  const indices = groupedStopIndices(store, stopIndex);
  const routeIndices = new Set<number>();
  for (const index of indices) for (const r of store.routesAtStop[index]) routeIndices.add(r);
  const routes = [...routeIndices].map((r) => routeSummary(store, store.routes[r]));
  routes.sort((a, b) => a.shortName.localeCompare(b.shortName, undefined, { numeric: true }));

  const detail: StopDetail = {
    stop: stopWithRoutes(store, stopIndex),
    groupedStopIds: indices.map((i) => store.stops[i].id),
    departures: departuresForStops(store, patterns, realtime, indices, { limit, restOfServiceDay }),
    alerts: realtime.alertsForStop(
      indices.map((i) => store.stops[i].id),
      routes.map((route) => route.id),
    ),
    routes,
  };

  const station = store.stationOf(stopIndex);
  const pathways = store.stationPathways.get(station);
  if (station !== stopIndex || pathways) {
    detail.station = {
      id: store.stops[station].id,
      name: store.stops[station].name,
      pathways: (pathways ?? []).map((p) => {
        const summary: PathwaySummary = { mode: p.mode, description: p.description };
        if (p.stairCount) summary.stairCount = p.stairCount;
        return summary;
      }),
    };
  }
  return detail;
}

/**
 * The service day a trip is running on, judged by which candidate day puts
 * its timetable closest to now. A trip whose times run past midnight belongs
 * to yesterday's service while it is still on the road.
 */
function serviceDayFor(store: GtfsStore, trip: number, now: number): ServiceDate | null {
  const start = store.stopTimeStart[trip];
  const end = store.stopTimeStart[trip + 1] - 1;
  if (end < start) return null;

  let best: ServiceDate | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const { date } of candidateServiceDays(now, store.timezone)) {
    if (!store.isServiceActive(store.tripService[trip], date)) continue;
    const first = epochFor(date, store.stopTimeDeparture[start], store.timezone);
    const last = epochFor(date, store.stopTimeArrival[end], store.timezone);
    // Zero when now falls inside the trip, otherwise how far outside.
    const distance = now < first ? first - now : now > last ? now - last : 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = date;
    }
  }
  return best;
}

/**
 * A live vehicle's whole trip, stop by stop, scheduled against predicted.
 *
 * Stops without a prediction of their own take the delay of the nearest
 * predicted stop before them, which is how GTFS-Realtime defines it: a delay
 * propagates down the trip until the feed says otherwise. Stops before the
 * first prediction are ones the vehicle has already passed and get none.
 */
export function vehicleTrip(
  store: GtfsStore,
  realtime: RealtimeState,
  vehicleId: string,
  now: number,
): VehicleTrip | null {
  const vehicle = realtime.vehicles.get(vehicleId);
  if (!vehicle?.tripId) return null;
  const trip = store.tripIndexById.get(vehicle.tripId);
  if (trip === undefined) return null;
  const date = serviceDayFor(store, trip, now);
  if (date === null) return null;

  const route = store.routes[store.tripRoute[trip]];
  const update = realtime.tripUpdates.get(vehicle.tripId);
  const stops: TripStop[] = [];
  let carried: number | null = null;

  for (let i = store.stopTimeStart[trip]; i < store.stopTimeStart[trip + 1]; i++) {
    const stop = store.stops[store.stopTimeStop[i]];
    const scheduled = epochFor(date, store.stopTimeDeparture[i], store.timezone);
    const prediction = update?.stops.get(stop.id);

    let predicted: number | null = null;
    let delay: number | null = null;
    if (prediction && !prediction.skipped) {
      const time = prediction.departureTime ?? prediction.arrivalTime;
      if (time !== null) {
        predicted = time;
        delay = time - scheduled;
      } else if (prediction.delaySeconds !== null) {
        delay = prediction.delaySeconds;
        predicted = scheduled + delay;
      }
      if (delay !== null) carried = delay;
    } else if (carried !== null && !prediction?.skipped) {
      delay = carried;
      predicted = scheduled + carried;
    }

    stops.push({
      stop: stopSummary(stop),
      scheduledTime: scheduled,
      predictedTime: predicted,
      delaySeconds: delay,
      skipped: prediction?.skipped ?? false,
    });
  }

  return {
    vehicleId,
    tripId: vehicle.tripId,
    route: routeSummary(store, route),
    headsign: store.tripHeadsigns[trip] || route.longName || route.shortName,
    geometry: store.tripGeometry(trip),
    stops,
    nextStopIndex: nextStopIndex(stops, vehicle.stopId, now),
    alerts: realtime.alertsForRoute(route.id),
  };
}

/**
 * Which stop the vehicle is at or heading for.
 *
 * The vehicle's own report wins when it names a stop on the trip; otherwise
 * the first stop whose (predicted, else scheduled) time has not yet passed.
 */
function nextStopIndex(stops: TripStop[], reportedStopId: string | undefined, now: number): number {
  if (reportedStopId) {
    const named = stops.findIndex((s) => s.stop.id === reportedStopId);
    if (named >= 0) return named;
  }
  const ahead = stops.findIndex((s) => !s.skipped && (s.predictedTime ?? s.scheduledTime) >= now - 30);
  return ahead >= 0 ? ahead : stops.length - 1;
}

/**
 * Finds routes and stops by what riders actually type.
 *
 * "16", "Route 16", "rt 16", "Blue", "blue line", "Nicollet Mall", "53316" (a
 * stop number off the pole). Routes are matched on their number or name,
 * stops on every word of the query appearing in the name, or on the stop
 * code exactly. Stops sharing a name within a block — both sides of a street
 * — collapse to one result, because the stop sidebar already shows both.
 */
export function searchTransit(store: GtfsStore, rawQuery: string, limit = 12): TransitSearchResult[] {
  const query = normalise(rawQuery);
  if (!query) return [];
  const routeQuery = query.replace(/^(route|rt|bus|line)\s+/, '').replace(/\s+line$/, '');
  const words = query.split(' ').filter(Boolean);

  const routes: { score: number; result: TransitSearchResult }[] = [];
  for (const route of store.routes) {
    const short = normalise(route.shortName);
    const long = normalise(route.longName);
    let score = 0;
    if (short === routeQuery) score = 100;
    else if (short.startsWith(routeQuery) && /^[a-z]/.test(routeQuery)) score = 70;
    else if (long === routeQuery || long === `${routeQuery} line`) score = 90;
    else if (routeQuery.length >= 3 && long.includes(routeQuery)) score = 50;
    if (score > 0) routes.push({ score, result: { kind: 'route', route: routeSummary(store, route) } });
  }
  routes.sort((a, b) => b.score - a.score);

  // Scored first and summarised last: a two-letter query can match thousands
  // of stops, and only the handful shown are worth building routes lists for.
  const matched: { score: number; index: number }[] = [];
  for (let i = 0; i < store.stops.length; i++) {
    const stop = store.stops[i];
    let score = 0;
    // The number on the pole. Usually digits, but GTFS does not insist.
    if (stop.code && normalise(stop.code) === query) score = 100;
    else if (words.length > 0 && query.length >= 2) {
      const name = normalise(stop.name);
      if (words.every((word) => name.includes(word))) {
        // Earlier and whole-word matches rank higher.
        score = 40 - Math.min(20, name.indexOf(words[0])) + (name.startsWith(query) ? 15 : 0);
      }
    }
    if (score <= 0) continue;
    // Stations first: a rider typing "Nicollet Mall" wants the station, not
    // one of its platforms.
    if (stop.parent < 0 && store.stationPathways.has(i)) score += 5;
    matched.push({ score, index: i });
  }
  matched.sort((a, b) => b.score - a.score || a.index - b.index);

  const stops: { score: number; result: TransitSearchResult }[] = [];
  const kept: { name: string; lat: number; lon: number }[] = [];
  for (const { score, index } of matched) {
    if (stops.length >= limit) break;
    const stop = store.stops[index];
    const duplicate = kept.some(
      (k) => k.name === stop.name && Math.abs(k.lat - stop.lat) < 0.002 && Math.abs(k.lon - stop.lon) < 0.003,
    );
    if (duplicate) continue;
    kept.push({ name: stop.name, lat: stop.lat, lon: stop.lon });
    stops.push({ score, result: { kind: 'stop', stop: stopWithRoutes(store, index) } });
  }

  // Routes lead when the query looks like a route; stops lead otherwise.
  const routeFirst = routes.length > 0 && routes[0].score >= 90;
  const ordered = routeFirst
    ? [...routes.slice(0, 5), ...stops.slice(0, limit)]
    : [...stops.slice(0, limit - Math.min(3, routes.length)), ...routes.slice(0, 3)];
  return ordered.slice(0, limit).map((entry) => entry.result);
}

/** Lowercase, punctuation to spaces, "&" to "and", collapsed whitespace. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Positions for every stop the alerts name, so the alerts view can draw them.
 *
 * Alerts carry stop ids only. Sent alongside the list rather than inside each
 * alert, since one busy station can be named by a dozen of them. Stops the
 * timetable does not know — a feed a day ahead of the GTFS — are left out.
 */
export function alertPlaces(store: GtfsStore | null, alerts: ServiceAlert[]): AlertPlace[] {
  if (!store) return [];
  const places = new Map<string, AlertPlace>();
  for (const alert of alerts) {
    for (const stopId of alert.stopIds) {
      if (places.has(stopId)) continue;
      const index = store.stopIndexById.get(stopId);
      if (index === undefined) continue;
      const stop = store.stops[index];
      places.set(stopId, { stopId, name: stop.name, lat: stop.lat, lon: stop.lon });
    }
  }
  return [...places.values()];
}

/**
 * The alerts that report a crash, each placed at a stop as nearly as the
 * alert allows.
 *
 * Needs the timetable to place anything; without one the crashes are still
 * listed, so they can be named even where they cannot be drawn.
 */
export function crashReports(store: GtfsStore | null, alerts: ServiceAlert[]): CrashReport[] {
  const reports: CrashReport[] = [];
  for (const alert of alerts) {
    if (!isCrashAlert(alert)) continue;
    const stop = store ? crashStop(store, alert) : undefined;
    reports.push({
      alertId: alert.id,
      ...(stop ? { place: { stopId: stop.id, name: stop.name, lat: stop.lat, lon: stop.lon } } : {}),
    });
  }
  return reports;
}

/** How far into a trip a cancellation must start to say anything about where. */
const CUT_SHORT_FROM = 2;

/**
 * The stop a crash alert points to, or nothing when it points nowhere.
 *
 * The stops an alert lists are the ones it affects, which for a trip cut
 * short by a collision is every stop the bus never reached: thirty of them,
 * in no order, the crash at none in particular. So, in order of how much
 * they say:
 *
 * 1. A trip cancelled part-way stopped where it was cancelled from: the
 *    first of its listed stops in the order the trip calls at them. (A trip
 *    cancelled from the start never set out, and says nothing.)
 * 2. A stop on the alert's routes named in its text: "…after a collision
 *    near Franklin Ave Station".
 * 3. An alert about a single stop is about that stop.
 */
function crashStop(store: GtfsStore, alert: ServiceAlert): GtfsStore['stops'][number] | undefined {
  const listed = new Set(alert.stopIds);

  for (const tripId of new Set(alert.informed.flatMap((entity) => (entity.tripId ? [entity.tripId] : [])))) {
    const trip = store.tripIndexById.get(tripId);
    if (trip === undefined) continue;
    const start = store.stopTimeStart[trip];
    for (let i = start; i < store.stopTimeStart[trip + 1]; i++) {
      const stop = store.stops[store.stopTimeStop[i]];
      if (!listed.has(stop.id)) continue;
      if (i - start >= CUT_SHORT_FROM) return stop;
      break;
    }
  }

  const routes = new Set(
    alert.routeIds.flatMap((id) => {
      const index = store.routeIndexById.get(id);
      return index === undefined ? [] : [index];
    }),
  );
  if (routes.size > 0) {
    const text = ` ${normalise(`${alert.header} ${alert.description}`)} `;
    let best: { stop: GtfsStore['stops'][number]; length: number } | undefined;
    store.stops.forEach((stop, index) => {
      if (!store.routesAtStop[index]?.some((route) => routes.has(route))) return;
      // "Franklin Ave Station" is as often written "Franklin Ave".
      const name = normalise(stop.name).replace(/ station$/, '');
      // Short names turn up inside other words and other names.
      if (name.length < 6 || (best && name.length <= best.length)) return;
      const at = text.indexOf(` ${name} `);
      // Where a trip set out from is in the text too, and is not where it stopped.
      if (at < 0 || text.slice(0, at).endsWith(' departing')) return;
      best = { stop, length: name.length };
    });
    if (best) return best.stop;
  }

  return alert.stopIds.length === 1 ? store.stopById(alert.stopIds[0]) : undefined;
}
