import type { TripStop, Vehicle, VehicleTrip } from './api.ts';

/**
 * Riding along: where you are on your trip, and when to get ready to get off.
 *
 * Worked out from the vehicle's own trip — its stops in order and which one
 * it is heading for — rather than from distances on the map, because "two
 * stops to go" is how a rider counts, and because a bus can be fifty metres
 * from your stop on the far side of a one-way loop.
 */

export type RidePhase =
  /** Riding, but no stop chosen yet. */
  | 'choose'
  /** More than one stop to go. */
  | 'riding'
  /** Your stop is the one after this. Time to gather your things. */
  | 'next'
  /** Your stop is the next one the vehicle reaches. */
  | 'arriving'
  /** The vehicle is at your stop. */
  | 'alight'
  /** The vehicle has left your stop behind: you are there, or you missed it. */
  | 'arrived';

export interface RideProgress {
  phase: RidePhase;
  /** Your stop, once chosen. */
  stop: TripStop | null;
  /** Stops between the vehicle and yours, counting yours; 0 at your stop. */
  stopsAway: number;
  /** Seconds until the vehicle reaches your stop, by the best time known. */
  secondsAway: number | null;
}

/** Where on the trip your stop is: the first call at or after the vehicle. */
export function alightIndex(trip: VehicleTrip, stopId: string): number {
  const ahead = trip.stops.findIndex((s, i) => i >= trip.nextStopIndex && s.stop.id === stopId);
  if (ahead >= 0) return ahead;
  // Already behind the vehicle, which means passed.
  return trip.stops.findIndex((s) => s.stop.id === stopId);
}

export function rideProgress(
  trip: VehicleTrip,
  stopId: string | null,
  vehicle: Pick<Vehicle, 'stopId' | 'currentStatus'> | null,
  now: number,
): RideProgress {
  if (!stopId) return { phase: 'choose', stop: null, stopsAway: 0, secondsAway: null };
  const index = alightIndex(trip, stopId);
  if (index < 0) return { phase: 'choose', stop: null, stopsAway: 0, secondsAway: null };

  const stop = trip.stops[index];
  const stopsAway = index - trip.nextStopIndex;
  const at = stop.predictedTime ?? stop.scheduledTime;
  const secondsAway = Math.max(0, at - now);

  if (stopsAway < 0) return { phase: 'arrived', stop, stopsAway: 0, secondsAway: 0 };
  if (stopsAway === 0) {
    const there = vehicle?.stopId === stop.stop.id && vehicle.currentStatus === 'stopped';
    return { phase: there ? 'alight' : 'arriving', stop, stopsAway, secondsAway };
  }
  return { phase: stopsAway === 1 ? 'next' : 'riding', stop, stopsAway, secondsAway };
}

/** How hard each phase taps: nothing, a nudge, then insistent. */
export const RIDE_VIBRATION: Partial<Record<RidePhase, number[]>> = {
  next: [60],
  arriving: [120, 80, 120],
  alight: [220, 100, 220, 100, 220],
};
