import { describe, expect, it } from 'vitest';
import type { ServiceAlert, Vehicle, VehicleTrip } from './api.ts';
import { distanceAlong, explainDelay } from './lateness.ts';

const NOW = 1_800_000_000;

/** A straight line north, about 1.1 km per 0.01° of latitude. */
const LINE: [number, number][] = [
  [-93.27, 44.95],
  [-93.27, 44.96],
  [-93.27, 44.97],
  [-93.27, 44.98],
];

function bus(id: string, lat: number, delaySeconds?: number, extra: Partial<Vehicle> = {}): Vehicle {
  return {
    id,
    routeId: '21',
    routeShortName: '21',
    directionId: 0,
    mode: 'bus',
    color: '0053A0',
    lat,
    lon: -93.27,
    timestamp: NOW - 10,
    delaySeconds,
    ...extra,
  } as Vehicle;
}

function trip(alerts: ServiceAlert[] = [], nextStopIndex = 5): VehicleTrip {
  return {
    vehicleId: 'a',
    tripId: 't',
    route: { id: '21', shortName: '21', longName: '', mode: 'bus', color: '0053A0', textColor: 'FFFFFF' },
    headsign: 'Uptown',
    geometry: LINE,
    stops: Array.from({ length: 8 }, (_, i) => ({
      stop: { id: `S${i}`, code: `S${i}`, name: `Stop ${i}`, lat: 44.95 + i * 0.004, lon: -93.27 },
      scheduledTime: NOW - 3600 + i * 300,
      predictedTime: null,
      delaySeconds: null,
      skipped: false,
    })),
    nextStopIndex,
    alerts,
  };
}

describe('distanceAlong', () => {
  it('measures along the line, not as the crow flies', () => {
    expect(distanceAlong(LINE, [-93.27, 44.95])).toBeCloseTo(0, 0);
    expect(distanceAlong(LINE, [-93.27, 44.97])!).toBeGreaterThan(2_200);
    expect(distanceAlong(LINE, [-93.27, 44.97])!).toBeLessThan(2_250);
  });
});

describe('explainDelay', () => {
  it('has nothing to explain about a bus on time', () => {
    expect(explainDelay({ vehicle: bus('a', 44.96, 60), trip: trip(), others: [], history: [], now: NOW })).toBeNull();
  });

  it('spots the bus ahead it has caught up with', () => {
    const result = explainDelay({
      vehicle: bus('a', 44.96, 420),
      trip: trip(),
      others: [bus('b', 44.963, 30), bus('c', 44.975, 0, { directionId: 1 })],
      history: [],
      now: NOW,
    })!;
    expect(result.minutes).toBe(7);
    expect(result.reasons[0]).toMatchObject({ kind: 'bunching', title: 'Bunched with the bus ahead' });
  });

  it('leads with the agency’s own alert', () => {
    const detour: ServiceAlert = {
      id: 'd',
      header: 'Route 21 detoured at Lake St',
      description: '',
      effect: 'DETOUR',
      routeIds: ['21'],
      stopIds: [],
      informed: [{ routeId: '21' }],
      periods: [],
    };
    const result = explainDelay({ vehicle: bus('a', 44.96, 400), trip: trip([detour]), others: [], history: [], now: NOW })!;
    expect(result.reasons[0]).toEqual({ kind: 'alert', title: 'Detour', detail: 'Route 21 detoured at Lake St' });
  });

  it('tells losing time from steady lateness', () => {
    const losing = explainDelay({
      vehicle: bus('a', 44.96, 480),
      trip: trip(),
      others: [],
      history: [
        { t: NOW - 600, delay: 180 },
        { t: NOW - 30, delay: 480 },
      ],
      now: NOW,
    })!;
    expect(losing.reasons[0].title).toBe('Losing time');

    const steady = explainDelay({
      vehicle: bus('a', 44.96, 400),
      trip: trip(),
      others: [],
      history: [
        { t: NOW - 600, delay: 390 },
        { t: NOW - 30, delay: 400 },
      ],
      now: NOW,
    })!;
    expect(steady.reasons[0].title).toBe('Steady, not getting worse');
  });

  it('says plainly when nothing explains it', () => {
    const result = explainDelay({ vehicle: bus('a', 44.96, 300), trip: trip(), others: [], history: [], now: NOW })!;
    expect(result.reasons).toEqual([expect.objectContaining({ kind: 'unknown' })]);
  });
});
