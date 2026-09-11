import { beforeAll, describe, expect, it } from 'vitest';
import type { GtfsStore } from './gtfs/store.js';
import { createMockStore } from './mock/index.js';
import { departuresForStops, groupedStopIndices } from './departures.js';
import { PatternSet } from './planner/patterns.js';
import { RealtimeState } from './realtime/state.js';
import { epochFor, serviceDateAt } from './gtfs/time.js';
import { Geocoder } from './geocode.js';

const TZ = 'America/Chicago';

function todayAt(hour: number, minute = 0): number {
  const now = Math.floor(Date.now() / 1000);
  return epochFor(serviceDateAt(now, TZ), hour * 3600 + minute * 60, TZ);
}

describe('departuresForStops', () => {
  let store: GtfsStore;
  let patterns: PatternSet;
  let realtime: RealtimeState;
  let govPlaza: number;

  beforeAll(() => {
    store = createMockStore(TZ);
    patterns = PatternSet.build(store);
    realtime = new RealtimeState();
    govPlaza = store.stopIndexById.get('BL04')!;
  });

  it('returns upcoming departures in time order', () => {
    const now = todayAt(9);
    const departures = departuresForStops(store, patterns, realtime, [govPlaza], { now, limit: 10 });

    expect(departures.length).toBeGreaterThan(0);
    for (const departure of departures) {
      expect(departure.expectedTime).toBeGreaterThanOrEqual(now - 60);
    }
    for (let i = 1; i < departures.length; i++) {
      expect(departures[i].expectedTime).toBeGreaterThanOrEqual(departures[i - 1].expectedTime);
    }
  });

  it('serves both light rail lines at a shared downtown station', () => {
    const departures = departuresForStops(store, patterns, realtime, [govPlaza], {
      now: todayAt(9),
      limit: 20,
    });
    const routes = new Set(departures.map((d) => d.routeId));
    expect(routes).toContain('BLUE');
    expect(routes).toContain('GREEN');
  });

  it('respects a route filter', () => {
    const departures = departuresForStops(store, patterns, realtime, [govPlaza], {
      now: todayAt(9),
      limit: 10,
      routeIds: ['BLUE'],
    });
    expect(departures.length).toBeGreaterThan(0);
    expect(departures.every((d) => d.routeId === 'BLUE')).toBe(true);
  });

  it('marks scheduled departures as not realtime', () => {
    const [first] = departuresForStops(store, patterns, realtime, [govPlaza], { now: todayAt(9), limit: 1 });
    expect(first.isRealtime).toBe(false);
    expect(first.delaySeconds).toBeNull();
    expect(first.expectedTime).toBe(first.scheduledTime);
  });

  it('applies a realtime delay to the expected time', () => {
    const now = todayAt(10);
    const [before] = departuresForStops(store, patterns, realtime, [govPlaza], { now, limit: 1 });

    const local = new RealtimeState();
    local.setTripUpdates([
      {
        tripId: before.tripId,
        stops: new Map(),
        tripDelaySeconds: 180,
        cancelled: false,
        timestamp: now,
      },
    ]);

    const after = departuresForStops(store, patterns, local, [govPlaza], { now, limit: 5 });
    const match = after.find((d) => d.tripId === before.tripId);
    expect(match).toBeDefined();
    expect(match!.isRealtime).toBe(true);
    expect(match!.delaySeconds).toBe(180);
    expect(match!.expectedTime).toBe(before.scheduledTime + 180);
  });

  it('hides cancelled trips', () => {
    const now = todayAt(11);
    const [before] = departuresForStops(store, patterns, realtime, [govPlaza], { now, limit: 1 });

    const local = new RealtimeState();
    local.setTripUpdates([
      { tripId: before.tripId, stops: new Map(), tripDelaySeconds: null, cancelled: true, timestamp: now },
    ]);

    const after = departuresForStops(store, patterns, local, [govPlaza], { now, limit: 10 });
    expect(after.some((d) => d.tripId === before.tripId)).toBe(false);
  });

  it('does not list a departure from the last stop of a trip', () => {
    // Mall of America is the end of the Blue Line in direction 0; nothing
    // should ever be shown as "departing" toward nowhere.
    const moa = store.stopIndexById.get('BL13')!;
    const departures = departuresForStops(store, patterns, realtime, [moa], { now: todayAt(9), limit: 10 });
    for (const departure of departures) {
      const tripIndex = store.tripIndexById.get(departure.tripId)!;
      const lastStop = store.stopTimeStop[store.stopTimeStart[tripIndex + 1] - 1];
      expect(lastStop).not.toBe(moa);
    }
  });

  it('finds after-midnight departures from the previous service day', () => {
    const departures = departuresForStops(store, patterns, realtime, [govPlaza], {
      now: todayAt(24, 15),
      limit: 5,
    });
    expect(departures.length).toBeGreaterThan(0);
  });
});

describe('groupedStopIndices', () => {
  it('groups stops that share a name at the same corner', () => {
    const store = createMockStore(TZ);
    const index = store.stopIndexById.get('BL04')!;
    const group = groupedStopIndices(store, index);
    expect(group).toContain(index);
    // Every grouped stop must genuinely share the name.
    for (const other of group) {
      expect(store.stops[other].name).toBe(store.stops[index].name);
    }
  });
});

describe('Geocoder', () => {
  let geocoder: Geocoder;

  beforeAll(() => {
    geocoder = new Geocoder(createMockStore(TZ), 'metro-transit');
  });

  it('ranks a prefix match above a mid-string match', () => {
    const results = geocoder.searchLocal('snelling');
    expect(results.length).toBeGreaterThan(1);
    const snellingStation = results.findIndex((p) => p.name === 'Snelling Ave Station');
    const fortSnelling = results.findIndex((p) => p.name === 'Fort Snelling Station');
    expect(snellingStation).toBeGreaterThanOrEqual(0);
    expect(snellingStation).toBeLessThan(fortSnelling);
  });

  it('puts a landmark ahead of the stop that shares its name', () => {
    const results = geocoder.searchLocal('union depot');
    expect(results[0].kind).toBe('landmark');
  });

  it('parses a raw coordinate pair', () => {
    const [place] = geocoder.searchLocal('44.9778, -93.265');
    expect(place.kind).toBe('coordinate');
    expect(place.lat).toBeCloseTo(44.9778, 4);
    expect(place.lon).toBeCloseTo(-93.265, 4);
  });

  it('rejects out-of-range coordinates', () => {
    expect(geocoder.searchLocal('999, 999')).toEqual([]);
  });

  it('matches all terms in any order', () => {
    const results = geocoder.searchLocal('lake midtown');
    expect(results.some((p) => p.name.includes('Lake St/Midtown'))).toBe(true);
  });

  it('ignores queries that are too short to be meaningful', () => {
    expect(geocoder.searchLocal('a')).toEqual([]);
  });

  it('names the nearest stop when reverse geocoding', () => {
    const place = geocoder.reverse(44.9769, -93.2657);
    expect(place.name).toMatch(/Government Plaza/);
  });
});
