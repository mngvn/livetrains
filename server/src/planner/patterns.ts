import type { GtfsStore } from '../gtfs/store.js';
import type { ServiceDate } from '../gtfs/time.js';
import { log } from '../log.js';

/**
 * A RAPTOR "route": a group of trips that all visit the same stops in the same
 * order.
 *
 * GTFS `route_id` is the wrong unit for routing — a single bus route contains
 * short-turns, branches and express variants that stop at different places.
 * RAPTOR needs groups where every trip is interchangeable stop-for-stop, so we
 * derive patterns from the stop sequences themselves.
 */
export interface Pattern {
  /** Stop indices in travel order. */
  stops: Int32Array;
  /** Trip indices, sorted by departure time at the first stop. */
  trips: Int32Array;
  /** The GTFS route index every trip in this pattern belongs to. */
  routeIndex: number;
  directionId: number;
}

export interface PatternAtStop {
  pattern: number;
  /** Position of the stop within that pattern's stop list. */
  position: number;
}

export class PatternSet {
  readonly patterns: Pattern[] = [];
  /** For each stop index, every (pattern, position) that serves it. */
  readonly patternsAtStop: PatternAtStop[][];
  /** For each trip index, the pattern it belongs to. */
  readonly patternOfTrip: Int32Array;

  /** Per service date, the trips of each pattern active that date. */
  private readonly activeCache = new Map<ServiceDate, Int32Array[]>();

  private constructor(
    private readonly store: GtfsStore,
    patternsAtStop: PatternAtStop[][],
    patternOfTrip: Int32Array,
  ) {
    this.patternsAtStop = patternsAtStop;
    this.patternOfTrip = patternOfTrip;
  }

  static build(store: GtfsStore): PatternSet {
    const started = Date.now();
    const tripCount = store.tripIds.length;
    const patternOfTrip = new Int32Array(tripCount).fill(-1);

    // Group trips by the signature of their stop sequence plus direction. The
    // signature is built from stop indices, so it is stable and cheap to hash.
    const byKey = new Map<string, { stops: number[]; trips: number[]; route: number; direction: number }>();

    for (let t = 0; t < tripCount; t++) {
      const from = store.stopTimeStart[t];
      const to = store.stopTimeStart[t + 1];
      if (to - from < 2) continue; // a trip with fewer than two stops is unusable

      const stops: number[] = [];
      let valid = true;
      for (let i = from; i < to; i++) {
        const s = store.stopTimeStop[i];
        if (s < 0 || store.stopTimeDeparture[i] < 0) {
          valid = false;
          break;
        }
        stops.push(s);
      }
      if (!valid || stops.length < 2) continue;

      const direction = store.tripDirection[t];
      const key = `${direction}:${stops.join(',')}`;
      let group = byKey.get(key);
      if (!group) {
        group = { stops, trips: [], route: store.tripRoute[t], direction };
        byKey.set(key, group);
      }
      group.trips.push(t);
    }

    const patternsAtStop: PatternAtStop[][] = Array.from({ length: store.stops.length }, () => []);
    const set = new PatternSet(store, patternsAtStop, patternOfTrip);

    for (const group of byKey.values()) {
      // RAPTOR's trip scan assumes trips within a pattern do not overtake each
      // other, which lets it binary-search by departure at the boarding stop.
      group.trips.sort(
        (a, b) => store.stopTimeDeparture[store.stopTimeStart[a]] - store.stopTimeDeparture[store.stopTimeStart[b]],
      );

      const index = set.patterns.length;
      set.patterns.push({
        stops: Int32Array.from(group.stops),
        trips: Int32Array.from(group.trips),
        routeIndex: group.route,
        directionId: group.direction,
      });
      for (const t of group.trips) patternOfTrip[t] = index;
      for (let pos = 0; pos < group.stops.length; pos++) {
        patternsAtStop[group.stops[pos]].push({ pattern: index, position: pos });
      }
    }

    log.info(
      `planner: derived ${set.patterns.length} stop patterns from ${tripCount} trips ` +
        `in ${Date.now() - started}ms`,
    );
    return set;
  }

  /** Departure time (seconds after service midnight) of `trip` at `position`. */
  departureAt(trip: number, position: number): number {
    return this.store.stopTimeDeparture[this.store.stopTimeStart[trip] + position];
  }

  /** Arrival time (seconds after service midnight) of `trip` at `position`. */
  arrivalAt(trip: number, position: number): number {
    return this.store.stopTimeArrival[this.store.stopTimeStart[trip] + position];
  }

  canBoard(trip: number, position: number): boolean {
    return this.store.stopTimePickup[this.store.stopTimeStart[trip] + position] === 1;
  }

  canAlight(trip: number, position: number): boolean {
    return this.store.stopTimeDropOff[this.store.stopTimeStart[trip] + position] === 1;
  }

  /**
   * Trips of each pattern that operate on `date`, preserving departure order.
   *
   * Memoised: a plan query touches at most three dates, and consecutive queries
   * almost always reuse the same ones.
   */
  activeTrips(date: ServiceDate): Int32Array[] {
    const cached = this.activeCache.get(date);
    if (cached) return cached;

    const services = this.store.activeServices(date);
    const result = this.patterns.map((pattern) => {
      // Fast path: on a typical weekday most patterns run in full.
      let count = 0;
      for (const t of pattern.trips) if (services.has(this.store.tripService[t])) count++;
      if (count === pattern.trips.length) return pattern.trips;
      if (count === 0) return EMPTY;

      const out = new Int32Array(count);
      let k = 0;
      for (const t of pattern.trips) if (services.has(this.store.tripService[t])) out[k++] = t;
      return out;
    });

    if (this.activeCache.size > 8) this.activeCache.clear();
    this.activeCache.set(date, result);
    return result;
  }
}

const EMPTY = new Int32Array(0);
