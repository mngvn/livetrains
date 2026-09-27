import { TRANSFER_KEY_STRIDE, type GtfsStore } from '../gtfs/store.js';
import { log } from '../log.js';
import { DEFAULT_CIRCUITY, estimateWalk, searchRadiusFor } from './walk.js';

/**
 * The walking-transfer graph.
 *
 * RAPTOR alternates between riding and walking: after each round of boardings
 * it relaxes short walks between stops, which is what lets it find trips that
 * involve crossing the street to a different pole or walking a block between a
 * bus stop and a rail platform.
 *
 * Stored as a flat CSR-style structure (offsets into parallel target/time
 * arrays) so the inner relaxation loop touches contiguous memory.
 */
export class TransferGraph {
  private constructor(
    /** `offset[s] .. offset[s+1]` bounds stop `s`'s outgoing footpaths. */
    readonly offset: Int32Array,
    readonly target: Int32Array,
    /** Walking duration in seconds, including the boarding slack. */
    readonly seconds: Int32Array,
    readonly meters: Int32Array,
  ) {}

  /**
   * Builds footpaths between every pair of stops within `maxMeters`.
   *
   * `maxMeters` is a *walking* distance, so the geometric search runs over the
   * smaller circle that corresponds to it — see `walk.ts`.
   *
   * Four refinements keep the graph honest and small:
   *  - the feed's own transfers.txt outranks geometry: a pair it forbids is
   *    dropped however close the two stops look, a pair it states is added
   *    however far apart they are, and a minimum time it sets is respected;
   *  - stops sharing a parent station are always linked, even if the platforms
   *    are further apart than the radius (a transfer inside one station is
   *    always possible);
   *  - each stop keeps only its `maxPerStop` nearest neighbours, which bounds
   *    the graph in dense downtown grids where hundreds of poles overlap;
   *  - straight-line distances are corrected for street circuity, so a walk
   *    across a block is not quoted as a walk through it.
   */
  static build(
    store: GtfsStore,
    maxMeters: number,
    walkSpeed: number,
    slackSeconds: number,
    maxPerStop: number,
    circuity = DEFAULT_CIRCUITY,
  ): TransferGraph {
    const started = Date.now();
    const stopCount = store.stops.length;
    const offset = new Int32Array(stopCount + 1);
    const targets: number[] = [];
    const times: number[] = [];
    const dists: number[] = [];

    // Group platforms by parent station so in-station transfers survive the
    // nearest-neighbour cap.
    const siblings = new Map<number, number[]>();
    for (let s = 0; s < stopCount; s++) {
      const parent = store.stops[s].parent;
      if (parent < 0) continue;
      let group = siblings.get(parent);
      if (!group) {
        group = [];
        siblings.set(parent, group);
      }
      group.push(s);
    }

    // Stops the feed explicitly links, so they can be added even when they sit
    // outside the geometric radius.
    const stated = new Map<number, number[]>();
    for (const key of store.transferRules.keys()) {
      const from = Math.floor(key / TRANSFER_KEY_STRIDE);
      const to = key % TRANSFER_KEY_STRIDE;
      let list = stated.get(from);
      if (!list) {
        list = [];
        stated.set(from, list);
      }
      list.push(to);
    }

    const searchRadius = searchRadiusFor(maxMeters, circuity);
    let forbidden = 0;
    let added = 0;

    for (let s = 0; s < stopCount; s++) {
      offset[s] = targets.length;
      const stop = store.stops[s];
      const near = store.nearbyStops(stop.lat, stop.lon, searchRadius, maxPerStop + 1);

      const seen = new Set<number>([s]);
      /** Records one footpath, applying whatever the feed says about the pair. */
      const link = (index: number, straightMeters: number, slack: number): void => {
        if (seen.has(index)) return;
        const rule = store.transferRule(s, index);
        // Type 3 is the agency saying this connection does not exist. Trust it.
        if (rule?.type === 3) {
          forbidden++;
          seen.add(index);
          return;
        }
        seen.add(index);
        const walk = estimateWalk(straightMeters, walkSpeed, circuity);
        // A timed transfer is held for the rider, so it costs no slack.
        const base = rule?.type === 1 ? walk.seconds : walk.seconds + slack;
        targets.push(index);
        dists.push(walk.meters);
        times.push(Math.max(base, rule?.minSeconds ?? 0));
      };

      for (const { index, distance } of near) link(index, distance, slackSeconds);

      // Always connect platforms of the same station, both directions.
      const parent = stop.parent >= 0 ? stop.parent : s;
      for (const sibling of siblings.get(parent) ?? []) {
        link(sibling, straightMetersBetween(store, s, sibling), slackSeconds);
      }

      // Finally the pairs the feed states, whatever the distance.
      for (const to of stated.get(s) ?? []) {
        if (seen.has(to)) continue;
        const before = targets.length;
        link(to, straightMetersBetween(store, s, to), slackSeconds);
        if (targets.length > before) added++;
      }
    }
    offset[stopCount] = targets.length;

    if (forbidden > 0 || added > 0) {
      log.info(
        `planner: transfers.txt dropped ${forbidden} impossible footpaths and added ${added} distant ones`,
      );
    }

    log.info(
      `planner: built ${targets.length} walking transfers under ${maxMeters}m of walking ` +
        `in ${Date.now() - started}ms`,
    );
    return new TransferGraph(
      offset,
      Int32Array.from(targets),
      Int32Array.from(times),
      Int32Array.from(dists),
    );
  }
}

/** Straight-line metres between two stops, before any circuity correction. */
function straightMetersBetween(store: GtfsStore, a: number, b: number): number {
  const one = store.stops[a];
  const two = store.stops[b];
  return Math.hypot((two.lat - one.lat) * 111_320, (two.lon - one.lon) * 78_800);
}
