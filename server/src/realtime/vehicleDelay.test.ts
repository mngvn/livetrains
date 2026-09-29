import { describe, expect, it } from 'vitest';
import type { Vehicle } from '../shared/api.js';
import { epochFor, serviceDateAt } from '../gtfs/time.js';
import { tinyStore } from '../testing/tinyFeed.js';
import { RealtimeState, type StopPrediction, type TripUpdate } from './state.js';
import { scheduledTimeAt, vehicleDelay } from './vehicleDelay.js';

const store = tinyStore();
const TZ = store.timezone;
// Trip `t` departs stop `a` at 08:00 and reaches `far` at 08:10, every day.
const today = serviceDateAt(Math.floor(Date.now() / 1000), TZ);
const AT_A = epochFor(today, 8 * 3600, TZ);
const AT_FAR = epochFor(today, 8 * 3600 + 600, TZ);

const vehicle = (extra: Partial<Vehicle> = {}): Vehicle => ({
  id: 'bus-1',
  tripId: 't',
  mode: 'bus',
  color: '0B5FA5',
  lat: 44.98,
  lon: -93.27,
  timestamp: AT_A,
  ...extra,
});

const prediction = (extra: Partial<StopPrediction> = {}): StopPrediction => ({
  delaySeconds: null,
  arrivalTime: null,
  departureTime: null,
  skipped: false,
  ...extra,
});

const update = (stops: [string, StopPrediction][], extra: Partial<TripUpdate> = {}): TripUpdate => ({
  tripId: 't',
  stops: new Map(stops),
  tripDelaySeconds: null,
  cancelled: false,
  timestamp: AT_A,
  ...extra,
});

describe('scheduledTimeAt', () => {
  it('finds the timetabled time on the service day nearest the prediction', () => {
    expect(scheduledTimeAt(store, 't', 'a', AT_A + 240)).toBe(AT_A);
    expect(scheduledTimeAt(store, 't', 'far', AT_FAR - 60)).toBe(AT_FAR);
  });

  it('gives up on a stop the trip never calls at', () => {
    expect(scheduledTimeAt(store, 't', 'b', AT_A)).toBeNull();
  });

  it('gives up on a match implausibly far from the prediction', () => {
    expect(scheduledTimeAt(store, 't', 'a', AT_A + 11 * 3600)).toBeNull();
  });
});

describe('vehicleDelay', () => {
  const now = AT_A - 120;

  it('measures lateness from an absolute predicted time', () => {
    const u = update([['a', prediction({ departureTime: AT_A + 300 })]]);
    expect(vehicleDelay(vehicle(), u, store, now)).toBe(300);
  });

  it('reports running early as a negative delay', () => {
    const u = update([['a', prediction({ departureTime: AT_A - 90 })]]);
    expect(vehicleDelay(vehicle(), u, store, now)).toBe(-90);
  });

  it('prefers the absolute time when the feed also states a delay', () => {
    // The time is what the producer believes; the delay has to be re-applied
    // to a schedule it may have matched differently.
    const u = update([['a', prediction({ departureTime: AT_A + 300, delaySeconds: 60 })]]);
    expect(vehicleDelay(vehicle(), u, store, now)).toBe(300);
  });

  it('uses a stated delay when there is no time', () => {
    const u = update([['a', prediction({ delaySeconds: 150 })]]);
    expect(vehicleDelay(vehicle(), u, store, now)).toBe(150);
  });

  it('anchors on the stop the vehicle says it is at', () => {
    const u = update([
      ['a', prediction({ departureTime: AT_A + 60 })],
      ['far', prediction({ arrivalTime: AT_FAR + 420 })],
    ]);
    expect(vehicleDelay(vehicle({ stopId: 'far' }), u, store, now)).toBe(420);
  });

  it('otherwise anchors on the next stop still ahead', () => {
    const u = update([
      ['a', prediction({ departureTime: AT_A + 60 })],
      ['far', prediction({ arrivalTime: AT_FAR + 420 })],
    ]);
    // Well after `a` departed, the next stop is `far`.
    expect(vehicleDelay(vehicle(), u, store, AT_A + 300)).toBe(420);
  });

  it('never anchors on a stop the vehicle is skipping', () => {
    const u = update([
      ['a', prediction({ skipped: true })],
      ['far', prediction({ arrivalTime: AT_FAR + 120 })],
    ]);
    expect(vehicleDelay(vehicle({ stopId: 'a' }), u, store, now)).toBe(120);
  });

  it('falls back to the trip-level delay', () => {
    expect(vehicleDelay(vehicle(), update([], { tripDelaySeconds: 200 }), store, now)).toBe(200);
  });

  it('is unknown, not zero, without a prediction', () => {
    expect(vehicleDelay(vehicle(), undefined, store, now)).toBeUndefined();
    expect(vehicleDelay(vehicle({ tripId: undefined }), update([]), store, now)).toBeUndefined();
    expect(vehicleDelay(vehicle(), update([]), store, now)).toBeUndefined();
  });

  it('says nothing about a cancelled trip', () => {
    const u = update([['a', prediction({ delaySeconds: 60 })]], { cancelled: true });
    expect(vehicleDelay(vehicle(), u, store, now)).toBeUndefined();
  });
});

describe('RealtimeState delay annotation', () => {
  it('annotates vehicles whichever feed lands second', () => {
    const state = new RealtimeState();
    // Positions first, predictions later — the order they usually race in.
    state.setVehicles([vehicle()], store);
    expect(state.vehicles.get('bus-1')?.delaySeconds).toBeUndefined();

    state.setTripUpdates([update([['a', prediction({ delaySeconds: 180 })]])], store);
    expect(state.vehicles.get('bus-1')?.delaySeconds).toBe(180);

    // Fresh positions pick up the predictions already held.
    state.setVehicles([vehicle()], store);
    expect(state.vehicles.get('bus-1')?.delaySeconds).toBe(180);
  });

  it('clears a delay once the prediction goes away', () => {
    const state = new RealtimeState();
    state.setTripUpdates([update([['a', prediction({ delaySeconds: 180 })]])], store);
    state.setVehicles([vehicle()], store);
    state.setTripUpdates([], store);
    expect(state.vehicles.get('bus-1')?.delaySeconds).toBeUndefined();
  });

  it('bumps its version on every snapshot, however close together', () => {
    const state = new RealtimeState();
    const before = state.tripUpdateVersion;
    state.setTripUpdates([]);
    state.setTripUpdates([]);
    expect(state.tripUpdateVersion).toBe(before + 2);
  });
});
