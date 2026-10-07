import { beforeAll, describe, expect, it } from 'vitest';
import type { GtfsStore } from './gtfs/store.js';
import { PatternSet } from './planner/patterns.js';
import { RealtimeState } from './realtime/state.js';
import { createMockSystem } from './mock/index.js';
import { alertPlaces, routeDetail, searchTransit, sortedRoutes, stopDetail, vehicleTrip } from './queries.js';

let store: GtfsStore;
let patterns: PatternSet;
let realtime: RealtimeState;

beforeAll(() => {
  const system = createMockSystem();
  store = system.store;
  patterns = PatternSet.build(store);
  realtime = new RealtimeState();
  realtime.setVehicles(system.simulator.vehicles(), store);
  realtime.setTripUpdates(system.simulator.tripUpdates(), store);
  realtime.setAlerts(system.simulator.alerts());
});

describe('store: operators, accessibility, stations', () => {
  it('reads every agency, not just the first', () => {
    expect(store.agencies.map((a) => a.id)).toEqual(['MOCK', 'SUBURB']);
  });

  it('knows which operator runs each route', () => {
    const five = store.routes.find((r) => r.shortName === '5')!;
    const blue = store.routes.find((r) => r.shortName === 'Blue')!;
    expect(store.agencyOf(five)?.name).toContain('Suburban');
    expect(store.agencyOf(blue)?.name).toContain('Demo Transit');
  });

  it('reads wheelchair boarding, and says nothing where the feed does not', () => {
    const at = (id: string) => store.stops[store.stopIndexById.get(id)!];
    expect(at('BL01').wheelchair).toBe(1);
    expect(at('R21B').wheelchair).toBe(2);
    expect(at('R21A').wheelchair).toBe(0);
  });

  it('reads per-trip accessibility', () => {
    const blueTrip = store.tripIndexById.get('BLUE_0_0')!;
    expect(store.tripWheelchair[blueTrip]).toBe(1);
  });

  it('groups pathways under their station', () => {
    const platform = store.stopIndexById.get('BL03')!;
    const pathways = store.stationPathways.get(store.stationOf(platform)) ?? [];
    expect(pathways.map((p) => p.mode).sort()).toEqual(['elevator', 'stairs']);
    expect(pathways.find((p) => p.mode === 'stairs')?.stairCount).toBe(22);
  });

  it('does not load a station entrance as a boardable stop', () => {
    expect(store.stopIndexById.has('NICOLLET-STN-E1')).toBe(false);
  });
});

describe('sortedRoutes', () => {
  it('puts rail first and carries the operator', () => {
    const routes = sortedRoutes(store);
    expect(routes[0].mode).toBe('tram');
    expect(routes.every((r) => r.operator?.name)).toBe(true);
  });
});

describe('routeDetail', () => {
  it('returns null for a route that does not exist', () => {
    expect(routeDetail(store, patterns, realtime, 'NOPE')).toBeNull();
  });

  it('includes alerts for that route only', () => {
    const detail = routeDetail(store, patterns, realtime, 'ROUTE21')!;
    expect(detail.alerts.map((a) => a.id)).toEqual(['mock-alert-2']);
  });
});

describe('stopDetail', () => {
  it('lists every route calling at the stop', () => {
    const detail = stopDetail(store, patterns, realtime, 'BL03', 10)!;
    expect(detail.routes.map((r) => r.shortName)).toEqual(expect.arrayContaining(['Blue', 'Green']));
  });

  it('describes the station a platform is in', () => {
    const detail = stopDetail(store, patterns, realtime, 'BL03', 10)!;
    expect(detail.station?.name).toBe('Nicollet Mall Station');
    expect(detail.station?.pathways.some((p) => p.mode === 'elevator')).toBe(true);
  });

  it('shows the elevator outage at that station, and not elsewhere on the line', () => {
    expect(stopDetail(store, patterns, realtime, 'BL03', 10)!.alerts.map((a) => a.id)).toContain('mock-alert-1');
    expect(stopDetail(store, patterns, realtime, 'BL01', 10)!.alerts.map((a) => a.id)).not.toContain('mock-alert-1');
  });

  it('carries accessibility on the stop', () => {
    expect(stopDetail(store, patterns, realtime, 'R21B', 5)!.stop.wheelchair).toBe('not-accessible');
    expect(stopDetail(store, patterns, realtime, 'R21A', 5)!.stop.wheelchair).toBeUndefined();
  });
});

describe('vehicleTrip', () => {
  it('returns the whole trip for a live vehicle', () => {
    const vehicle = [...realtime.vehicles.values()].find((v) => v.tripId);
    expect(vehicle).toBeDefined();
    const trip = vehicleTrip(store, realtime, vehicle!.id, Math.floor(Date.now() / 1000))!;
    expect(trip).not.toBeNull();
    expect(trip.stops.length).toBeGreaterThan(1);
    expect(trip.geometry.length).toBeGreaterThan(1);
    expect(trip.nextStopIndex).toBeGreaterThanOrEqual(0);
    expect(trip.nextStopIndex).toBeLessThan(trip.stops.length);
    expect(trip.route.operator?.name).toBeTruthy();
  });

  it('puts scheduled times in trip order', () => {
    const vehicle = [...realtime.vehicles.values()].find((v) => v.tripId)!;
    const trip = vehicleTrip(store, realtime, vehicle.id, Math.floor(Date.now() / 1000))!;
    for (let i = 1; i < trip.stops.length; i++) {
      expect(trip.stops[i].scheduledTime).toBeGreaterThanOrEqual(trip.stops[i - 1].scheduledTime);
    }
  });

  it('carries a delay down the trip from the last stop that states one', () => {
    const delayed = [...realtime.tripUpdates.values()].find((u) => u.stops.size > 0);
    const vehicle = delayed && realtime.vehicleForTrip(delayed.tripId);
    if (!vehicle) return; // the simulator had no delayed trip on the road
    const trip = vehicleTrip(store, realtime, vehicle.id, Math.floor(Date.now() / 1000))!;
    const predicted = trip.stops.filter((s) => s.predictedTime !== null);
    expect(predicted.length).toBeGreaterThan(0);
    for (const stop of predicted) expect(stop.predictedTime).toBe(stop.scheduledTime + stop.delaySeconds!);
  });

  it('is null for a vehicle it has never heard of', () => {
    expect(vehicleTrip(store, realtime, 'ghost', Math.floor(Date.now() / 1000))).toBeNull();
  });
});

describe('searchTransit', () => {
  const kinds = (q: string) => searchTransit(store, q).map((r) => (r.kind === 'route' ? `route:${r.route.shortName}` : `stop:${r.stop.name}`));

  it('finds a route by its number, however it is typed', () => {
    for (const q of ['21', 'route 21', 'Rt 21', 'bus 21']) expect(kinds(q)[0]).toBe('route:21');
  });

  it('finds a line by its name', () => {
    expect(kinds('blue')[0]).toBe('route:Blue');
    expect(kinds('Blue Line')[0]).toBe('route:Blue');
  });

  it('finds stops by every word, in any order', () => {
    expect(kinds('hennepin lake')).toContain('stop:Lake St & Hennepin Ave');
  });

  it('treats "and" and "&" alike', () => {
    expect(kinds('Lake and Hennepin')).toContain('stop:Lake St & Hennepin Ave');
  });

  it('finds a stop by the code on its pole, first', () => {
    const [first] = searchTransit(store, 'bl03');
    expect(first.kind === 'stop' && first.stop.id).toBe('BL03');
  });

  it('collapses both sides of a street into one result', () => {
    const names = kinds('Nicollet Mall').filter((k) => k.startsWith('stop:'));
    expect(new Set(names).size).toBe(names.length);
  });

  it('returns nothing for nothing', () => {
    expect(searchTransit(store, '   ')).toEqual([]);
  });
});

describe('store: nearby stops stay cheap wherever they are asked about', () => {
  // A degree of longitude shrinks to nothing at the poles, so a query sized by
  // its own span alone once scanned some 10^16 grid columns at latitude 90 and
  // never returned: one request froze the whole server.
  it('answers at once at the poles and far outside the feed', () => {
    const started = Date.now();
    expect(store.nearbyStops(90, 0, 800)).toEqual([]);
    expect(store.nearbyStops(-90, 179.9, 5_000)).toEqual([]);
    expect(store.nearbyStops(89.9999, -93.26, 12_000)).toEqual([]);
    expect(store.nearbyStops(1e9, 1e9, 800)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('returns nothing for coordinates that are not numbers', () => {
    expect(store.nearbyStops(Number.NaN, -93.26, 800)).toEqual([]);
    expect(store.nearbyStops(44.97, Number.POSITIVE_INFINITY, 800)).toEqual([]);
  });

  it('still finds the stops near a real point', () => {
    const near = store.nearbyStops(44.9784, -93.2699, 400);
    expect(near.length).toBeGreaterThan(0);
    expect(near.map((n) => store.stops[n.index].id)).toContain('BL03');
  });
});

describe('alertPlaces', () => {
  it('places every stop the alerts name, once each', () => {
    const alert = realtime.alerts.find((a) => a.id === 'mock-alert-1')!;
    const places = alertPlaces(store, [alert, { ...alert, id: 'again' }]);
    expect(places).toEqual([{ stopId: 'BL03', name: 'Nicollet Mall Station', lat: 44.9784, lon: -93.2699 }]);
  });

  it('leaves out stops the timetable does not know, and needs a timetable', () => {
    const alert = { ...realtime.alerts[0], stopIds: ['NOT-A-STOP'] };
    expect(alertPlaces(store, [alert])).toEqual([]);
    expect(alertPlaces(null, realtime.alerts)).toEqual([]);
  });
});
