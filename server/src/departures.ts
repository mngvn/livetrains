import type { Departure, StopSummary } from './shared/api.js';
import type { GtfsStore } from './gtfs/store.js';
import { candidateServiceDays, epochFor } from './gtfs/time.js';
import type { PatternSet } from './planner/patterns.js';
import type { RealtimeState } from './realtime/state.js';
import { accessibility, leanRouteSummary, stopSummary } from './summaries.js';
import { lineTiers } from './tiers.js';

export interface DeparturesOptions {
  /** How many departures to return. */
  limit?: number;
  /** Only include these route ids. */
  routeIds?: string[];
  /** Look no further ahead than this many seconds. */
  horizonSeconds?: number;
  /**
   * Everything left in the service day instead of a fixed horizon: the rest
   * of today's service, plus any of yesterday's that is still running past
   * midnight. Tomorrow's service is not included.
   */
  restOfServiceDay?: boolean;
  /** Epoch seconds to treat as "now". */
  now?: number;
}

/** A vehicle this close to the stop, reporting it as its stop, is at it. */
const AT_STOP_METERS = 40;

/** Upper bound on a full day's board, so a hub cannot produce thousands of rows. */
export const MAX_BOARD_DEPARTURES = 600;

/**
 * Upcoming departures from a set of stops, merged and sorted.
 *
 * Takes several stop indices rather than one because a "stop" as a rider thinks
 * of it is often several GTFS stops — opposite sides of a street, or the two
 * platforms of a station. Showing them separately would be an artefact of the
 * data model rather than anything useful.
 */
export function departuresForStops(
  store: GtfsStore,
  patterns: PatternSet,
  realtime: RealtimeState,
  stopIndices: number[],
  options: DeparturesOptions = {},
): Departure[] {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const limit = Math.min(options.limit ?? 12, MAX_BOARD_DEPARTURES);
  const restOfDay = options.restOfServiceDay === true;
  const horizon = restOfDay ? Infinity : (options.horizonSeconds ?? 3 * 3600);
  const stopIds = new Set(stopIndices.map((i) => store.stops[i].id));
  const routeFilter = options.routeIds && options.routeIds.length > 0 ? new Set(options.routeIds) : null;
  const stopSet = new Set(stopIndices);

  const found: Departure[] = [];
  // A trip can appear under more than one candidate service day; keep the first.
  const seen = new Set<string>();

  const days = candidateServiceDays(now, store.timezone);
  // Yesterday and today: yesterday for its after-midnight trips, today for
  // the rest. Tomorrow's service day only matters to a fixed horizon that
  // reaches into it.
  for (const { date, secondsOfDay } of restOfDay ? days.slice(0, 2) : days) {
    const activeTrips = patterns.activeTrips(date);

    for (const stopIndex of stopSet) {
      const stop = store.stops[stopIndex];

      for (const { pattern: patternIndex, position } of patterns.patternsAtStop[stopIndex]) {
        const pattern = patterns.patterns[patternIndex];
        // The last stop of a pattern is an arrival, not a departure.
        if (position === pattern.stops.length - 1) continue;

        const route = store.routes[pattern.routeIndex];
        if (routeFilter && !routeFilter.has(route.id)) continue;

        const trips = activeTrips[patternIndex];
        if (trips.length === 0) continue;

        // Trips are ordered by departure, so binary search to the first one
        // that has not already left rather than scanning the whole day.
        const earliest = secondsOfDay - 60;
        let lo = 0;
        let hi = trips.length - 1;
        let start = trips.length;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (patterns.departureAt(trips[mid], position) >= earliest) {
            start = mid;
            hi = mid - 1;
          } else {
            lo = mid + 1;
          }
        }

        for (let i = start; i < trips.length; i++) {
          const tripIndex = trips[i];
          const tripId = store.tripIds[tripIndex];
          if (seen.has(tripId)) continue;
          if (!patterns.canBoard(tripIndex, position)) continue;

          const scheduledSeconds = patterns.departureAt(tripIndex, position);
          const scheduledTime = epochFor(date, scheduledSeconds, store.timezone);
          if (scheduledTime > now + horizon) break;

          // Listed rather than dropped: a rider waiting for the 7:40 needs to
          // be told it is not coming, not left to wonder where it went.
          const cancelled = realtime.isCancelled(tripId);
          const predicted = cancelled ? null : realtime.predictedDeparture(tripId, stop.id);
          const delay = cancelled ? null : realtime.delayFor(tripId, stop.id);
          const expectedTime = predicted ?? (delay !== null ? scheduledTime + delay : scheduledTime);
          const vehicle = cancelled ? undefined : realtime.vehicleForTrip(tripId);
          const atStop = vehicle !== undefined && isAtStop(vehicle, stopIds, stop);
          // Drop anything that has already gone, judged on the realtime time,
          // unless it is standing at the stop with its doors open.
          if (expectedTime < now - 60 && !atStop) continue;

          seen.add(tripId);
          found.push({
            tripId,
            routeId: route.id,
            routeShortName: route.shortName,
            mode: route.mode,
            color: route.color,
            textColor: route.textColor,
            headsign: store.tripHeadsigns[tripIndex] || route.longName || route.shortName,
            directionId: store.tripDirection[tripIndex],
            scheduledTime,
            expectedTime,
            delaySeconds: predicted !== null ? predicted - scheduledTime : delay,
            isRealtime: predicted !== null || delay !== null,
            vehicleId: vehicle?.id,
            // Listed rather than dropped: "the 18 is not stopping here" is
            // exactly what someone standing at this stop needs to know.
            skipped: realtime.isSkipped(tripId, stop.id) || undefined,
            wheelchair: accessibility(store.tripWheelchair[tripIndex]),
            cancelled: cancelled || undefined,
            atStop: atStop || undefined,
          });
          // A few per pattern is plenty for a short board; the merge below
          // picks the real winners. A full day wants every one.
          if (!restOfDay && found.length > limit * 8) break;
        }
      }
    }
  }

  // A vehicle standing at the stop is leaving now, whatever its prediction
  // says, so it heads the board.
  const leavesAt = (d: Departure) => (d.atStop ? Math.min(d.expectedTime, now) : d.expectedTime);
  found.sort((a, b) => leavesAt(a) - leavesAt(b));
  return found.slice(0, limit);
}

/**
 * Whether a trip's vehicle is standing at this stop right now.
 *
 * The feed's own word when it gives one — "stopped at" this stop. Many
 * feeds never send a status, so otherwise: it names this stop as its current
 * one and is within a few metres of it.
 */
function isAtStop(
  vehicle: { stopId?: string; currentStatus?: string; lat: number; lon: number },
  stopIds: Set<string>,
  stop: { lat: number; lon: number },
): boolean {
  if (!vehicle.stopId || !stopIds.has(vehicle.stopId)) return false;
  if (vehicle.currentStatus === 'stopped') return true;
  if (vehicle.currentStatus !== undefined) return false;
  const dy = (vehicle.lat - stop.lat) * 111_320;
  const dx = (vehicle.lon - stop.lon) * 111_320 * Math.cos((stop.lat * Math.PI) / 180);
  return Math.hypot(dx, dy) <= AT_STOP_METERS;
}

/**
 * The GTFS stops a rider would consider "the same stop".
 *
 * Groups by parent station where the feed models one, and otherwise by
 * identical name within a short distance — which is how opposite-direction
 * poles on the same corner are usually encoded.
 */
export function groupedStopIndices(store: GtfsStore, stopIndex: number): number[] {
  const stop = store.stops[stopIndex];
  const group = new Set<number>([stopIndex]);

  const parent = stop.parent >= 0 ? stop.parent : stopIndex;
  for (let i = 0; i < store.stops.length; i++) {
    if (store.stops[i].parent === parent || i === parent) group.add(i);
  }

  for (const { index } of store.nearbyStops(stop.lat, stop.lon, 150, 12)) {
    if (store.stops[index].name === stop.name) group.add(index);
  }

  return [...group];
}

/** A stop summary carrying the distinct routes that serve it. */
export function stopWithRoutes(store: GtfsStore, stopIndex: number, distance?: number): StopSummary {
  const summary = stopSummary(store.stops[stopIndex]);
  if (distance !== undefined) summary.distance = Math.round(distance);
  const routeIndices = routesServing(store, stopIndex);
  summary.routes = routeIndices.map((routeIndex) => leanRouteSummary(store.routes[routeIndex]));
  const importance = stopImportance(store, stopIndex, routeIndices);
  if (importance.major) summary.major = true;
  if (importance.interchange) summary.interchange = true;
  return summary;
}

/** Child stops (platforms) of each station, built once per store. */
const childrenCache = new WeakMap<GtfsStore, Map<number, number[]>>();

function childrenOf(store: GtfsStore): Map<number, number[]> {
  let map = childrenCache.get(store);
  if (!map) {
    map = new Map();
    store.stops.forEach((stop, index) => {
      if (stop.parent < 0) return;
      const list = map!.get(stop.parent) ?? [];
      list.push(index);
      map!.set(stop.parent, list);
    });
    childrenCache.set(store, map);
  }
  return map;
}

/**
 * The routes calling at a stop. A station has none of its own in GTFS — trips
 * call at its platforms — so it gathers its platforms' routes.
 */
function routesServing(store: GtfsStore, stopIndex: number): number[] {
  const own = store.routesAtStop[stopIndex] ?? [];
  const children = childrenOf(store).get(stopIndex);
  if (!children) return own;
  const all = new Set(own);
  for (const child of children) for (const r of store.routesAtStop[child] ?? []) all.add(r);
  return [...all].sort((a, b) => a - b);
}

/** Stops served by this many routes are landmarks even with no branded line. */
const BUSY_STOP_ROUTES = 6;

/**
 * Whether a stop is worth showing before the rider zooms in (`major`), and
 * whether it is a place to change lines (`interchange`), drawn as the larger
 * hollow circle that route diagrams use for one.
 */
export function stopImportance(
  store: GtfsStore,
  stopIndex: number,
  routeIndices = routesServing(store, stopIndex),
): { major: boolean; interchange: boolean } {
  const tiers = lineTiers(store);
  const lines = routeIndices.filter((r) => tiers[r] !== 'bus').length;
  const isStation = childrenOf(store).has(stopIndex);
  const major = lines > 0 || routeIndices.length >= BUSY_STOP_ROUTES || isStation;
  const interchange = lines >= 2 || (lines >= 1 && routeIndices.length >= 4) || routeIndices.length >= 8;
  return { major, interchange };
}

/**
 * Every stop worth drawing at network scale: stations and stops on rail or
 * branded lines, and the busiest bus stops — a few hundred in a big metro,
 * against tens of thousands of stops in all.
 *
 * Platforms fold into their station, and stops sharing a name across a
 * street fold into one, because at this scale they are one place.
 */
export function majorStops(store: GtfsStore, limit = 2000): StopSummary[] {
  const out: StopSummary[] = [];
  const kept: { name: string; lat: number; lon: number }[] = [];
  for (let i = 0; i < store.stops.length && out.length < limit; i++) {
    const stop = store.stops[i];
    if (stop.parent >= 0) continue;
    const routes = routesServing(store, i);
    if (routes.length === 0) continue;
    if (!stopImportance(store, i, routes).major) continue;
    const duplicate = kept.some(
      (k) => k.name === stop.name && Math.abs(k.lat - stop.lat) < 0.0025 && Math.abs(k.lon - stop.lon) < 0.0035,
    );
    if (duplicate) continue;
    kept.push({ name: stop.name, lat: stop.lat, lon: stop.lon });
    out.push(stopWithRoutes(store, i));
  }
  return out;
}
