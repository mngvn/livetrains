import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Vehicle } from './api.ts';
import { TRAIL_SECONDS, VehicleTracker, type VehiclePushSource } from './vehicleTracker.ts';

type Payload = { vehicles: Vehicle[]; timestamp: number | null; error: string | null };

function vehicle(t: number, lon: number, overrides: Partial<Vehicle> = {}): Vehicle {
  return { id: 'v1', lat: 44.97, lon, timestamp: t, mode: 'bus', color: '0053A0', ...overrides } as Vehicle;
}

describe('VehicleTracker', () => {
  let push: (payload: Payload) => void = () => undefined;
  const source: VehiclePushSource = {
    mode: 'browser',
    onVehicles: (listener) => {
      push = listener;
      return () => undefined;
    },
    setRouteFilter: () => undefined,
  };

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('keeps one trail point per new report, ending at the marker', () => {
    const tracker = new VehicleTracker();
    tracker.connect({}, source);
    push({ vehicles: [vehicle(1000, -93.3)], timestamp: 1000, error: null });
    push({ vehicles: [vehicle(1015, -93.29)], timestamp: 1015, error: null });
    // A repeat of the same report adds nothing.
    push({ vehicles: [vehicle(1015, -93.29)], timestamp: 1015, error: null });
    push({ vehicles: [vehicle(1030, -93.28)], timestamp: 1030, error: null });
    const trail = tracker.trail('v1');
    expect(trail).toHaveLength(3);
    expect(trail[0]).toEqual([-93.3, 44.97]);
    tracker.disconnect();
  });

  it('forgets positions older than the trail span', () => {
    const tracker = new VehicleTracker();
    tracker.connect({}, source);
    push({ vehicles: [vehicle(0, -93.3)], timestamp: 0, error: null });
    push({ vehicles: [vehicle(60, -93.29)], timestamp: 60, error: null });
    push({ vehicles: [vehicle(TRAIL_SECONDS + 61, -93.28)], timestamp: TRAIL_SECONDS + 61, error: null });
    const trail = tracker.trail('v1');
    expect(trail.some(([lon]) => lon === -93.3)).toBe(false);
    tracker.disconnect();
  });

  it('keeps restored vehicles through a failed poll, and drops them for live ones', () => {
    const tracker = new VehicleTracker();
    tracker.connect({}, source);
    tracker.restore([vehicle(1000, -93.3, { id: 'old' })]);
    push({ vehicles: [], timestamp: null, error: 'offline' });
    expect(tracker.get('old')).toBeDefined();
    push({ vehicles: [vehicle(2000, -93.2, { id: 'new' })], timestamp: 2000, error: null });
    expect(tracker.get('old')).toBeUndefined();
    expect(tracker.get('new')).toBeDefined();
    expect(tracker.snapshot().map((v) => v.id)).toEqual(['new']);
    tracker.disconnect();
  });
});
