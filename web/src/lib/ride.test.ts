import { describe, expect, it } from 'vitest';
import type { TripStop, VehicleTrip } from './api.ts';
import { rideProgress } from './ride.ts';

const NOW = 1_800_000_000;

function stop(id: string, minutes: number): TripStop {
  return {
    stop: { id, code: id, name: `Stop ${id}`, lat: 44.97, lon: -93.27 },
    scheduledTime: NOW + minutes * 60,
    predictedTime: null,
    delaySeconds: null,
    skipped: false,
  };
}

function trip(nextStopIndex: number): VehicleTrip {
  return {
    vehicleId: 'v1',
    tripId: 't1',
    route: { id: '21', shortName: '21', longName: '', mode: 'bus', color: '0053A0', textColor: 'FFFFFF' },
    headsign: 'Uptown',
    geometry: [],
    stops: ['A', 'B', 'C', 'D', 'E'].map((id, i) => stop(id, i * 3)),
    nextStopIndex,
    alerts: [],
  };
}

describe('rideProgress', () => {
  it('asks for a stop until one is chosen', () => {
    expect(rideProgress(trip(0), null, null, NOW).phase).toBe('choose');
  });

  it('counts down the stops to yours', () => {
    const progress = rideProgress(trip(1), 'E', null, NOW);
    expect(progress).toMatchObject({ phase: 'riding', stopsAway: 3, secondsAway: 12 * 60 });
  });

  it('says get ready one stop early, and arriving when yours is next', () => {
    expect(rideProgress(trip(3), 'E', null, NOW).phase).toBe('next');
    expect(rideProgress(trip(4), 'E', null, NOW).phase).toBe('arriving');
  });

  it('says get off when the vehicle is stopped at your stop', () => {
    expect(rideProgress(trip(4), 'E', { stopId: 'E', currentStatus: 'stopped' }, NOW).phase).toBe('alight');
    expect(rideProgress(trip(4), 'E', { stopId: 'E', currentStatus: 'incoming' }, NOW).phase).toBe('arriving');
  });

  it('knows when your stop is behind the vehicle', () => {
    expect(rideProgress(trip(4), 'B', null, NOW).phase).toBe('arrived');
  });

  it('prefers the predicted time to the timetable', () => {
    const t = trip(1);
    t.stops[2].predictedTime = NOW + 9 * 60;
    expect(rideProgress(t, 'C', null, NOW).secondsAway).toBe(9 * 60);
  });
});
