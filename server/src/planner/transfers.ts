import type { GtfsStore } from '../gtfs/store.js';
import { log } from '../log.js';

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
   * Two refinements keep the graph honest and small:
   *  - stops sharing a parent station are always linked, even if the platforms
   *    are further apart than the radius (a transfer inside one station is
   *    always possible);
   *  - each stop keeps only its `maxPerStop` nearest neighbours, which bounds
   *    the graph in dense downtown grids where hundreds of poles overlap.
   */
  static build(
    store: GtfsStore,
    maxMeters: number,
    walkSpeed: number,
    slackSeconds: number,
    maxPerStop: number,
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

    for (let s = 0; s < stopCount; s++) {
      offset[s] = targets.length;
      const stop = store.stops[s];
      const near = store.nearbyStops(stop.lat, stop.lon, maxMeters, maxPerStop + 1);

      const seen = new Set<number>([s]);
      for (const { index, distance } of near) {
        if (seen.has(index)) continue;
        seen.add(index);
        targets.push(index);
        dists.push(Math.round(distance));
        times.push(Math.round(distance / walkSpeed) + slackSeconds);
      }

      // Always connect platforms of the same station, both directions.
      const parent = stop.parent >= 0 ? stop.parent : s;
      for (const sibling of siblings.get(parent) ?? []) {
        if (seen.has(sibling)) continue;
        seen.add(sibling);
        const other = store.stops[sibling];
        const distance = Math.round(
          Math.hypot((other.lat - stop.lat) * 111_320, (other.lon - stop.lon) * 78_800),
        );
        targets.push(sibling);
        dists.push(distance);
        times.push(Math.round(distance / walkSpeed) + slackSeconds);
      }
    }
    offset[stopCount] = targets.length;

    log.info(
      `planner: built ${targets.length} walking transfers under ${maxMeters}m in ${Date.now() - started}ms`,
    );
    return new TransferGraph(
      offset,
      Int32Array.from(targets),
      Int32Array.from(times),
      Int32Array.from(dists),
    );
  }
}
