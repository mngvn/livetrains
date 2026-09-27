/**
 * How far a person actually walks, as opposed to how far the crow flies.
 *
 * Every walking estimate in this planner starts as a straight-line distance,
 * because that is all a stop's coordinates can tell us. Pedestrians do not
 * travel in straight lines: they follow streets, go round the block, and wait
 * at crossings. Quoting the straight line as if it were the walk is what makes
 * a plan claim you can get from a bus stop to a rail platform in four minutes
 * when the two are on opposite sides of a freeway.
 *
 * Without a street network the honest correction is a *circuity factor* — the
 * ratio of real network distance to straight-line distance. It is one of the
 * better-studied numbers in transport geography, and for gridded North
 * American cities it clusters around 1.3 to 1.4; Minneapolis, being a grid
 * interrupted by a river, two freeways and a chain of lakes, sits inside that
 * range. The point is not that 1.35 is exactly right for any given pair of
 * stops — it is that 1.0 is exactly wrong for all of them, and biasing towards
 * the walk being longer is the error a rider can absorb.
 *
 * When `PLANNER_WALK_CIRCUITY` is set to 1, every walk collapses back to the
 * straight line, which is what the tests use to check the plumbing separately
 * from the correction.
 */

/** Ratio of real walking distance to straight-line distance. */
export const DEFAULT_CIRCUITY = 1.35;

/**
 * A walking estimate: how far, and how long.
 *
 * Distances are the corrected, on-the-ground figures — the straight line is
 * not kept, because nothing downstream should be tempted to quote it.
 */
export interface WalkEstimate {
  meters: number;
  seconds: number;
}

/** Corrects a straight-line distance into a plausible walking distance. */
export function walkDistance(straightMeters: number, circuity = DEFAULT_CIRCUITY): number {
  return straightMeters * circuity;
}

/**
 * Walking distance and duration for a straight-line separation.
 *
 * `speed` is a real walking pace along the real path, so it is applied to the
 * corrected distance rather than to the straight line.
 */
export function estimateWalk(
  straightMeters: number,
  speed: number,
  circuity = DEFAULT_CIRCUITY,
): WalkEstimate {
  const meters = walkDistance(straightMeters, circuity);
  return { meters: Math.round(meters), seconds: Math.round(meters / speed) };
}

/**
 * The straight-line radius to search when the limit is a walking distance.
 *
 * A rider who says "I will walk 800m" means 800m of walking, so the candidate
 * stops are the ones within 800m *of path*, which is a smaller circle on the
 * map. Searching the full 800m as a radius and then correcting the result
 * would offer stops the rider has already ruled out.
 */
export function searchRadiusFor(walkLimitMeters: number, circuity = DEFAULT_CIRCUITY): number {
  return walkLimitMeters / circuity;
}
