import type { GtfsStore } from '../gtfs/store.js';
import { candidateServiceDays, epochFor } from '../gtfs/time.js';
import type { Vehicle } from '../shared/api.js';
import type { StopPrediction, TripUpdate } from './state.js';

/**
 * How late (or early) a vehicle is running.
 *
 * GTFS-Realtime does not say this directly. Vehicle positions carry where a
 * bus is; trip updates carry predictions for the stops ahead of it; the
 * timetable carries when it was meant to be there. A vehicle's delay is the
 * three put together, measured at the stop it is at or about to reach — the
 * one place where "late" means something to a rider.
 *
 * An absolute predicted time is preferred to a stated delay when the feed
 * gives both. The time is what the producer actually believes; a delay has
 * to be re-applied to a schedule the producer may have matched differently.
 */

/** Ignore a timetable match further than this from the prediction. */
const MAX_PLAUSIBLE_DELAY = 6 * 3600;

export function vehicleDelay(
  vehicle: Vehicle,
  update: TripUpdate | undefined,
  store: GtfsStore | null,
  now: number,
): number | undefined {
  if (!update || update.cancelled || !vehicle.tripId) return undefined;

  const anchor = anchorStop(vehicle, update, now);
  if (anchor) {
    const [stopId, prediction] = anchor;
    const departs = prediction.departureTime !== null;
    const predicted = prediction.departureTime ?? prediction.arrivalTime;
    if (predicted !== null && store) {
      const scheduled = scheduledTimeAt(store, vehicle.tripId, stopId, predicted, departs);
      if (scheduled !== null) return predicted - scheduled;
    }
    if (prediction.delaySeconds !== null) return prediction.delaySeconds;
  }
  return update.tripDelaySeconds ?? undefined;
}

/**
 * The prediction that best describes where the vehicle is now.
 *
 * The stop the vehicle itself names is the best anchor. Failing that, the
 * first stop still ahead of it: producers list upcoming stops in order, and
 * the next one is where lateness is about to matter. Skipped stops never
 * count — the vehicle is not going there.
 */
function anchorStop(
  vehicle: Vehicle,
  update: TripUpdate,
  now: number,
): [string, StopPrediction] | null {
  if (vehicle.stopId) {
    const named = update.stops.get(vehicle.stopId);
    if (named && !named.skipped) return [vehicle.stopId, named];
  }

  let last: [string, StopPrediction] | null = null;
  for (const entry of update.stops) {
    const [, prediction] = entry;
    if (prediction.skipped) continue;
    const at = prediction.arrivalTime ?? prediction.departureTime;
    // A delay-only entry has no time to compare, so it is taken as upcoming;
    // producers drop stops a vehicle has passed rather than keep them.
    if (at === null || at >= now - 30) return entry;
    last = entry;
  }
  return last;
}

/**
 * When the timetable says a trip is at a stop, as an epoch.
 *
 * A trip's stop times are seconds after its service day's midnight, and the
 * service day is not in the prediction. So each plausible day — yesterday,
 * today, tomorrow, filtered to days the trip actually runs — is tried, and the
 * one closest to the prediction wins. That is what lets a 25:10 trip at
 * 1:10am, or a late bus straddling midnight, be judged against the right day.
 */
export function scheduledTimeAt(
  store: GtfsStore,
  tripId: string,
  stopId: string,
  near: number,
  departure = true,
): number | null {
  const trip = store.tripIndexById.get(tripId);
  const stop = store.stopIndexById.get(stopId);
  if (trip === undefined || stop === undefined) return null;

  let best: number | null = null;
  const service = store.tripService[trip];
  for (const { date } of candidateServiceDays(near, store.timezone)) {
    if (!store.isServiceActive(service, date)) continue;
    // A loop route can visit a stop twice; every visit is a candidate.
    for (let i = store.stopTimeStart[trip]; i < store.stopTimeStart[trip + 1]; i++) {
      if (store.stopTimeStop[i] !== stop) continue;
      const seconds = departure ? store.stopTimeDeparture[i] : store.stopTimeArrival[i];
      const epoch = epochFor(date, seconds, store.timezone);
      if (best === null || Math.abs(epoch - near) < Math.abs(best - near)) best = epoch;
    }
  }

  return best !== null && Math.abs(best - near) <= MAX_PLAUSIBLE_DELAY ? best : null;
}
