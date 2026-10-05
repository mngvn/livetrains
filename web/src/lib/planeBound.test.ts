import { describe, expect, it } from 'vitest';
import type { Plane } from '@shared/planes.ts';
import { bearingTo, distanceKm, flyingTime, greatCircle, whereBound } from './planeBound.ts';
import type { Airport } from './planeLookup.ts';

function plane(overrides: Partial<Plane> = {}): Plane {
  return { id: 'a', lat: 44.95, lon: -93.25, onGround: false, altitude: 12000, groundSpeed: 300, track: 90, positionAt: 0, ...overrides };
}

const ATL: Airport = { iata: 'ATL', icao: 'KATL', name: 'Hartsfield Jackson', city: 'Atlanta', lat: 33.6367, lon: -84.4281 };

describe('whereBound', () => {
  it('trusts a published route, with distance and time at its speed', () => {
    const b = whereBound(plane(), { destination: ATL })!;
    expect(b.kind).toBe('destination');
    expect(b.place).toMatchObject({ code: 'ATL', name: 'Atlanta' });
    expect(b.miles).toBeGreaterThan(880);
    expect(b.miles).toBeLessThan(940);
    // 300 knots is 345 mph: a little over two and a half hours.
    expect(b.minutes).toBeGreaterThan(150);
    expect(b.minutes).toBeLessThan(165);
  });

  it('spots a small plane on approach to a local airport', () => {
    // A few miles east of Flying Cloud, heading west and coming down.
    const b = whereBound(plane({ lat: 44.83, lon: -93.37, track: 268, altitude: 1800, verticalRate: -500, groundSpeed: 80 }), null)!;
    expect(b.kind).toBe('landing');
    expect(b.place.code).toBe('FCM');
    expect(b.miles).toBeLessThan(5);
  });

  it('does not call a plane flying away from an airport a landing', () => {
    const b = whereBound(plane({ lat: 44.83, lon: -93.37, track: 180, altitude: 1800, verticalRate: -500, groundSpeed: 80 }), null);
    expect(b?.kind).not.toBe('landing');
  });

  it('otherwise names the nearest city along its heading', () => {
    // Due south, level: Des Moines.
    expect(whereBound(plane({ track: 180, verticalRate: 0 }), null)).toMatchObject({ kind: 'toward', place: { name: 'Des Moines' } });
    // Set for Fargo, it passes St Cloud first, and that is what lies ahead.
    const fargo = bearingTo({ lat: 44.95, lon: -93.25 }, { lat: 46.92, lon: -96.8158 });
    expect(whereBound(plane({ track: fargo, verticalRate: 0 }), null)?.place.name).toBe('St Cloud');
  });

  it('says nothing for a plane on the ground or without a heading', () => {
    expect(whereBound(plane({ onGround: true }), null)).toBeNull();
    expect(whereBound(plane({ track: undefined }), null)).toBeNull();
  });
});

describe('greatCircle', () => {
  it('runs end to end and bows north of the straight line', () => {
    const msp = { lat: 44.88, lon: -93.22 };
    const lhr = { lat: 51.47, lon: -0.45 };
    const path = greatCircle(msp, lhr, 32);
    expect(path[0][0]).toBeCloseTo(-93.22, 6);
    expect(path[32][1]).toBeCloseTo(51.47, 6);
    expect(Math.max(...path.map((p) => p[1]))).toBeGreaterThan(55);
  });
  it('measures distance', () => {
    expect(distanceKm({ lat: 44.88, lon: -93.22 }, ATL)).toBeCloseTo(1460, -1);
  });
});

describe('flyingTime', () => {
  it('rounds short times to the minute and long ones to five', () => {
    expect(flyingTime(6.4)).toBe('about 6 min');
    expect(flyingTime(0.2)).toBe('about 1 min');
    expect(flyingTime(157)).toBe('about 2 hr 35 min');
    expect(flyingTime(120)).toBe('about 2 hr');
  });
});
