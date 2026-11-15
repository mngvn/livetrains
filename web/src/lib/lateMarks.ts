import { LATE_SECONDS } from './networkHealth.ts';

/**
 * Which vehicles the map marks as running late, and how.
 *
 * The same line the status board draws: five minutes behind is late in the
 * sense a rider means, and anything less is a bus being a bus. Ten minutes
 * is the next bus's worth on most lines, and is marked in the colour kept
 * for trouble. A vehicle with no delay figure is not marked either way —
 * unknown is not on time, but it is not late.
 */

/** A vehicle this far behind is marked as very late. */
export const VERY_LATE_SECONDS = 10 * 60;

/** 0: on time, early or unknown. 1: late. 2: very late. */
export type LateLevel = 0 | 1 | 2;

export function lateLevel(delaySeconds: number | undefined): LateLevel {
  if (delaySeconds === undefined || delaySeconds < LATE_SECONDS) return 0;
  return delaySeconds >= VERY_LATE_SECONDS ? 2 : 1;
}

/** "+6 min": how late, as it is written beside a vehicle. */
export function lateLabel(delaySeconds: number): string {
  return `+${Math.round(delaySeconds / 60)} min`;
}

/** How many of the fleet are late, and how many of those very late: for the legend. */
export function lateCounts(vehicles: Iterable<{ delaySeconds?: number; stale?: boolean }>): { late: number; veryLate: number } {
  let late = 0;
  let veryLate = 0;
  for (const vehicle of vehicles) {
    if (vehicle.stale) continue;
    const level = lateLevel(vehicle.delaySeconds);
    if (level > 0) late += 1;
    if (level === 2) veryLate += 1;
  }
  return { late, veryLate };
}
