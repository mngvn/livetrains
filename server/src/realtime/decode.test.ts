import { describe, expect, it } from 'vitest';
import bindings from 'gtfs-realtime-bindings';
import type { ServiceAlert } from '../shared/api.js';
import { decodeAlerts, decodeTripUpdates, decodeVehiclePositions } from './decode.js';
import { RealtimeState } from './state.js';

const { transit_realtime: rt } = bindings;

function encode(message: Parameters<typeof rt.FeedMessage.create>[0]): Uint8Array {
  return rt.FeedMessage.encode(rt.FeedMessage.create(message)).finish();
}

const header = { gtfsRealtimeVersion: '2.0', timestamp: 1_757_620_000 };

describe('decodeVehiclePositions', () => {
  it('maps a position entity onto the wire shape the client expects', () => {
    const vehicles = decodeVehiclePositions(
      encode({
        header,
        entity: [
          {
            id: 'v1',
            vehicle: {
              trip: { tripId: 'T1', routeId: 'R1' },
              vehicle: { id: 'bus-1234', label: '1234' },
              position: { latitude: 44.9778, longitude: -93.265, bearing: 91.5, speed: 8.4 },
              timestamp: 1_757_619_990,
              occupancyStatus: 3,
            },
          },
        ],
      }),
      null,
    );

    expect(vehicles).toHaveLength(1);
    expect(vehicles[0]).toMatchObject({
      id: 'bus-1234',
      tripId: 'T1',
      routeId: 'R1',
      bearing: 91.5,
      timestamp: 1_757_619_990,
      occupancy: 'STANDING_ROOM_ONLY',
    });
    // GTFS-RT encodes coordinates as 32-bit floats, so they round-trip to
    // roughly centimetre precision rather than exactly.
    expect(vehicles[0].lat).toBeCloseTo(44.9778, 5);
    expect(vehicles[0].lon).toBeCloseTo(-93.265, 5);
  });

  it('drops vehicles parked at null island', () => {
    const vehicles = decodeVehiclePositions(
      encode({
        header,
        entity: [{ id: 'v2', vehicle: { vehicle: { id: 'parked' }, position: { latitude: 0, longitude: 0 } } }],
      }),
      null,
    );
    expect(vehicles).toHaveLength(0);
  });

  it('reads the stop a vehicle is at and whether it has arrived', () => {
    const [vehicle] = decodeVehiclePositions(
      encode({
        header,
        entity: [
          {
            id: 'v',
            vehicle: {
              trip: { tripId: 'T1' },
              vehicle: { id: 'bus-1' },
              position: { latitude: 44.97, longitude: -93.26 },
              stopId: 'S4',
              currentStatus: 1, // STOPPED_AT
            },
          },
        ],
      }),
      null,
    );
    expect(vehicle.stopId).toBe('S4');
    expect(vehicle.currentStatus).toBe('stopped');
  });

  it('leaves status unknown rather than defaulting it', () => {
    // INCOMING_AT is enum value 0, which is also what an unsent field reads as.
    const [vehicle] = decodeVehiclePositions(
      encode({
        header,
        entity: [{ id: 'v', vehicle: { vehicle: { id: 'bus-1' }, position: { latitude: 44.97, longitude: -93.26 } } }],
      }),
      null,
    );
    expect(vehicle.currentStatus).toBeUndefined();
    expect(vehicle.stopId).toBeUndefined();
  });

  it('does not report an unsent occupancy as empty', () => {
    // EMPTY is the occupancy enum's zero. Read naively, every vehicle on a
    // feed that omits occupancy — Metro Transit's, for one — showed as empty.
    const [vehicle] = decodeVehiclePositions(
      encode({
        header,
        entity: [{ id: 'v', vehicle: { vehicle: { id: 'bus-1' }, position: { latitude: 44.97, longitude: -93.26 } } }],
      }),
      null,
    );
    expect(vehicle.occupancy).toBeUndefined();
  });

  it('still reports a genuinely empty vehicle as empty', () => {
    const [vehicle] = decodeVehiclePositions(
      encode({
        header,
        entity: [
          {
            id: 'v',
            vehicle: { vehicle: { id: 'bus-1' }, position: { latitude: 44.97, longitude: -93.26 }, occupancyStatus: 0 },
          },
        ],
      }),
      null,
    );
    expect(vehicle.occupancy).toBe('EMPTY');
  });

  it('does not invent a heading or speed the vehicle never reported', () => {
    const [vehicle] = decodeVehiclePositions(
      encode({
        header,
        entity: [{ id: 'v', vehicle: { vehicle: { id: 'bus-1' }, position: { latitude: 44.97, longitude: -93.26 } } }],
      }),
      null,
    );
    expect(vehicle.bearing).toBeUndefined();
    expect(vehicle.speed).toBeUndefined();
  });

  it('keeps a real heading of due north', () => {
    const [vehicle] = decodeVehiclePositions(
      encode({
        header,
        entity: [
          { id: 'v', vehicle: { vehicle: { id: 'bus-1' }, position: { latitude: 44.97, longitude: -93.26, bearing: 0 } } },
        ],
      }),
      null,
    );
    expect(vehicle.bearing).toBe(0);
  });

  it('falls back to the feed timestamp when a vehicle omits its own', () => {
    const vehicles = decodeVehiclePositions(
      encode({
        header,
        entity: [{ id: 'v3', vehicle: { vehicle: { id: 'b' }, position: { latitude: 44.9, longitude: -93.2 } } }],
      }),
      null,
    );
    expect(vehicles[0].timestamp).toBe(header.timestamp);
  });

  it('reports a readable error when the feed serves markup instead of protobuf', () => {
    const html = new TextEncoder().encode('<!DOCTYPE html><html><body>503</body></html>');
    expect(() => decodeVehiclePositions(html, null)).toThrow(/markup or JSON/);
  });
});

describe('decodeTripUpdates', () => {
  it('reads per-stop delays and keeps the trip-level fallback', () => {
    const [update] = decodeTripUpdates(
      encode({
        header,
        entity: [
          {
            id: 't1',
            tripUpdate: {
              trip: { tripId: 'T1', routeId: 'R1' },
              delay: 120,
              stopTimeUpdate: [{ stopId: 'S1', departure: { delay: 90, time: 1_757_620_090 } }],
            },
          },
        ],
      }),
    );

    expect(update.tripId).toBe('T1');
    expect(update.tripDelaySeconds).toBe(120);
    expect(update.stops.get('S1')).toEqual({
      delaySeconds: 90,
      arrivalTime: null,
      departureTime: 1_757_620_090,
      skipped: false,
    });
  });

  it('does not mistake an unsent time for a prediction of midnight 1970', () => {
    // protobufjs reads an unsent int64 as zero. Treated as a time, that put a
    // delay-only stop's departure in 1970 and the board dropped it as gone.
    const [update] = decodeTripUpdates(
      encode({
        header,
        entity: [
          {
            id: 'u',
            tripUpdate: {
              trip: { tripId: 'T1' },
              stopTimeUpdate: [{ stopId: 'A', stopSequence: 1, arrival: { delay: 60 } }],
            },
          },
        ],
      }),
    );
    expect(update.stops.get('A')).toMatchObject({ delaySeconds: 60, arrivalTime: null, departureTime: null });
  });

  it('does not mistake an unsent delay for exactly on time', () => {
    const [update] = decodeTripUpdates(
      encode({
        header,
        entity: [
          {
            id: 'u',
            tripUpdate: {
              trip: { tripId: 'T1' },
              stopTimeUpdate: [{ stopId: 'B', stopSequence: 1, departure: { time: 1_757_620_500 } }],
            },
          },
        ],
      }),
    );
    expect(update.stops.get('B')).toMatchObject({ delaySeconds: null, departureTime: 1_757_620_500 });
    expect(update.tripDelaySeconds).toBeNull();
  });

  it('marks skipped stops as unpredicted rather than on time', () => {
    const [update] = decodeTripUpdates(
      encode({
        header,
        entity: [
          {
            id: 't2',
            tripUpdate: {
              trip: { tripId: 'T2' },
              stopTimeUpdate: [{ stopId: 'S9', scheduleRelationship: 1 /* SKIPPED */ }],
            },
          },
        ],
      }),
    );
    expect(update.stops.get('S9')).toEqual({
      delaySeconds: null,
      arrivalTime: null,
      departureTime: null,
      skipped: true,
    });
  });

  it('flags cancelled trips', () => {
    const [update] = decodeTripUpdates(
      encode({
        header,
        entity: [{ id: 't3', tripUpdate: { trip: { tripId: 'T3', scheduleRelationship: 3 /* CANCELED */ } } }],
      }),
    );
    expect(update.cancelled).toBe(true);
  });
});

describe('decodeAlerts', () => {
  it('collects informed routes and the English translation', () => {
    const [alert] = decodeAlerts(
      encode({
        header,
        entity: [
          {
            id: 'a1',
            alert: {
              activePeriod: [{ start: 1_757_600_000, end: 1_757_700_000 }],
              informedEntity: [{ routeId: 'R1' }, { stopId: 'S1' }],
              cause: 10 /* CONSTRUCTION */,
              effect: 4 /* DETOUR */,
              headerText: { translation: [{ text: 'Blue Line detour', language: 'en' }] },
              descriptionText: { translation: [{ text: 'Buses replace trains downtown.', language: 'en' }] },
            },
          },
        ],
      }),
    );

    expect(alert).toMatchObject({
      id: 'a1',
      header: 'Blue Line detour',
      description: 'Buses replace trains downtown.',
      cause: 'CONSTRUCTION',
      effect: 'DETOUR',
      routeIds: ['R1'],
      stopIds: ['S1'],
      activeFrom: 1_757_600_000,
      activeUntil: 1_757_700_000,
    });
  });

  it('keeps each informed entity whole, route and stop together', () => {
    const [alert] = decodeAlerts(
      encode({
        header,
        entity: [
          {
            id: 'closure',
            alert: {
              // How Metro Transit announces a closed stop: one entity per
              // route affected, each naming the same stop.
              informedEntity: [
                { agencyId: '0', routeId: '156', stopId: '53316' },
                { agencyId: '0', routeId: '578', stopId: '53316' },
              ],
              headerText: { translation: [{ text: 'Stop #53316 is closed', language: 'en' }] },
            },
          },
        ],
      }),
    );
    expect(alert.informed).toEqual([
      { agencyId: '0', routeId: '156', stopId: '53316' },
      { agencyId: '0', routeId: '578', stopId: '53316' },
    ]);
  });

  it('keeps every active period, not only the first', () => {
    const [alert] = decodeAlerts(
      encode({
        header,
        entity: [
          {
            id: 'nightly',
            alert: {
              activePeriod: [
                { start: 1_757_620_000, end: 1_757_640_000 },
                { start: 1_757_706_400, end: 1_757_726_400 },
              ],
              informedEntity: [{ routeId: 'R1' }],
              headerText: { translation: [{ text: 'Nightly closure', language: 'en' }] },
            },
          },
        ],
      }),
    );
    expect(alert.periods).toHaveLength(2);
    expect(alert.periods[1]).toEqual({ start: 1_757_706_400, end: 1_757_726_400 });
  });

  it('leaves an unsent cause and effect unknown', () => {
    // UNKNOWN_CAUSE is 1, not 0; an unsent enum read naively is a real value.
    const [alert] = decodeAlerts(
      encode({
        header,
        entity: [
          {
            id: 'bare',
            alert: {
              informedEntity: [{ routeId: 'R1' }],
              headerText: { translation: [{ text: 'Something', language: 'en' }] },
            },
          },
        ],
      }),
    );
    expect(alert.cause).toBeUndefined();
    expect(alert.effect).toBeUndefined();
  });
});

describe('alert matching', () => {
  const alert = (id: string, informed: ServiceAlert['informed']): ServiceAlert => ({
    id,
    header: id,
    description: '',
    routeIds: [...new Set(informed.flatMap((e) => (e.routeId ? [e.routeId] : [])))],
    stopIds: [...new Set(informed.flatMap((e) => (e.stopId ? [e.stopId] : [])))],
    informed,
    periods: [],
  });

  const state = new RealtimeState();
  state.setAlerts([
    alert('closed-here', [{ routeId: '156', stopId: 'HERE' }]),
    alert('closed-elsewhere', [{ routeId: '156', stopId: 'ELSEWHERE' }]),
    alert('route-detour', [{ routeId: '156' }]),
    alert('holiday', [{ agencyId: '0' }]),
  ]);

  it('shows a stop only what is true at that stop', () => {
    const ids = state.alertsForStop(['HERE'], ['156']).map((a) => a.id);
    expect(ids).toContain('closed-here');
    expect(ids).toContain('route-detour');
    // The regression: a closure elsewhere on the 156 used to appear at every
    // stop the 156 serves, because the route alone was matched.
    expect(ids).not.toContain('closed-elsewhere');
  });

  it('shows a route every stop closed along it', () => {
    const ids = state.alertsForRoute('156').map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(['closed-here', 'closed-elsewhere', 'route-detour']));
    expect(ids).not.toContain('holiday');
  });

  it('separates agency-wide alerts', () => {
    expect(state.agencyWideAlerts().map((a) => a.id)).toEqual(['holiday']);
  });
});

describe('stale trip updates', () => {
  it('are dropped once the feed has been silent too long, and not before', () => {
    const state = new RealtimeState();
    state.setTripUpdates([{ tripId: 't', stopTimeUpdates: [], cancelled: false } as never]);
    const at = state.lastTripUpdate!;
    const version = state.tripUpdateVersion;
    expect(state.expireTripUpdates(300, at + 299)).toBe(false);
    expect(state.tripUpdates.size).toBe(1);
    expect(state.expireTripUpdates(300, at + 301)).toBe(true);
    expect(state.tripUpdates.size).toBe(0);
    expect(state.tripUpdateVersion).toBe(version + 1);
  });
});
