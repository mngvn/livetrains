import { beforeAll, describe, expect, it } from 'vitest';
import type { Itinerary, TransitLeg } from '../shared/api.js';
import { GtfsStore } from '../gtfs/store.js';
import { createMockStore } from '../mock/index.js';
import { RealtimeState } from '../realtime/state.js';
import { epochFor, serviceDateAt } from '../gtfs/time.js';
import { Planner } from './index.js';

const TZ = 'America/Chicago';

/** Epoch seconds at a given local wall-clock time today, for stable tests. */
function todayAt(hour: number, minute = 0): number {
  const now = Math.floor(Date.now() / 1000);
  return epochFor(serviceDateAt(now, TZ), hour * 3600 + minute * 60, TZ);
}

const PLACES = {
  targetField: { lat: 44.9832, lon: -93.2777 },
  mallOfAmerica: { lat: 44.8548, lon: -93.2381 },
  unionDepot: { lat: 44.9479, lon: -93.0855 },
  lakeAndHennepin: { lat: 44.9483, lon: -93.298 },
  rosedale: { lat: 45.0122, lon: -93.17 },
  middleOfNowhere: { lat: 47.9, lon: -95.5 },
};

function transitLegs(itinerary: Itinerary): TransitLeg[] {
  return itinerary.legs.filter((leg): leg is TransitLeg => leg.type === 'transit');
}

describe('Planner', () => {
  let store: GtfsStore;
  let realtime: RealtimeState;
  let planner: Planner;

  beforeAll(() => {
    store = createMockStore(TZ);
    realtime = new RealtimeState();
    planner = new Planner(store, realtime, {
      maxWalkMeters: 1200,
      walkSpeed: 1.33,
      maxTransfers: 3,
      maxTransfersPerStop: 12,
    });
  });

  it('loads the synthetic feed into a usable store', () => {
    expect(store.stops.length).toBeGreaterThan(40);
    expect(store.routes.length).toBe(5);
    expect(store.tripIds.length).toBeGreaterThan(500);
    expect(store.stopTimeCount).toBeGreaterThan(5_000);
  });

  it('plans a direct ride with no transfers', () => {
    const plan = planner.plan({
      fromLat: PLACES.targetField.lat,
      fromLon: PLACES.targetField.lon,
      toLat: PLACES.mallOfAmerica.lat,
      toLon: PLACES.mallOfAmerica.lon,
      departAt: todayAt(9),
    });

    expect(plan.itineraries.length).toBeGreaterThan(0);
    const best = plan.itineraries[0];
    expect(best.transfers).toBe(0);

    const legs = transitLegs(best);
    expect(legs).toHaveLength(1);
    expect(legs[0].route.shortName).toBe('Blue');
    expect(legs[0].from.name).toContain('Target Field');
    expect(legs[0].to.name).toContain('Mall of America');
    expect(legs[0].arrivalTime).toBeGreaterThan(legs[0].departureTime);
    // The ride must actually visit the intermediate stations, in order.
    expect(legs[0].numStops).toBe(12);
    expect(legs[0].intermediateStops).toHaveLength(12);
  });

  it('plans a cross-metro trip that requires a transfer', () => {
    const plan = planner.plan({
      fromLat: PLACES.lakeAndHennepin.lat,
      fromLon: PLACES.lakeAndHennepin.lon,
      toLat: PLACES.unionDepot.lat,
      toLon: PLACES.unionDepot.lon,
      departAt: todayAt(9),
    });

    expect(plan.itineraries.length).toBeGreaterThan(0);
    const best = plan.itineraries[0];
    const legs = transitLegs(best);
    expect(legs.length).toBeGreaterThanOrEqual(2);
    expect(best.transfers).toBeGreaterThanOrEqual(1);

    // Every connection must be physically makeable: each leg departs no
    // earlier than the previous leg arrived.
    for (let i = 1; i < best.legs.length; i++) {
      expect(best.legs[i].departureTime).toBeGreaterThanOrEqual(best.legs[i - 1].arrivalTime);
    }
    expect(legs[legs.length - 1].to.name).toContain('Union Depot');
  });

  it('never returns an itinerary whose legs travel backwards in time', () => {
    const plan = planner.plan({
      fromLat: PLACES.rosedale.lat,
      fromLon: PLACES.rosedale.lon,
      toLat: PLACES.mallOfAmerica.lat,
      toLon: PLACES.mallOfAmerica.lon,
      departAt: todayAt(14),
    });

    expect(plan.itineraries.length).toBeGreaterThan(0);
    for (const itinerary of plan.itineraries) {
      expect(itinerary.arrivalTime).toBeGreaterThan(itinerary.departureTime);
      for (const leg of itinerary.legs) {
        expect(leg.arrivalTime).toBeGreaterThanOrEqual(leg.departureTime);
      }
      for (let i = 1; i < itinerary.legs.length; i++) {
        expect(itinerary.legs[i].departureTime).toBeGreaterThanOrEqual(itinerary.legs[i - 1].arrivalTime);
      }
    }
  });

  it('does not make the rider wait at the first stop before leaving', () => {
    const plan = planner.plan({
      fromLat: PLACES.targetField.lat,
      fromLon: PLACES.targetField.lon,
      toLat: PLACES.unionDepot.lat,
      toLon: PLACES.unionDepot.lon,
      departAt: todayAt(10),
    });

    const best = plan.itineraries[0];
    const firstTransit = transitLegs(best)[0];
    const accessWalk = best.legs[0];
    if (accessWalk.type === 'walk') {
      // The walk should land at the stop just as the vehicle departs, rather
      // than starting the moment the query was made.
      expect(accessWalk.arrivalTime).toBe(firstTransit.departureTime);
      expect(best.departureTime).toBeGreaterThanOrEqual(todayAt(10));
    }
  });

  it('departs at the time asked for, not the time the server happens to be at', () => {
    // Regression: an explicit departure time used to be clamped forward to
    // "now", so planning a 9am commute in the afternoon silently returned an
    // afternoon trip. Pick a time deliberately far from the current clock.
    const nowHour = Number(
      new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(new Date()),
    );
    const requested = todayAt((nowHour + 6) % 24 < 6 ? 8 : (nowHour + 6) % 24, 15);

    const plan = planner.plan({
      fromLat: PLACES.targetField.lat,
      fromLon: PLACES.targetField.lon,
      toLat: PLACES.mallOfAmerica.lat,
      toLon: PLACES.mallOfAmerica.lon,
      departAt: requested,
    });

    expect(plan.itineraries.length).toBeGreaterThan(0);
    const best = plan.itineraries[0];
    expect(best.departureTime).toBeGreaterThanOrEqual(requested);
    // The first departure should follow closely, not hours later.
    expect(best.departureTime - requested).toBeLessThan(45 * 60);
  });

  it('finds service after midnight, which GTFS encodes as hour 24+', () => {
    const plan = planner.plan({
      fromLat: PLACES.targetField.lat,
      fromLon: PLACES.targetField.lon,
      toLat: PLACES.mallOfAmerica.lat,
      toLon: PLACES.mallOfAmerica.lon,
      // 00:30 tomorrow is 24:30 on today's service day.
      departAt: todayAt(24, 30),
    });

    expect(plan.itineraries.length).toBeGreaterThan(0);
    const legs = transitLegs(plan.itineraries[0]);
    expect(legs.length).toBeGreaterThan(0);
    expect(legs[0].departureTime).toBeGreaterThanOrEqual(todayAt(24, 30));
  });

  it('offers a walk when the destination is close enough not to need transit', () => {
    const plan = planner.plan({
      fromLat: 44.9832,
      fromLon: -93.2777,
      toLat: 44.9799,
      toLon: -93.2733,
      departAt: todayAt(11),
    });

    const walkOnly = plan.itineraries.find((it) => it.legs.every((leg) => leg.type === 'walk'));
    expect(walkOnly).toBeDefined();
    expect(walkOnly!.walkDistanceMeters).toBeLessThan(1_000);
  });

  it('explains itself when the origin is nowhere near the network', () => {
    const plan = planner.plan({
      fromLat: PLACES.middleOfNowhere.lat,
      fromLon: PLACES.middleOfNowhere.lon,
      toLat: PLACES.unionDepot.lat,
      toLon: PLACES.unionDepot.lon,
      departAt: todayAt(9),
    });

    expect(plan.itineraries).toHaveLength(0);
    expect(plan.message).toMatch(/walking distance/i);
  });

  it('respects a transfer limit by returning only simpler itineraries', () => {
    const plan = planner.plan({
      fromLat: PLACES.lakeAndHennepin.lat,
      fromLon: PLACES.lakeAndHennepin.lon,
      toLat: PLACES.unionDepot.lat,
      toLon: PLACES.unionDepot.lon,
      departAt: todayAt(9),
      maxTransfers: 1,
    });

    for (const itinerary of plan.itineraries) {
      expect(itinerary.transfers).toBeLessThanOrEqual(1);
    }
  });

  it('pushes departures later when the realtime feed reports a delay', () => {
    const departAt = todayAt(9);
    const before = planner.plan({
      fromLat: PLACES.targetField.lat,
      fromLon: PLACES.targetField.lon,
      toLat: PLACES.mallOfAmerica.lat,
      toLon: PLACES.mallOfAmerica.lon,
      departAt,
    });
    const boarded = transitLegs(before.itineraries[0])[0];

    // Delay the trip the planner chose by ten minutes.
    realtime.setTripUpdates([
      {
        tripId: boarded.tripId,
        stops: new Map(),
        tripDelaySeconds: 600,
        cancelled: false,
        timestamp: Math.floor(Date.now() / 1000),
      },
    ]);

    const after = planner.plan({
      fromLat: PLACES.targetField.lat,
      fromLon: PLACES.targetField.lon,
      toLat: PLACES.mallOfAmerica.lat,
      toLon: PLACES.mallOfAmerica.lon,
      departAt,
    });
    const afterLeg = transitLegs(after.itineraries[0])[0];

    if (afterLeg.tripId === boarded.tripId) {
      // Same trip, now reported late: its times must reflect the delay.
      expect(afterLeg.departureTime).toBe(boarded.departureTime + 600);
      expect(afterLeg.delaySeconds).toBe(600);
      expect(afterLeg.isRealtime).toBe(true);
    } else {
      // Or the planner switched to a following trip that now arrives sooner.
      expect(afterLeg.arrivalTime).toBeLessThanOrEqual(boarded.arrivalTime + 600);
    }
    realtime.setTripUpdates([]);
  });

  it('refuses to board a cancelled trip', () => {
    const departAt = todayAt(13);
    const query = {
      fromLat: PLACES.targetField.lat,
      fromLon: PLACES.targetField.lon,
      toLat: PLACES.mallOfAmerica.lat,
      toLon: PLACES.mallOfAmerica.lon,
      departAt,
    };
    const before = transitLegs(planner.plan(query).itineraries[0])[0];

    realtime.setTripUpdates([
      {
        tripId: before.tripId,
        stops: new Map(),
        tripDelaySeconds: null,
        cancelled: true,
        timestamp: Math.floor(Date.now() / 1000),
      },
    ]);

    const after = planner.plan(query);
    for (const itinerary of after.itineraries) {
      for (const leg of transitLegs(itinerary)) {
        expect(leg.tripId).not.toBe(before.tripId);
      }
    }
    realtime.setTripUpdates([]);
  });
});
