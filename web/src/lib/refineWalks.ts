import type { Itinerary, WalkLeg } from './api.ts';
import type { WalkRouter } from './walkRouter.ts';

/**
 * Replaces an itinerary's straight-line walks with real walking directions.
 *
 * The planner's estimate decided *which* trip to take; this decides what the
 * walking actually looks like and how long it really is. Only the legs change
 * — the rides are the timetable's and are not up for revision — but their
 * times shift with them, because a walk that turns out to be four minutes
 * longer than estimated means leaving four minutes earlier, and an itinerary
 * that said otherwise would be lying about the one number a rider acts on.
 */

/** A conservative pace, for turning a routed distance into a leg duration. */
const FALLBACK_SPEED = 1.33;

export async function refineWalks(
  itinerary: Itinerary,
  router: WalkRouter,
  signal?: AbortSignal,
): Promise<Itinerary> {
  if (!router.enabled) return itinerary;

  const routed = await Promise.all(
    itinerary.legs.map((leg) =>
      leg.type === 'walk'
        ? router.route(
            { lat: leg.from.lat, lon: leg.from.lon },
            { lat: leg.to.lat, lon: leg.to.lon },
            leg.distanceMeters,
          )
        : Promise.resolve(null),
    ),
  );
  if (signal?.aborted) return itinerary;
  if (routed.every((path) => path === null)) return itinerary;

  const legs = itinerary.legs.map((leg, index) => {
    const path = routed[index];
    if (leg.type !== 'walk' || !path) return leg;
    return {
      ...leg,
      geometry: path.geometry,
      distanceMeters: path.distanceMeters,
      // Valhalla's pedestrian time is generous on crossings and stairs, but a
      // walk can only get shorter than the estimate by being genuinely
      // shorter, so take the longer of the two rather than promising a pace
      // the rider has to hit.
      durationSeconds: Math.max(path.durationSeconds, Math.round(path.distanceMeters / FALLBACK_SPEED)),
    } satisfies WalkLeg;
  });

  return retime({ ...itinerary, legs });
}

/**
 * Re-hangs an itinerary's clock after its walks changed length.
 *
 * Rides are fixed points: the train leaves when it leaves. So walks before a
 * ride are pinned to its departure and run *backwards* from it — arrive just
 * in time, rather than arrive early and stand there — and walks after a ride
 * run forwards from its arrival. That keeps every boarding time untouched
 * while the departure from the door and the arrival at the destination move
 * to tell the truth.
 */
function retime(itinerary: Itinerary): Itinerary {
  const legs = itinerary.legs.map((leg) => ({ ...leg }));
  const firstRide = legs.findIndex((leg) => leg.type === 'transit');

  if (firstRide === -1) {
    // A walk-only itinerary keeps its departure and moves its arrival. Every
    // leg is a walk here, by definition of there being no ride.
    let clock = itinerary.departureTime;
    for (const leg of legs) {
      if (leg.type !== 'walk') continue;
      leg.departureTime = clock;
      clock += leg.durationSeconds;
      leg.arrivalTime = clock;
    }
  } else {
    // Backwards from the first boarding.
    let clock = legs[firstRide].departureTime;
    for (let i = firstRide - 1; i >= 0; i--) {
      const leg = legs[i] as WalkLeg;
      leg.arrivalTime = clock;
      leg.departureTime = clock - leg.durationSeconds;
      clock = leg.departureTime;
    }
    // Forwards from each ride, through the walks that follow it.
    for (let i = firstRide; i < legs.length; i++) {
      const leg = legs[i];
      if (leg.type === 'transit') continue;
      const previous = legs[i - 1];
      leg.departureTime = previous.arrivalTime;
      leg.arrivalTime = leg.departureTime + leg.durationSeconds;
      // A walk between two rides must still make its connection; if the new
      // path does not fit, the itinerary is no longer viable and says so by
      // keeping the later boarding rather than pretending the walk was quick.
      const next = legs[i + 1];
      if (next && next.type === 'transit' && leg.arrivalTime > next.departureTime) {
        leg.arrivalTime = next.departureTime;
      }
    }
  }

  const walks = legs.filter((leg): leg is WalkLeg => leg.type === 'walk');
  return {
    ...itinerary,
    legs,
    departureTime: legs[0].departureTime,
    arrivalTime: legs[legs.length - 1].arrivalTime,
    durationSeconds: legs[legs.length - 1].arrivalTime - legs[0].departureTime,
    walkDistanceMeters: walks.reduce((total, leg) => total + leg.distanceMeters, 0),
    walkDurationSeconds: walks.reduce((total, leg) => total + leg.durationSeconds, 0),
  };
}
