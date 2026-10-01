import { beforeAll, describe, expect, it } from 'vitest';
import type { GtfsStore } from './gtfs/store.js';
import { createMockStore } from './mock/index.js';
import { RealtimeState } from './realtime/state.js';
import { epochFor, serviceDateAt } from './gtfs/time.js';
import { Planner } from './planner/index.js';
import { reachableFrom } from './reachability.js';

const TZ = 'America/Chicago';

function todayAt(hour: number): number {
  const now = Math.floor(Date.now() / 1000);
  return epochFor(serviceDateAt(now, TZ), hour * 3600, TZ);
}

describe('reachableFrom', () => {
  let store: GtfsStore;
  let planner: Planner;

  beforeAll(() => {
    store = createMockStore(TZ);
    planner = new Planner(store, new RealtimeState(), {
      maxWalkMeters: 1200,
      walkSpeed: 1.33,
      maxTransfers: 3,
      maxTransfersPerStop: 12,
    });
  });

  it('reaches the starting stop at once and the line beyond it later', () => {
    const result = reachableFrom(store, planner, 'BL01', 30, todayAt(10))!;
    const seconds = new Map(result.stops.map((s) => [s.id, s.seconds]));
    expect(seconds.get('BL01')).toBe(0);
    // Further down the Blue Line takes longer.
    expect(seconds.get('BL06')).toBeGreaterThan(0);
    expect(seconds.get('BL08')!).toBeGreaterThan(seconds.get('BL06')!);
    expect(result.stops.every((s) => s.seconds <= 30 * 60)).toBe(true);
  });

  it('reaches less with less time', () => {
    const short = reachableFrom(store, planner, 'BL01', 10, todayAt(10))!;
    const long = reachableFrom(store, planner, 'BL01', 30, todayAt(10))!;
    expect(short.stops.length).toBeLessThan(long.stops.length);
    const longIds = new Set(long.stops.map((s) => s.id));
    expect(short.stops.every((s) => longIds.has(s.id))).toBe(true);
  });

  it('refuses a stop that does not exist', () => {
    expect(reachableFrom(store, planner, 'NOPE', 30)).toBeNull();
  });
});
