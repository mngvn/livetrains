import type { Departure, StopSummary } from './shared/api.js';
import type { GtfsStore } from './gtfs/store.js';
import { candidateServiceDays, epochFor } from './gtfs/time.js';
import type { PatternSet } from './planner/patterns.js';
import type { RealtimeState } from './realtime/state.js';
import { stopSummary } from './planner/index.js';

export interface DeparturesOptions {
  /** How many departures to return. */
  limit?: number;
  /** Only include these route ids. */
  routeIds?: string[];
  /** Look no further ahead than this many seconds. */
  horizonSeconds?: number;
  /** Epoch seconds to treat as "now". */
  now?: number;
}

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
  const limit = options.limit ?? 12;
  const horizon = options.horizonSeconds ?? 3 * 3600;
  const routeFilter = options.routeIds && options.routeIds.length > 0 ? new Set(options.routeIds) : null;
  const stopSet = new Set(stopIndices);

  const found: Departure[] = [];
  // A trip can appear under more than one candidate service day; keep the first.
  const seen = new Set<string>();

  for (const { date, secondsOfDay } of candidateServiceDays(now, store.timezone)) {
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

          if (realtime.isCancelled(tripId)) continue;

          const predicted = realtime.predictedDeparture(tripId, stop.id);
          const delay = realtime.delayFor(tripId, stop.id);
          const expectedTime = predicted ?? (delay !== null ? scheduledTime + delay : scheduledTime);
          // Drop anything that has already gone, judged on the realtime time.
          if (expectedTime < now - 60) continue;

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
            vehicleId: realtime.vehicleForTrip(tripId)?.id,
          });
          // A few per pattern is plenty; the merge below picks the real winners.
          if (found.length > limit * 8) break;
        }
      }
    }
  }

  found.sort((a, b) => a.expectedTime - b.expectedTime);
  return found.slice(0, limit);
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
  summary.routes = store.routesAtStop[stopIndex].map((routeIndex) => {
    const route = store.routes[routeIndex];
    return {
      id: route.id,
      shortName: route.shortName,
      longName: route.longName,
      mode: route.mode,
      color: route.color,
      textColor: route.textColor,
    };
  });
  return summary;
}
