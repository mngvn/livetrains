import type { GtfsStore } from '../gtfs/store.js';
import { midnightEpoch, shiftServiceDate, serviceDateAt, type ServiceDate } from '../gtfs/time.js';
import type { PatternSet } from './patterns.js';
import type { TransferGraph } from './transfers.js';

/** How a stop was reached in a given round. */
export type Label =
  | {
      kind: 'transit';
      /** Trip index in the GTFS store. */
      trip: number;
      pattern: number;
      boardStop: number;
      boardPosition: number;
      alightPosition: number;
      /** Service date the boarded trip belongs to. */
      date: ServiceDate;
      /** Epoch seconds, realtime-adjusted. */
      boardTime: number;
      arrivalTime: number;
    }
  | {
      kind: 'walk';
      fromStop: number;
      meters: number;
      seconds: number;
      arrivalTime: number;
    }
  | {
      kind: 'origin';
      meters: number;
      seconds: number;
      arrivalTime: number;
    };

export interface RaptorOptions {
  /** Stop index -> walking seconds from the origin. */
  access: Map<number, { seconds: number; meters: number }>;
  /** Stop index -> walking seconds to the destination. */
  egress: Map<number, { seconds: number; meters: number }>;
  /** Epoch seconds the rider is available to leave. */
  departAt: number;
  maxRounds: number;
  /** Seconds added when boarding after a previous ride, for a realistic connection. */
  transferSlack: number;
  /** How far ahead to look for departures; bounds the service-day scan. */
  searchWindowSeconds: number;
}

export interface RaptorResult {
  /** `labels[round][stop]` — how that stop was reached, or undefined. */
  labels: (Label | undefined)[][];
  /** Best arrival epoch per round per stop; Infinity when unreached. */
  arrivals: Float64Array[];
  /** Rounds actually executed (index 0 is the access-walk round). */
  rounds: number;
}

/** Per-trip realtime adjustments, indexed by GTFS trip index. */
export interface RealtimeOverlay {
  /** Seconds of delay to add to every stop time of the trip. */
  delay: Int32Array;
  /** 1 when the trip is cancelled and must not be boarded. */
  cancelled: Uint8Array;
}

const UNREACHED = Number.POSITIVE_INFINITY;

/**
 * Round-based earliest-arrival search over the timetable (RAPTOR).
 *
 * Each round adds one more ride: round 1 finds everything reachable on a single
 * vehicle, round 2 everything reachable with one transfer, and so on. That
 * structure is why it naturally returns a spread of options trading transfers
 * against arrival time, and why it stays fast without a priority queue.
 *
 * Reference: Delling, Pajor & Werneck, "Round-Based Public Transit Routing".
 *
 * All times here are absolute epoch seconds. GTFS stores seconds-after-service
 * -midnight, so each candidate service day is converted through its own
 * midnight — that is what makes trips running past 24:00:00 work correctly.
 */
export function runRaptor(
  store: GtfsStore,
  patterns: PatternSet,
  transfers: TransferGraph,
  overlay: RealtimeOverlay,
  options: RaptorOptions,
): RaptorResult {
  const stopCount = store.stops.length;
  const { departAt, maxRounds, transferSlack } = options;

  // Service days whose trips could be boarded within the search window. We look
  // back a day so that after-midnight trips (times >= 24:00:00, which belong to
  // the previous service day) are still considered.
  const firstDate = serviceDateAt(departAt, store.timezone);
  const days: { date: ServiceDate; midnight: number }[] = [];
  const windowEnd = departAt + options.searchWindowSeconds;
  for (let offset = -1; offset <= 1; offset++) {
    const date = shiftServiceDate(firstDate, offset);
    const midnight = midnightEpoch(date, store.timezone);
    // Trips are at most ~30h into a service day; skip days that cannot overlap.
    if (midnight > windowEnd) continue;
    if (midnight + 30 * 3600 < departAt) continue;
    days.push({ date, midnight });
  }

  const activeByDay = days.map((d) => patterns.activeTrips(d.date));

  const arrivals: Float64Array[] = [];
  const labels: (Label | undefined)[][] = [];
  /** Best arrival at each stop across all rounds so far, used for pruning. */
  const best = new Float64Array(stopCount).fill(UNREACHED);

  const round0 = new Float64Array(stopCount).fill(UNREACHED);
  const labels0: (Label | undefined)[] = new Array(stopCount);
  let marked = new Set<number>();

  for (const [stop, walk] of options.access) {
    const time = departAt + walk.seconds;
    round0[stop] = time;
    best[stop] = time;
    labels0[stop] = { kind: 'origin', meters: walk.meters, seconds: walk.seconds, arrivalTime: time };
    marked.add(stop);
  }
  arrivals.push(round0);
  labels.push(labels0);

  /** Best arrival at the destination, for target pruning. */
  let bestTarget = UNREACHED;
  const updateTarget = (stop: number, time: number) => {
    const egress = options.egress.get(stop);
    if (egress) bestTarget = Math.min(bestTarget, time + egress.seconds);
  };
  for (const stop of marked) updateTarget(stop, round0[stop]);

  let executedRounds = 0;

  for (let round = 1; round <= maxRounds; round++) {
    if (marked.size === 0) break;
    executedRounds = round;

    const previous = arrivals[round - 1];
    const current = Float64Array.from(previous);
    const roundLabels: (Label | undefined)[] = new Array(stopCount);
    const nextMarked = new Set<number>();

    // --- Step 1: collect the patterns worth scanning, and where to start ----
    // For each pattern, only the earliest marked stop matters: boarding any
    // later marked stop is dominated by riding through from the earlier one.
    const queue = new Map<number, number>();
    for (const stop of marked) {
      for (const { pattern, position } of patterns.patternsAtStop[stop]) {
        const existing = queue.get(pattern);
        if (existing === undefined || position < existing) queue.set(pattern, position);
      }
    }

    // --- Step 2: ride each pattern from its earliest marked stop ------------
    for (const [patternIndex, startPosition] of queue) {
      const pattern = patterns.patterns[patternIndex];
      const stops = pattern.stops;

      let trip = -1;
      let tripDayIndex = -1;
      let tripBoardStop = -1;
      let tripBoardPosition = -1;
      let tripBoardTime = 0;
      let tripDelay = 0;
      let tripMidnight = 0;

      for (let position = startPosition; position < stops.length; position++) {
        const stop = stops[position];

        if (trip >= 0 && patterns.canAlight(trip, position)) {
          const arrival = tripMidnight + patterns.arrivalAt(trip, position) + tripDelay;
          // Prune against both the best known arrival here and at the target:
          // a label that cannot beat either can never be part of an answer.
          if (arrival < Math.min(best[stop], bestTarget)) {
            current[stop] = arrival;
            best[stop] = arrival;
            roundLabels[stop] = {
              kind: 'transit',
              trip,
              pattern: patternIndex,
              boardStop: tripBoardStop,
              boardPosition: tripBoardPosition,
              alightPosition: position,
              date: days[tripDayIndex].date,
              boardTime: tripBoardTime,
              arrivalTime: arrival,
            };
            nextMarked.add(stop);
            updateTarget(stop, arrival);
          }
        }

        // Can we board here, earlier than the trip we are already on?
        // Whether any individual trip actually permits boarding at this stop is
        // checked inside `earliestTrip`, which knows which trips it is testing.
        const readyAt = previous[stop];
        if (readyAt === UNREACHED) continue;
        // Boarding after a ride needs a moment to actually make the connection;
        // the very first boarding follows the access walk and needs no extra.
        const earliestBoard = readyAt + (round > 1 ? transferSlack : 0);
        const currentTripDeparture =
          trip >= 0 ? tripMidnight + patterns.departureAt(trip, position) + tripDelay : UNREACHED;
        if (earliestBoard > currentTripDeparture) continue;

        const candidate = earliestTrip(
          patterns,
          overlay,
          activeByDay,
          days,
          patternIndex,
          position,
          earliestBoard,
          windowEnd,
        );
        if (candidate && candidate.departure < currentTripDeparture) {
          trip = candidate.trip;
          tripDayIndex = candidate.dayIndex;
          tripDelay = candidate.delay;
          tripMidnight = days[candidate.dayIndex].midnight;
          tripBoardStop = stop;
          tripBoardPosition = position;
          tripBoardTime = candidate.departure;
        }
      }
    }

    // --- Step 3: relax walking transfers out of every improved stop ---------
    for (const stop of [...nextMarked]) {
      const from = current[stop];
      for (let e = transfers.offset[stop]; e < transfers.offset[stop + 1]; e++) {
        const to = transfers.target[e];
        const arrival = from + transfers.seconds[e];
        if (arrival >= Math.min(best[to], bestTarget)) continue;
        current[to] = arrival;
        best[to] = arrival;
        roundLabels[to] = {
          kind: 'walk',
          fromStop: stop,
          meters: transfers.meters[e],
          seconds: transfers.seconds[e],
          arrivalTime: arrival,
        };
        nextMarked.add(to);
        updateTarget(to, arrival);
      }
    }

    arrivals.push(current);
    labels.push(roundLabels);
    marked = nextMarked;
  }

  return { labels, arrivals, rounds: executedRounds };
}

/**
 * The earliest boardable trip of a pattern departing `position` at or after
 * `earliest`, considered across every candidate service day.
 *
 * Within one day the pattern's trips are ordered by departure, so this binary
 * searches rather than scanning. Across days it simply takes the best result,
 * which is what makes a query at 11:50pm able to board a 12:15am trip that GTFS
 * records as 24:15:00 on the previous service day.
 */
function earliestTrip(
  patterns: PatternSet,
  overlay: RealtimeOverlay,
  activeByDay: Int32Array[][],
  days: { date: ServiceDate; midnight: number }[],
  patternIndex: number,
  position: number,
  earliest: number,
  windowEnd: number,
): { trip: number; dayIndex: number; departure: number; delay: number } | null {
  let bestTrip = -1;
  let bestDay = -1;
  let bestDeparture = UNREACHED;
  let bestDelay = 0;

  for (let d = 0; d < days.length; d++) {
    const midnight = days[d].midnight;
    const trips = activeByDay[d][patternIndex];
    if (trips.length === 0) continue;

    // Required departure expressed in this service day's own seconds-after-
    // midnight frame. May be negative (the day starts later) or above 86400.
    const needed = earliest - midnight;
    if (midnight + patterns.departureAt(trips[trips.length - 1], position) < earliest) continue;

    let lo = 0;
    let hi = trips.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (patterns.departureAt(trips[mid], position) >= needed) {
        found = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    if (found === -1) continue;

    // Realtime delay can push a trip later than the binary search assumed, so
    // walk forward until we find one that genuinely departs late enough.
    for (let i = found; i < trips.length; i++) {
      const trip = trips[i];
      if (overlay.cancelled[trip] === 1) continue;
      if (!patterns.canBoard(trip, position)) continue;
      const delay = overlay.delay[trip];
      const departure = midnight + patterns.departureAt(trip, position) + delay;
      if (departure < earliest) continue;
      if (departure > windowEnd) break;
      if (departure < bestDeparture) {
        bestDeparture = departure;
        bestTrip = trip;
        bestDay = d;
        bestDelay = delay;
      }
      break;
    }
  }

  return bestTrip === -1 ? null : { trip: bestTrip, dayIndex: bestDay, departure: bestDeparture, delay: bestDelay };
}
