import { describe, expect, it } from 'vitest';
import { approachFeatures, findApproaches, type ApproachStop, type ApproachVehicle } from './approach.ts';

// About 111 m per 0.001° of latitude.
const STOP: ApproachStop = { id: 'S', lat: 44.98, lon: -93.27, routeIds: new Set(['R']) };
const stops = new Map([[STOP.id, STOP]]);

function bus(overrides: Partial<ApproachVehicle>): ApproachVehicle {
  return { id: 'v', routeId: 'R', lat: STOP.lat - 0.001, lon: STOP.lon, bearing: 0, speed: 8, stale: false, ...overrides };
}

describe('findApproaches', () => {
  it('links a vehicle heading for a stop on its route, closer as it nears', () => {
    const [far] = findApproaches([bus({ lat: STOP.lat - 0.002 })], stops);
    const [near] = findApproaches([bus({ lat: STOP.lat - 0.0005 })], stops);
    expect(far).toMatchObject({ stopId: 'S', stopped: false });
    expect(near.closeness).toBeGreaterThan(far.closeness);
  });

  it('leaves out a stop the vehicle has passed, or that is not on its route', () => {
    expect(findApproaches([bus({ bearing: 180 })], stops)).toEqual([]);
    expect(findApproaches([bus({ routeId: 'OTHER' })], stops)).toEqual([]);
  });

  it('leaves out a vehicle out of range, or with a stale position', () => {
    expect(findApproaches([bus({ lat: STOP.lat - 0.004 })], stops)).toEqual([]);
    expect(findApproaches([bus({ stale: true })], stops)).toEqual([]);
  });

  it('calls a vehicle standing at the stop stopped', () => {
    const [at] = findApproaches([bus({ lat: STOP.lat, speed: 0 })], stops);
    expect(at).toMatchObject({ stopped: true, closeness: 1 });
  });

  it("takes the feed's stop and status over its own guess", () => {
    const [a] = findApproaches([bus({ bearing: 180, stopId: 'S', currentStatus: 'stopped' })], stops);
    expect(a).toMatchObject({ stopId: 'S', stopped: true });
  });
});

describe('approachFeatures', () => {
  it('rings each stop once, green if any vehicle is standing there', () => {
    const approaches = findApproaches(
      [bus({ id: 'a' }), bus({ id: 'b', lat: STOP.lat, speed: 0 })],
      stops,
    );
    const { lines, rings } = approachFeatures(approaches);
    expect(lines.features).toHaveLength(2);
    expect(rings.features).toHaveLength(1);
    expect(rings.features[0].properties).toMatchObject({ stopped: true });
  });
});
