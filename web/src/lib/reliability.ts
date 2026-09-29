import type { Departure } from './api.ts';

/**
 * How dependable a rider's usual departure really is, from what this app has
 * seen with its own eyes.
 *
 * Agencies publish on-time performance for a whole system, averaged over a
 * month. That number says little about the 7:40 Route 21 from Lake & Lyndale.
 * This keeps a small history for exactly the boardings on a rider's saved
 * trips: every time one of those buses or trains is about to leave while the
 * app is open, its latest prediction is written down, and the history is
 * summarised as "on time 8 times in 10, usually 2 minutes late".
 *
 * Honest about its limits: it only knows what it saw while the app was open,
 * and it says how many departures that was.
 */

/**
 * A boarding worth watching: this route, this way, from this stop.
 *
 * The direction matters because a stop's departures include every platform
 * of its station — northbound and southbound trains share a name, and their
 * punctuality has nothing to do with each other.
 */
export interface Watch {
  stopId: string;
  routeId: string;
  directionId: number;
}

export interface Observation {
  /** One row per departure; a later look at the same one overwrites it. */
  id: string;
  /** `stopId|routeId|directionId`, the index a saved trip reads its history by. */
  key: string;
  tripId: string;
  scheduledTime: number;
  /** Seconds late (negative is early) at the last prediction before it left. */
  delaySeconds: number;
  /** The feed said this departure would not call here after all. */
  skipped: boolean;
  /** When it was recorded, Unix seconds. */
  at: number;
}

export interface ReliabilitySummary {
  /** Departures seen. */
  count: number;
  /** Share within the on-time window, 0–1; null until there are enough. */
  onTimeShare: number | null;
  /** Median delay in seconds, among those that ran. */
  typicalDelaySeconds: number | null;
  /** Ninth-decile delay: "at worst, usually". */
  badDaySeconds: number | null;
  /** Departures the feed dropped or skipped. */
  missed: number;
}

/**
 * The industry's usual definition of on time: no more than one minute early
 * (early is worse than late — you miss it entirely) and no more than five
 * minutes late.
 */
export const ON_TIME_EARLY_SECONDS = -60;
export const ON_TIME_LATE_SECONDS = 300;

/** Too few to put a percentage on without it being misleading. */
export const MIN_FOR_SHARE = 5;

/**
 * How close to departure a prediction has to be to count as what happened.
 *
 * A prediction twenty minutes out is a forecast; one within a minute of the
 * door closing is as near to the truth as a realtime feed gets. Slightly past
 * departure too, since a vehicle that has just left is often still listed.
 */
const WINDOW_BEFORE_SECONDS = 90;
const WINDOW_AFTER_SECONDS = 90;

export function watchKey(watch: Watch): string {
  return `${watch.stopId}|${watch.routeId}|${watch.directionId}`;
}

/** Route and direction together, as the set of what to watch at one stop. */
export function routeDirection(routeId: string, directionId: number): string {
  return `${routeId}|${directionId}`;
}

/**
 * The departures from one stop that are worth writing down right now: on a
 * watched route, predicted in real time, and about to leave.
 */
export function observationsFrom(stopId: string, departures: Departure[], watched: Set<string>, now: number): Observation[] {
  const rows: Observation[] = [];
  for (const departure of departures) {
    if (!watched.has(routeDirection(departure.routeId, departure.directionId))) continue;
    // A timetable time is not an observation of anything.
    if (!departure.isRealtime && !departure.skipped) continue;
    const at = departure.expectedTime;
    if (at < now - WINDOW_AFTER_SECONDS || at > now + WINDOW_BEFORE_SECONDS) continue;
    rows.push({
      id: `${stopId}|${departure.tripId}|${departure.scheduledTime}`,
      key: watchKey({ stopId, routeId: departure.routeId, directionId: departure.directionId }),
      tripId: departure.tripId,
      scheduledTime: departure.scheduledTime,
      delaySeconds: departure.expectedTime - departure.scheduledTime,
      skipped: Boolean(departure.skipped),
      at: now,
    });
  }
  return rows;
}

export function summarise(observations: Observation[]): ReliabilitySummary {
  const ran = observations.filter((o) => !o.skipped).map((o) => o.delaySeconds);
  const missed = observations.length - ran.length;
  const count = observations.length;
  if (count === 0) {
    return { count: 0, onTimeShare: null, typicalDelaySeconds: null, badDaySeconds: null, missed: 0 };
  }
  const onTime = ran.filter((d) => d >= ON_TIME_EARLY_SECONDS && d <= ON_TIME_LATE_SECONDS).length;
  const sorted = [...ran].sort((a, b) => a - b);
  return {
    count,
    // A skipped stop is the least on-time a departure can be.
    onTimeShare: count >= MIN_FOR_SHARE ? onTime / count : null,
    typicalDelaySeconds: sorted.length > 0 ? quantile(sorted, 0.5) : null,
    badDaySeconds: sorted.length >= MIN_FOR_SHARE ? quantile(sorted, 0.9) : null,
    missed,
  };
}

/** Plain words for a summary, e.g. "On time 8 in 10 · usually 2 min late". */
export function describe(summary: ReliabilitySummary): string {
  if (summary.count === 0) return 'No departures seen yet';
  if (summary.onTimeShare === null) {
    return `${summary.count} departure${summary.count === 1 ? '' : 's'} seen so far`;
  }
  const tenths = Math.round(summary.onTimeShare * 10);
  const parts = [`On time ${tenths} in 10`];
  const typical = summary.typicalDelaySeconds;
  if (typical !== null) {
    const minutes = Math.round(typical / 60);
    parts.push(minutes === 0 ? 'usually on the dot' : minutes > 0 ? `usually ${minutes} min late` : `usually ${-minutes} min early`);
  }
  if (summary.missed > 0) parts.push(`${summary.missed} didn’t come`);
  return parts.join(' · ');
}

function quantile(sorted: number[], q: number): number {
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}
