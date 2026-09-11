import { describe, expect, it } from 'vitest';
import bindings from 'gtfs-realtime-bindings';
import { decodeAlerts, decodeTripUpdates, decodeVehiclePositions } from './decode.js';

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
    });
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
    expect(update.stops.get('S9')).toEqual({ delaySeconds: null, arrivalTime: null, departureTime: null });
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
});
