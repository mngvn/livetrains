import { describe, expect, it } from 'vitest';
import type { Itinerary, Leg, RouteSummary, StopSummary } from './api.ts';
import { buildJourney, positionAt, trailAt } from './journey.ts';

const ROUTE: RouteSummary = {
  id: 'r', shortName: 'Blue', longName: 'Blue Line', color: '0055a5', textColor: 'ffffff',
  mode: 'rail', sortOrder: 0,
} as RouteSummary;

const stop = (name: string, lon: number, lat: number): StopSummary =>
  ({ id: name, name, lat, lon, code: null, routes: [] }) as unknown as StopSummary;

const walk = (from: number, to: number, path: [number, number][]): Leg => ({
  type: 'walk',
  from: { name: 'A', lat: path[0][1], lon: path[0][0], kind: 'coordinate' },
  to: { name: 'B', lat: path[path.length - 1][1], lon: path[path.length - 1][0], kind: 'coordinate' },
  distanceMeters: 300, durationSeconds: to - from,
  departureTime: from, arrivalTime: to, geometry: path,
}) as Leg;

const ride = (from: number, to: number, path: [number, number][]): Leg => ({
  type: 'transit', route: ROUTE, tripId: 't', headsign: 'Downtown', directionId: 0,
  from: stop('Board', path[0][0], path[0][1]),
  to: stop('Alight', path[path.length - 1][0], path[path.length - 1][1]),
  departureTime: from, arrivalTime: to,
  scheduledDepartureTime: from, scheduledArrivalTime: to,
  delaySeconds: null, isRealtime: false, numStops: 3, intermediateStops: [], geometry: path,
}) as Leg;

const itinerary = (legs: Leg[]): Itinerary => ({
  departureTime: legs[0].departureTime,
  arrivalTime: legs[legs.length - 1].arrivalTime,
  durationSeconds: legs[legs.length - 1].arrivalTime - legs[0].departureTime,
  walkDistanceMeters: 0, walkDurationSeconds: 0, transfers: 0, hasRealtime: false, legs,
});

// A walk west to east, then a wait, then a ride further east.
const WALK_PATH: [number, number][] = [[-93.28, 44.98], [-93.27, 44.98]];
const RIDE_PATH: [number, number][] = [[-93.27, 44.98], [-93.25, 44.98], [-93.23, 44.98]];

describe('buildJourney', () => {
  it('turns the gap between legs into a wait the rider can see', () => {
    const journey = buildJourney(itinerary([walk(0, 300, WALK_PATH), ride(900, 1500, RIDE_PATH)]))!;
    expect(journey.steps.map((s) => s.kind)).toEqual(['walk', 'wait', 'ride']);
    const wait = journey.steps[1];
    expect(wait.startTime).toBe(300);
    expect(wait.endTime).toBe(900);
    expect(wait.label).toContain('Blue');
  });

  it('adds no wait when a leg starts the moment the last one ends', () => {
    const journey = buildJourney(itinerary([walk(0, 300, WALK_PATH), ride(300, 900, RIDE_PATH)]))!;
    expect(journey.steps.map((s) => s.kind)).toEqual(['walk', 'ride']);
  });

  it('spans from the first departure to the last arrival', () => {
    const journey = buildJourney(itinerary([walk(60, 300, WALK_PATH), ride(900, 1500, RIDE_PATH)]))!;
    expect(journey.startTime).toBe(60);
    expect(journey.endTime).toBe(1500);
    expect(journey.durationSeconds).toBe(1440);
  });

  it('returns null for an itinerary with no duration', () => {
    expect(buildJourney(itinerary([walk(100, 100, WALK_PATH)]))).toBeNull();
  });

  it('survives a leg whose geometry collapsed to nothing', () => {
    const broken = { ...walk(0, 300, WALK_PATH), geometry: [] } as Leg;
    const journey = buildJourney(itinerary([broken, ride(300, 900, RIDE_PATH)]))!;
    expect(journey.steps).toHaveLength(2);
    // The broken leg still consumes its own time rather than shifting the ride.
    expect(journey.steps[1].startTime).toBe(300);
  });
});

describe('positionAt', () => {
  const journey = buildJourney(itinerary([walk(0, 300, WALK_PATH), ride(900, 1500, RIDE_PATH)]))!;

  it('starts at the origin and ends at the destination', () => {
    expect(positionAt(journey, 0).lon).toBeCloseTo(-93.28, 6);
    expect(positionAt(journey, 1500).lon).toBeCloseTo(-93.23, 6);
  });

  it('clamps outside the journey rather than vanishing', () => {
    expect(positionAt(journey, -9999).lon).toBeCloseTo(-93.28, 6);
    expect(positionAt(journey, 999999).lon).toBeCloseTo(-93.23, 6);
    expect(positionAt(journey, 999999).progress).toBe(1);
  });

  it('interpolates along a walk', () => {
    expect(positionAt(journey, 150).lon).toBeCloseTo(-93.275, 4);
  });

  it('stands still through the wait', () => {
    const early = positionAt(journey, 320);
    const late = positionAt(journey, 880);
    expect(early.step.kind).toBe('wait');
    expect(late.step.kind).toBe('wait');
    expect(early.lon).toBeCloseTo(late.lon, 9);
    expect(early.lat).toBeCloseTo(late.lat, 9);
  });

  it('crosses the ride s middle vertex at the halfway point', () => {
    // The two ride segments are equal length, so half the time is the vertex.
    expect(positionAt(journey, 1200).lon).toBeCloseTo(-93.25, 3);
  });

  it('reports progress across the whole journey, waits included', () => {
    expect(positionAt(journey, 0).progress).toBe(0);
    expect(positionAt(journey, 750).progress).toBeCloseTo(0.5, 2);
    expect(positionAt(journey, 1500).progress).toBe(1);
  });

  it('faces the way it is going', () => {
    // Both legs run due east.
    expect(positionAt(journey, 150).bearing).toBeCloseTo(90, 0);
    expect(positionAt(journey, 1200).bearing).toBeCloseTo(90, 0);
  });
});

describe('trailAt', () => {
  const journey = buildJourney(itinerary([walk(0, 300, WALK_PATH), ride(900, 1500, RIDE_PATH)]))!;

  it('is empty at the very start', () => {
    expect(trailAt(journey, 0)).toEqual([]);
  });

  it('ends at the traveller, not at the end of the step', () => {
    const [segment] = trailAt(journey, 150);
    const last = segment.path[segment.path.length - 1];
    expect(last[0]).toBeCloseTo(positionAt(journey, 150).lon, 9);
  });

  it('keeps each leg s own colour', () => {
    const trail = trailAt(journey, 1200);
    expect(trail).toHaveLength(2);
    expect(trail[0].color).not.toBe(trail[1].color);
    expect(trail[1].color).toBe('#0055a5');
  });

  it('covers the whole route once the journey is done', () => {
    const trail = trailAt(journey, 1500);
    const last = trail[trail.length - 1].path.at(-1)!;
    expect(last[0]).toBeCloseTo(-93.23, 6);
  });
});
