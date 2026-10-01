import type { GtfsStore } from './gtfs/store.js';
import type { Planner } from './planner/index.js';
import type { Reachability } from './shared/api.js';
import { stopWithRoutes } from './departures.js';

/** The furthest a reachability map looks ahead. */
export const MAX_REACH_MINUTES = 60;

/**
 * Everywhere you can get to from one stop, leaving now, within a budget.
 *
 * Returns the stops reached and how long each took, including the wait for
 * the first vehicle; turning that into shaded ground — the walk from each
 * stop — is the client's job, since it is a question of drawing, not of the
 * timetable.
 */
export function reachableFrom(
  store: GtfsStore,
  planner: Planner,
  stopId: string,
  minutes: number,
  now = Math.floor(Date.now() / 1000),
): Reachability | null {
  const index = store.stopIndexById.get(stopId);
  if (index === undefined) return null;
  const budget = Math.max(5, Math.min(MAX_REACH_MINUTES, Math.round(minutes)));
  const reached = planner.reachable(index, now, budget * 60);
  return {
    origin: stopWithRoutes(store, index),
    departAt: now,
    minutes: budget,
    walkSpeed: planner.walkSpeed,
    stops: reached.map(({ index: i, seconds }) => {
      const stop = store.stops[i];
      return { id: stop.id, lat: stop.lat, lon: stop.lon, seconds };
    }),
  };
}
