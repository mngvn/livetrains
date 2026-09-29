import { describe, expect, it } from 'vitest';
import type { Itinerary, Leg } from './api.ts';
import { BOARDING_BUFFER_SECONDS, leaveBy, walkBeforeBoarding } from './leaveReminder.ts';

const T = 1_800_000_000;
const place = { id: 'p', name: 'P', lat: 45, lon: -93, kind: 'coordinate' as const };
const stop = { id: 's', code: '1', name: 'S', lat: 45, lon: -93 };

function walk(seconds: number): Leg {
  return { type: 'walk', from: place, to: place, distanceMeters: seconds, durationSeconds: seconds, departureTime: T, arrivalTime: T + seconds, geometry: [] };
}

function ride(departs: number): Leg {
  return {
    type: 'transit',
    route: { id: '21', shortName: '21', longName: '', mode: 'bus', color: '000000', textColor: 'FFFFFF' },
    tripId: 'trip',
    headsign: 'Uptown',
    directionId: 0,
    from: stop,
    to: stop,
    departureTime: departs,
    arrivalTime: departs + 600,
    scheduledDepartureTime: departs,
    scheduledArrivalTime: departs + 600,
    delaySeconds: null,
    isRealtime: false,
    numStops: 3,
    intermediateStops: [],
    geometry: [],
  };
}

function itinerary(legs: Leg[]): Itinerary {
  return { departureTime: T, arrivalTime: T + 1800, durationSeconds: 1800, walkDistanceMeters: 0, walkDurationSeconds: 0, transfers: 0, hasRealtime: false, legs };
}

describe('leave-by', () => {
  it('counts only the walking before the first boarding', () => {
    expect(walkBeforeBoarding(itinerary([walk(240), walk(60), ride(T + 600), walk(500)]))).toBe(300);
  });

  it('works back from the vehicle, less the walk and a minute of slack', () => {
    const trip = itinerary([walk(300), ride(T + 900)]);
    expect(leaveBy(trip)).toBe(T + 900 - 300 - BOARDING_BUFFER_SECONDS);
  });

  it('follows a live prediction when there is one', () => {
    const trip = itinerary([walk(300), ride(T + 900)]);
    expect(leaveBy(trip, T + 1_140)).toBe(T + 1_140 - 300 - BOARDING_BUFFER_SECONDS);
  });

  it('leaves a walk-only trip when it was planned', () => {
    expect(leaveBy(itinerary([walk(600)]))).toBe(T);
  });
});
