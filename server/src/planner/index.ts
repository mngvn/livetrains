import type {
  Itinerary,
  Leg,
  Place,
  PlanRequest,
  PlanResponse,
  RouteSummary,
  StopSummary,
  TransitLeg,
  WalkLeg,
} from '../shared/api.js';
import type { GtfsStore, Route, Stop } from '../gtfs/store.js';
import type { RealtimeState } from '../realtime/state.js';
import { haversineMeters } from '../geo.js';
import { epochFor } from '../gtfs/time.js';
import { PatternSet } from './patterns.js';
import { runRaptor, type Label, type RealtimeOverlay } from './raptor.js';
import { TransferGraph } from './transfers.js';

/** Seconds of slack when connecting between two vehicles. */
const TRANSFER_SLACK = 45;
/** How far ahead of the requested departure the search looks for trips. */
const SEARCH_WINDOW_SECONDS = 6 * 3600;
/** Longest walk we will suggest instead of taking transit at all. */
const MAX_DIRECT_WALK_METERS = 2_000;

export interface PlannerOptions {
  maxWalkMeters: number;
  walkSpeed: number;
  maxTransfers: number;
  maxTransfersPerStop: number;
}

export class Planner {
  /**
   * The pattern set the planner routes on.
   *
   * Exposed because the departure boards need exactly the same structure, and
   * deriving it twice would double both the startup cost and the memory.
   */
  readonly patterns: PatternSet;
  private readonly transfers: TransferGraph;

  constructor(
    private readonly store: GtfsStore,
    private readonly realtime: RealtimeState,
    private readonly options: PlannerOptions,
  ) {
    this.patterns = PatternSet.build(store);
    this.transfers = TransferGraph.build(
      store,
      // Transfers between stops are capped tighter than the access/egress walk:
      // riders tolerate a longer walk at the ends of a trip than in the middle.
      Math.min(options.maxWalkMeters, 800),
      options.walkSpeed,
      TRANSFER_SLACK,
      options.maxTransfersPerStop,
    );
  }

  plan(request: PlanRequest): PlanResponse {
    const walkSpeed = request.walkSpeed && request.walkSpeed > 0 ? request.walkSpeed : this.options.walkSpeed;
    const maxWalk = clamp(request.maxWalkMeters ?? this.options.maxWalkMeters, 100, 5_000);
    const maxTransfers = clamp(request.maxTransfers ?? this.options.maxTransfers, 0, 6);
    const now = Math.floor(Date.now() / 1000);

    const from = toPlace(request.fromLat, request.fromLon, 'Origin');
    const to = toPlace(request.toLat, request.toLon, 'Destination');

    const directWalkMeters = haversineMeters(from.lat, from.lon, to.lat, to.lon);
    const itineraries: Itinerary[] = [];

    if (request.arriveBy && request.departAt) {
      const found = this.planArriveBy(request.departAt, { from, to, walkSpeed, maxWalk, maxTransfers });
      itineraries.push(...found);
    } else {
      // An explicit departure time is honoured exactly, including one in the
      // past: the caller may be planning a later trip, reviewing a past one, or
      // sitting in a timezone where "now" is not what the server thinks. Only
      // an absent time falls back to the current moment.
      const departAt = request.departAt ?? now;
      itineraries.push(...this.search(departAt, { from, to, walkSpeed, maxWalk, maxTransfers }));
    }

    // A short enough trip does not need transit at all; offer the walk, but
    // only as an extra option rather than in place of the transit results.
    if (directWalkMeters <= MAX_DIRECT_WALK_METERS) {
      const departAt = request.arriveBy && request.departAt
        ? request.departAt - Math.round(directWalkMeters / walkSpeed)
        : request.departAt ?? now;
      itineraries.push(walkOnlyItinerary(from, to, directWalkMeters, walkSpeed, departAt));
    }

    const ranked = rankItineraries(itineraries);
    return {
      from,
      to,
      itineraries: ranked,
      message: ranked.length === 0 ? this.explainNoResult(from, to, maxWalk) : undefined,
    };
  }

  /**
   * Answers "arrive by" queries with a forward search plus a tightening pass.
   *
   * A full reverse RAPTOR would be the textbook answer, but running the forward
   * search from a window before the deadline and then binary-searching for the
   * latest departure that still arrives in time reaches the same itineraries
   * with one implementation instead of two. Each probe is a full search, so the
   * probe count is deliberately small.
   */
  private planArriveBy(
    arriveBy: number,
    context: SearchContext,
  ): Itinerary[] {
    const windowStart = arriveBy - SEARCH_WINDOW_SECONDS;
    const initial = this.search(windowStart, context).filter((it) => it.arrivalTime <= arriveBy);
    if (initial.length === 0) return [];

    let earliest = windowStart;
    let latest = arriveBy;
    let bestSoFar = initial;

    // Six probes narrow a six-hour window to under six minutes, which is finer
    // than the headway of anything the rider would notice.
    for (let probe = 0; probe < 6; probe++) {
      const midpoint = Math.floor((earliest + latest) / 2);
      const candidates = this.search(midpoint, context).filter((it) => it.arrivalTime <= arriveBy);
      if (candidates.length > 0) {
        bestSoFar = candidates;
        earliest = midpoint;
      } else {
        latest = midpoint;
      }
    }
    return bestSoFar;
  }

  private search(departAt: number, context: SearchContext): Itinerary[] {
    const { from, to, walkSpeed, maxWalk, maxTransfers } = context;

    const access = this.walkableStops(from.lat, from.lon, maxWalk, walkSpeed);
    const egress = this.walkableStops(to.lat, to.lon, maxWalk, walkSpeed);
    if (access.size === 0 || egress.size === 0) return [];

    const result = runRaptor(this.store, this.patterns, this.transfers, this.buildOverlay(), {
      access,
      egress,
      departAt,
      maxRounds: maxTransfers + 1,
      transferSlack: TRANSFER_SLACK,
      searchWindowSeconds: SEARCH_WINDOW_SECONDS,
    });

    const itineraries: Itinerary[] = [];
    // Each round is one more permitted ride, so taking the best result from
    // every round yields the natural trade-off set: fastest, and fewest changes.
    for (let round = 1; round <= result.rounds; round++) {
      let bestStop = -1;
      let bestArrival = Number.POSITIVE_INFINITY;
      for (const [stop, walk] of egress) {
        const arrival = result.arrivals[round][stop];
        if (!Number.isFinite(arrival)) continue;
        const total = arrival + walk.seconds;
        if (total < bestArrival) {
          bestArrival = total;
          bestStop = stop;
        }
      }
      if (bestStop === -1) continue;

      const itinerary = this.buildItinerary(result.labels, round, bestStop, from, to, egress.get(bestStop)!);
      if (itinerary) itineraries.push(itinerary);
    }
    return itineraries;
  }

  /** Stops within walking range of a point, with their walking times. */
  private walkableStops(
    lat: number,
    lon: number,
    maxMeters: number,
    walkSpeed: number,
  ): Map<number, { seconds: number; meters: number }> {
    const out = new Map<number, { seconds: number; meters: number }>();
    let near = this.store.nearbyStops(lat, lon, maxMeters, 80);
    // A point outside the service area still deserves an answer; widen once
    // rather than returning "no route" for a stop 50m past the limit.
    if (near.length === 0) near = this.store.nearbyStops(lat, lon, maxMeters * 2.5, 20);
    for (const { index, distance } of near) {
      out.set(index, { seconds: Math.round(distance / walkSpeed), meters: Math.round(distance) });
    }
    return out;
  }

  /**
   * Projects the realtime feed onto per-trip arrays for the routing inner loop.
   *
   * RAPTOR touches trips by integer index thousands of times per query, so the
   * delay lookup has to be an array index rather than a string map probe. The
   * finer per-stop predictions are applied later, during reconstruction, where
   * the cost is paid once per leg instead.
   */
  private buildOverlay(): RealtimeOverlay {
    const tripCount = this.store.tripIds.length;
    const delay = new Int32Array(tripCount);
    const cancelled = new Uint8Array(tripCount);

    for (const [tripId, update] of this.realtime.tripUpdates) {
      const index = this.store.tripIndexById.get(tripId);
      if (index === undefined) continue;
      if (update.cancelled) {
        cancelled[index] = 1;
        continue;
      }
      if (update.tripDelaySeconds != null) {
        delay[index] = update.tripDelaySeconds;
        continue;
      }
      // No trip-level delay: use the median-ish first per-stop prediction, which
      // is a better estimate for the whole trip than assuming it is on time.
      for (const prediction of update.stops.values()) {
        if (prediction.delaySeconds != null) {
          delay[index] = prediction.delaySeconds;
          break;
        }
      }
    }
    return { delay, cancelled };
  }

  /** Walks the RAPTOR labels backward to produce rider-facing legs. */
  private buildItinerary(
    labels: (Label | undefined)[][],
    round: number,
    egressStop: number,
    from: Place,
    to: Place,
    egressWalk: { seconds: number; meters: number },
  ): Itinerary | null {
    const chain: { round: number; stop: number; label: Label }[] = [];
    let stop = egressStop;
    let currentRound = round;

    // Labels are only written in the round that improved a stop, so step back
    // through earlier rounds until the one that actually produced this arrival.
    for (let guard = 0; guard < 64; guard++) {
      let label = labels[currentRound][stop];
      while (!label && currentRound > 0) {
        currentRound--;
        label = labels[currentRound][stop];
      }
      if (!label) return null;

      chain.push({ round: currentRound, stop, label });
      if (label.kind === 'origin') break;
      if (label.kind === 'walk') {
        stop = label.fromStop;
      } else {
        stop = label.boardStop;
        currentRound = Math.max(0, currentRound - 1);
      }
    }
    chain.reverse();
    if (chain.length === 0 || chain[0].label.kind !== 'origin') return null;

    const legs: Leg[] = [];
    const origin = chain[0];
    const originStop = this.store.stops[origin.stop];

    if (origin.label.kind === 'origin' && origin.label.meters > 5) {
      legs.push(
        walkLeg(
          from,
          stopPlace(originStop),
          origin.label.meters,
          origin.label.seconds,
          origin.label.arrivalTime - origin.label.seconds,
        ),
      );
    }

    for (let i = 1; i < chain.length; i++) {
      const { label } = chain[i];
      if (label.kind === 'walk') {
        const fromStop = this.store.stops[label.fromStop];
        const toStop = this.store.stops[chain[i].stop];
        legs.push(
          walkLeg(
            stopPlace(fromStop),
            stopPlace(toStop),
            label.meters,
            label.seconds,
            label.arrivalTime - label.seconds,
          ),
        );
      } else if (label.kind === 'transit') {
        legs.push(this.transitLeg(label));
      }
    }

    const lastStop = this.store.stops[egressStop];
    const arrivalAtEgress = chain[chain.length - 1].label.arrivalTime;
    if (egressWalk.meters > 5) {
      legs.push(walkLeg(stopPlace(lastStop), to, egressWalk.meters, egressWalk.seconds, arrivalAtEgress));
    }

    if (legs.length === 0) return null;
    return finaliseItinerary(legs);
  }

  /** Builds one ride leg, refining times with per-stop realtime predictions. */
  private transitLeg(label: Extract<Label, { kind: 'transit' }>): TransitLeg {
    const store = this.store;
    const tripIndex = label.trip;
    const tripId = store.tripIds[tripIndex];
    const route = store.routes[store.tripRoute[tripIndex]];
    const boardStop = store.stops[label.boardStop];
    const pattern = this.patterns.patterns[label.pattern];
    const alightStopIndex = pattern.stops[label.alightPosition];
    const alightStop = store.stops[alightStopIndex];

    const scheduledDeparture = epochFor(
      label.date,
      this.patterns.departureAt(tripIndex, label.boardPosition),
      store.timezone,
    );
    const scheduledArrival = epochFor(
      label.date,
      this.patterns.arrivalAt(tripIndex, label.alightPosition),
      store.timezone,
    );

    // Prefer an absolute predicted time when the producer gives one; it already
    // accounts for effects a uniform delay cannot, like a held connection.
    const predictedDeparture = this.realtime.predictedDeparture(tripId, boardStop.id);
    const predictedArrival = this.realtime.predictedArrival(tripId, alightStop.id);
    const delay = this.realtime.delayFor(tripId, boardStop.id);

    const departureTime = predictedDeparture ?? label.boardTime;
    const arrivalTime = predictedArrival ?? label.arrivalTime;

    const intermediate: StopSummary[] = [];
    const geometry: [number, number][] = [];
    for (let position = label.boardPosition; position <= label.alightPosition; position++) {
      const s = store.stops[pattern.stops[position]];
      geometry.push([s.lon, s.lat]);
      if (position > label.boardPosition) intermediate.push(stopSummary(s));
    }

    return {
      type: 'transit',
      route: routeSummary(route),
      tripId,
      headsign: store.tripHeadsigns[tripIndex] || route.longName || route.shortName,
      directionId: store.tripDirection[tripIndex],
      from: stopSummary(boardStop),
      to: stopSummary(alightStop),
      departureTime,
      arrivalTime,
      scheduledDepartureTime: scheduledDeparture,
      scheduledArrivalTime: scheduledArrival,
      delaySeconds: delay,
      isRealtime: predictedDeparture !== null || delay !== null,
      numStops: label.alightPosition - label.boardPosition,
      intermediateStops: intermediate,
      geometry: this.legGeometry(tripIndex, geometry),
      vehicleId: this.realtime.vehicleForTrip(tripId)?.id,
    };
  }

  /**
   * The drawn path for a ride leg.
   *
   * Uses the trip's GTFS shape where one exists, clipped to the segment the
   * rider is actually on, so the map follows the street rather than cutting
   * across blocks between stops.
   */
  private legGeometry(tripIndex: number, stopLine: [number, number][]): [number, number][] {
    const shape = this.store.tripGeometry(tripIndex);
    if (shape.length < 2 || stopLine.length < 2) return stopLine;

    const start = nearestPointIndex(shape, stopLine[0]);
    const end = nearestPointIndex(shape, stopLine[stopLine.length - 1]);
    if (start >= end) return stopLine;

    const clipped = shape.slice(start, end + 1);
    return clipped.length >= 2 ? clipped : stopLine;
  }

  /** A human explanation for an empty result, rather than a bare empty list. */
  private explainNoResult(from: Place, to: Place, maxWalk: number): string {
    const nearOrigin = this.store.nearbyStops(from.lat, from.lon, maxWalk, 1);
    const nearDestination = this.store.nearbyStops(to.lat, to.lon, maxWalk, 1);
    if (nearOrigin.length === 0 && nearDestination.length === 0) {
      return 'Neither the start nor the destination is within walking distance of a stop.';
    }
    if (nearOrigin.length === 0) return 'No stop within walking distance of the starting point.';
    if (nearDestination.length === 0) return 'No stop within walking distance of the destination.';

    const today = this.store.lastServiceDate(
      Number(new Date().toISOString().slice(0, 10).replace(/-/g, '')),
    );
    if (today === null) {
      return 'The loaded schedule has no service on any upcoming date — the GTFS feed may be out of date.';
    }
    return 'No trip found in the next few hours. Service may have ended for the night, or the trip may need more transfers than allowed.';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SearchContext {
  from: Place;
  to: Place;
  walkSpeed: number;
  maxWalk: number;
  maxTransfers: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toPlace(lat: number, lon: number, name: string): Place {
  return { id: `${lat.toFixed(5)},${lon.toFixed(5)}`, name, lat, lon, kind: 'coordinate' };
}

function stopPlace(stop: Stop): Place {
  return { id: stop.id, name: stop.name, detail: `Stop ${stop.code}`, lat: stop.lat, lon: stop.lon, kind: 'stop' };
}

export function stopSummary(stop: Stop): StopSummary {
  return { id: stop.id, code: stop.code, name: stop.name, lat: stop.lat, lon: stop.lon };
}

export function routeSummary(route: Route): RouteSummary {
  return {
    id: route.id,
    shortName: route.shortName,
    longName: route.longName,
    mode: route.mode,
    color: route.color,
    textColor: route.textColor,
    description: route.description || undefined,
  };
}

function walkLeg(
  from: Place,
  to: Place,
  meters: number,
  seconds: number,
  departureTime: number,
): WalkLeg {
  return {
    type: 'walk',
    from,
    to,
    distanceMeters: Math.round(meters),
    durationSeconds: Math.round(seconds),
    departureTime,
    arrivalTime: departureTime + seconds,
    geometry: [
      [from.lon, from.lat],
      [to.lon, to.lat],
    ],
  };
}

function walkOnlyItinerary(
  from: Place,
  to: Place,
  meters: number,
  walkSpeed: number,
  departAt: number,
): Itinerary {
  const seconds = Math.round(meters / walkSpeed);
  const leg = walkLeg(from, to, meters, seconds, departAt);
  return {
    departureTime: departAt,
    arrivalTime: departAt + seconds,
    durationSeconds: seconds,
    walkDistanceMeters: Math.round(meters),
    walkDurationSeconds: seconds,
    transfers: 0,
    hasRealtime: false,
    legs: [leg],
  };
}

/**
 * Assembles legs into an itinerary, anchoring departure to the first boarding.
 *
 * Without this the itinerary would claim the rider leaves the instant they
 * asked and then stands at a stop for twenty minutes. Shifting the access walk
 * to finish just before the vehicle arrives is both more useful and more honest
 * about when they actually need to set off.
 */
function finaliseItinerary(legs: Leg[]): Itinerary {
  const firstTransit = legs.findIndex((leg) => leg.type === 'transit');
  if (firstTransit > 0) {
    let boardTime = (legs[firstTransit] as TransitLeg).departureTime;
    for (let i = firstTransit - 1; i >= 0; i--) {
      const leg = legs[i] as WalkLeg;
      leg.arrivalTime = boardTime;
      leg.departureTime = boardTime - leg.durationSeconds;
      boardTime = leg.departureTime;
    }
  }

  let walkMeters = 0;
  let walkSeconds = 0;
  let transitLegs = 0;
  let hasRealtime = false;
  for (const leg of legs) {
    if (leg.type === 'walk') {
      walkMeters += leg.distanceMeters;
      walkSeconds += leg.durationSeconds;
    } else {
      transitLegs++;
      if (leg.isRealtime) hasRealtime = true;
    }
  }

  const departureTime = legs[0].departureTime;
  const arrivalTime = legs[legs.length - 1].arrivalTime;
  return {
    departureTime,
    arrivalTime,
    durationSeconds: Math.max(0, arrivalTime - departureTime),
    walkDistanceMeters: Math.round(walkMeters),
    walkDurationSeconds: Math.round(walkSeconds),
    transfers: Math.max(0, transitLegs - 1),
    hasRealtime,
    legs,
  };
}

/**
 * Orders itineraries and drops ones no rider would choose.
 *
 * An itinerary is only worth showing if it beats every cheaper alternative on
 * some axis the rider cares about — arriving earlier, or requiring fewer
 * changes. Anything that is both later *and* more work is dropped.
 */
function rankItineraries(itineraries: Itinerary[]): Itinerary[] {
  const sorted = [...itineraries].sort(
    (a, b) => a.arrivalTime - b.arrivalTime || a.transfers - b.transfers || a.walkDurationSeconds - b.walkDurationSeconds,
  );

  const kept: Itinerary[] = [];
  for (const candidate of sorted) {
    // A walk-only option is never pruned. On a short trip it is often the one
    // a rider actually wants: no waiting, no fare, and no risk of missing a
    // connection — worth showing even when a vehicle would technically be a
    // couple of minutes quicker.
    if (candidate.legs.every((leg) => leg.type === 'walk')) {
      kept.push(candidate);
      continue;
    }

    const dominated = kept.some(
      (existing) =>
        existing.legs.some((leg) => leg.type === 'transit') &&
        existing.arrivalTime <= candidate.arrivalTime &&
        existing.transfers <= candidate.transfers &&
        existing.walkDurationSeconds <= candidate.walkDurationSeconds + 120 &&
        existing.departureTime >= candidate.departureTime - 120,
    );
    if (dominated) continue;
    // Two itineraries that differ only in which identical-looking bus they
    // board are noise; treat same-arrival, same-structure results as duplicates.
    const duplicate = kept.some(
      (existing) =>
        existing.arrivalTime === candidate.arrivalTime &&
        existing.departureTime === candidate.departureTime &&
        existing.legs.length === candidate.legs.length,
    );
    if (duplicate) continue;
    kept.push(candidate);
    if (kept.length >= 5) break;
  }
  return kept;
}

function nearestPointIndex(line: [number, number][], point: [number, number]): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < line.length; i++) {
    const dx = line[i][0] - point[0];
    const dy = line[i][1] - point[1];
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex;
}
