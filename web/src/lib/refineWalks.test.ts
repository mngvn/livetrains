import { describe, expect, it } from 'vitest';
import type { Itinerary, Leg, RouteSummary, StopSummary } from './api.ts';
import { refineWalks } from './refineWalks.ts';
import { readValhalla, WalkRouter, type WalkPath } from './walkRouter.ts';

const ROUTE = { id: 'r', shortName: 'Blue', longName: 'Blue Line', color: '0055a5',
  textColor: 'ffffff', mode: 'rail', sortOrder: 0 } as RouteSummary;
const stop = (name: string, lon: number, lat: number) =>
  ({ id: name, name, lat, lon, code: null, routes: [] }) as unknown as StopSummary;

const walk = (from: number, to: number, meters = 300): Leg => ({
  type: 'walk',
  from: { name: 'A', lat: 44.98, lon: -93.28, kind: 'coordinate' },
  to: { name: 'B', lat: 44.98, lon: -93.27, kind: 'coordinate' },
  distanceMeters: meters, durationSeconds: to - from,
  departureTime: from, arrivalTime: to,
  geometry: [[-93.28, 44.98], [-93.27, 44.98]],
}) as Leg;

const ride = (from: number, to: number): Leg => ({
  type: 'transit', route: ROUTE, tripId: 't', headsign: 'Downtown', directionId: 0,
  from: stop('Board', -93.27, 44.98), to: stop('Alight', -93.23, 44.98),
  departureTime: from, arrivalTime: to,
  scheduledDepartureTime: from, scheduledArrivalTime: to,
  delaySeconds: null, isRealtime: false, numStops: 3, intermediateStops: [],
  geometry: [[-93.27, 44.98], [-93.23, 44.98]],
}) as Leg;

const itin = (legs: Leg[]): Itinerary => ({
  departureTime: legs[0].departureTime,
  arrivalTime: legs[legs.length - 1].arrivalTime,
  durationSeconds: legs[legs.length - 1].arrivalTime - legs[0].departureTime,
  walkDistanceMeters: 300, walkDurationSeconds: 300, transfers: 0, hasRealtime: false, legs,
});

/** A router that answers every walk with the same fixed path. */
function stubRouter(path: WalkPath | null, enabled = true): WalkRouter {
  return { enabled, route: () => Promise.resolve(path) } as unknown as WalkRouter;
}

const DOGLEG: WalkPath = {
  // Round a block rather than through it.
  geometry: [[-93.28, 44.98], [-93.28, 44.9805], [-93.27, 44.9805], [-93.27, 44.98]],
  distanceMeters: 460,
  durationSeconds: 400,
};

describe('refineWalks', () => {
  it('replaces the straight line with the routed path', async () => {
    const result = await refineWalks(itin([walk(0, 300), ride(300, 900)]), stubRouter(DOGLEG));
    const leg = result.legs[0];
    expect(leg.type).toBe('walk');
    expect(leg.geometry).toEqual(DOGLEG.geometry);
    expect(leg.type === 'walk' && leg.distanceMeters).toBe(460);
  });

  it('leaves the itinerary alone when the router declines', async () => {
    const before = itin([walk(0, 300), ride(300, 900)]);
    expect(await refineWalks(before, stubRouter(null))).toBe(before);
  });

  it('does nothing at all when routing is switched off', async () => {
    const before = itin([walk(0, 300), ride(300, 900)]);
    expect(await refineWalks(before, stubRouter(DOGLEG, false))).toBe(before);
  });

  it('leaves the ride s times untouched', async () => {
    const result = await refineWalks(itin([walk(0, 300), ride(300, 900)]), stubRouter(DOGLEG));
    const rideLeg = result.legs[1];
    expect(rideLeg.departureTime).toBe(300);
    expect(rideLeg.arrivalTime).toBe(900);
  });

  it('moves the departure earlier when the real walk is longer', async () => {
    // The walk was 300s and is really 400s, so setting off 100s sooner is the
    // only way to still catch the same train.
    const result = await refineWalks(itin([walk(0, 300), ride(300, 900)]), stubRouter(DOGLEG));
    expect(result.legs[0].departureTime).toBe(-100);
    expect(result.legs[0].arrivalTime).toBe(300);
    expect(result.departureTime).toBe(-100);
    expect(result.durationSeconds).toBe(1000);
  });

  it('moves the arrival later when the walk off the train is longer', async () => {
    const result = await refineWalks(itin([ride(0, 600), walk(600, 900)]), stubRouter(DOGLEG));
    expect(result.legs[0].arrivalTime).toBe(600);
    expect(result.legs[1].departureTime).toBe(600);
    expect(result.legs[1].arrivalTime).toBe(1000);
    expect(result.arrivalTime).toBe(1000);
  });

  it('will not stretch a transfer walk past the connection it has to make', async () => {
    // Nine minutes between rides, and a walk the router says takes 400s: fine.
    // The walk must not be allowed to claim it arrives after the second train
    // has already left.
    const slow: WalkPath = { ...DOGLEG, durationSeconds: 5_000, distanceMeters: 6_000 };
    const result = await refineWalks(
      itin([ride(0, 600), walk(600, 700), ride(1_140, 1_800)]),
      stubRouter(slow),
    );
    expect(result.legs[1].arrivalTime).toBeLessThanOrEqual(result.legs[2].departureTime);
    expect(result.legs[2].departureTime).toBe(1_140);
  });

  it('recomputes the walking totals', async () => {
    const result = await refineWalks(
      itin([walk(0, 300), ride(300, 900), walk(900, 1_200)]),
      stubRouter(DOGLEG),
    );
    expect(result.walkDistanceMeters).toBe(920);
    expect(result.walkDurationSeconds).toBe(800);
  });

  it('retimes a walk-only itinerary from its departure', async () => {
    const result = await refineWalks(itin([walk(0, 300)]), stubRouter(DOGLEG));
    expect(result.departureTime).toBe(0);
    expect(result.arrivalTime).toBe(400);
  });

  it('never quotes a pace faster than a walk', async () => {
    // A router claiming 60s for 460m is claiming 27km/h. Take the slower figure.
    const sprint: WalkPath = { ...DOGLEG, durationSeconds: 60 };
    const result = await refineWalks(itin([walk(0, 300), ride(300, 900)]), stubRouter(sprint));
    const leg = result.legs[0];
    expect(leg.type === 'walk' && leg.durationSeconds).toBe(Math.round(460 / 1.33));
  });
});

describe('readValhalla', () => {
  const body = (extra: object = {}) => ({
    trip: {
      legs: [{ shape: 'ewy~gAhgcflEuAaA' }],
      summary: { length: 0.46, time: 400 },
      ...extra,
    },
  });

  it('reads shape, distance and duration', () => {
    const path = readValhalla(body())!;
    expect(path.distanceMeters).toBe(460);
    expect(path.durationSeconds).toBe(400);
    expect(path.geometry.length).toBeGreaterThanOrEqual(2);
  });

  it('returns null for anything it does not recognise', () => {
    for (const junk of [null, undefined, 42, 'no', {}, { trip: {} }, { trip: { legs: [] } }]) {
      expect(readValhalla(junk)).toBeNull();
    }
  });

  it('returns null when the summary is missing its numbers', () => {
    expect(readValhalla({ trip: { legs: [{ shape: 'ewy~gAhgcflEuAaA' }], summary: {} } })).toBeNull();
  });

  it('joins multiple legs without repeating the shared point', () => {
    const one = readValhalla(body())!;
    const two = readValhalla({
      trip: { legs: [{ shape: 'ewy~gAhgcflEuAaA' }, { shape: 'ewy~gAhgcflEuAaA' }], summary: { length: 0.92, time: 800 } },
    })!;
    expect(two.geometry.length).toBe(one.geometry.length * 2 - 1);
  });
});
