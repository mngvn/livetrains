import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteNetwork, Vehicle } from './api.ts';
import { TRAIL_SECONDS, VehicleTracker, type TrackedVehicle, type VehiclePushSource } from './vehicleTracker.ts';

type Payload = { vehicles: Vehicle[]; timestamp: number | null; error: string | null };

function vehicle(t: number, lon: number, overrides: Partial<Vehicle> = {}): Vehicle {
  return { id: 'v1', lat: 44.97, lon, timestamp: t, mode: 'bus', color: '0053A0', ...overrides } as Vehicle;
}

// Route r1 runs east along 44.97, then turns north at -93.29.
const network: RouteNetwork = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [-93.3, 44.97],
          [-93.29, 44.97],
          [-93.29, 44.98],
        ],
      },
      properties: { routeId: 'r1', color: '#0053A0', mode: 'bus', rail: false },
    },
  ],
};

describe('VehicleTracker', () => {
  let push: (payload: Payload) => void = () => undefined;
  let clock = 0;
  let frame: FrameRequestCallback | null = null;
  const source: VehiclePushSource = {
    mode: 'browser',
    onVehicles: (listener) => {
      push = listener;
      return () => undefined;
    },
    setRouteFilter: () => undefined,
  };

  beforeEach(() => {
    clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Where everything is drawn at a moment. */
  function drawnAt(tracker: VehicleTracker, at: number): TrackedVehicle[] {
    clock = at;
    let out: TrackedVehicle[] = [];
    const stop = tracker.onFrame((vehicles) => (out = vehicles));
    frame?.(at);
    stop();
    return out;
  }

  it('keeps one trail point per new report, ending at the marker', () => {
    const tracker = new VehicleTracker();
    tracker.connect({}, source);
    push({ vehicles: [vehicle(1000, -93.3)], timestamp: 1000, error: null });
    clock = 15_000;
    push({ vehicles: [vehicle(1015, -93.29)], timestamp: 1015, error: null });
    // A repeat of the same report adds nothing.
    clock = 20_000;
    push({ vehicles: [vehicle(1015, -93.29)], timestamp: 1015, error: null });
    clock = 30_000;
    push({ vehicles: [vehicle(1030, -93.28)], timestamp: 1030, error: null });

    // Mid-glide, the trail stops at the marker rather than running on to
    // reports it has not reached yet.
    const marker = drawnAt(tracker, 31_000)[0];
    const gliding = tracker.trail('v1');
    expect(gliding[0]).toEqual([-93.3, 44.97]);
    expect(gliding[gliding.length - 1]).toEqual([marker.displayLon, marker.displayLat]);
    expect(gliding.every(([lon]) => lon <= marker.displayLon)).toBe(true);

    // Arrived, it is every report in turn.
    clock = 60_000;
    expect(tracker.trail('v1')).toEqual([
      [-93.3, 44.97],
      [-93.29, 44.97],
      [-93.28, 44.97],
    ]);
    tracker.disconnect();
  });

  it('glides round the corner of its route rather than across it', () => {
    const tracker = new VehicleTracker();
    tracker.setNetwork(network);
    tracker.connect({}, source);
    push({ vehicles: [vehicle(1000, -93.295, { routeId: 'r1' })], timestamp: 1000, error: null });
    clock = 15_000;
    // The next report is round the corner, 400 m east and 550 m north.
    push({ vehicles: [vehicle(1015, -93.29, { routeId: 'r1', lat: 44.975 })], timestamp: 1015, error: null });

    for (let at = 15_000; at <= 35_000; at += 1_000) {
      const v = drawnAt(tracker, at)[0];
      const onLine = Math.abs(v.displayLat - 44.97) < 1e-9 || Math.abs(v.displayLon + 93.29) < 1e-9;
      expect(onLine, `at ${at}ms: ${v.displayLon}, ${v.displayLat}`).toBe(true);
    }
    // Past the corner, it faces north, the way the line now runs.
    const late = drawnAt(tracker, 28_000)[0];
    expect(late.displayLat).toBeGreaterThan(44.9705);
    expect(Math.min(late.displayBearing, 360 - late.displayBearing)).toBeLessThan(1);
    // And its trail follows the line too.
    expect(tracker.trail('v1')).toContainEqual([-93.29, 44.97]);
    tracker.disconnect();
  });

  it('is held to its line when its reports land a little off it', () => {
    const tracker = new VehicleTracker();
    tracker.setNetwork(network);
    tracker.connect({}, source);
    push({ vehicles: [vehicle(1000, -93.295, { routeId: 'r1', lat: 44.9702 })], timestamp: 1000, error: null });
    expect(drawnAt(tracker, 0)[0].displayLat).toBeCloseTo(44.97, 9);
    tracker.disconnect();
  });

  it('glides straight where there is no line to follow', () => {
    const tracker = new VehicleTracker();
    tracker.setNetwork(network);
    tracker.connect({}, source);
    // On a detour well clear of its route.
    push({ vehicles: [vehicle(1000, -93.295, { routeId: 'r1', lat: 44.975 })], timestamp: 1000, error: null });
    clock = 15_000;
    push({ vehicles: [vehicle(1015, -93.293, { routeId: 'r1', lat: 44.977 })], timestamp: 1015, error: null });
    const v = drawnAt(tracker, 15_000 + 9_000)[0];
    expect(v.displayLon).toBeCloseTo(-93.294, 9);
    expect(v.displayLat).toBeCloseTo(44.976, 9);
    tracker.disconnect();
  });

  it('forgets positions older than the trail span', () => {
    const tracker = new VehicleTracker();
    tracker.connect({}, source);
    push({ vehicles: [vehicle(0, -93.3)], timestamp: 0, error: null });
    clock = 15_000;
    push({ vehicles: [vehicle(60, -93.29)], timestamp: 60, error: null });
    clock = 30_000;
    push({ vehicles: [vehicle(TRAIL_SECONDS + 61, -93.28)], timestamp: TRAIL_SECONDS + 61, error: null });
    clock = 60_000;
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
