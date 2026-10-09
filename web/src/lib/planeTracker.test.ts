import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Plane, PlanesResponse } from '@shared/planes.ts';
import { PLANE_POLL_MS, PlaneTracker, deadReckon, pollDelay } from './planeTracker.ts';

function plane(overrides: Partial<Plane> = {}): Plane {
  return {
    id: 'a095aa',
    callsign: 'EDV5350',
    lat: 44.9,
    lon: -93.2,
    altitude: 3000,
    onGround: false,
    groundSpeed: 180,
    track: 300,
    positionAt: 1000,
    ...overrides,
  };
}

const at = (now: number, planes: Plane[]): PlanesResponse => ({ planes, now });

describe('PlaneTracker', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('draws a plane where its speed and track carry it, not where it last reported', () => {
    const tracker = new PlaneTracker();
    tracker.ingest(at(1000, [plane()]), 1000);
    const [drawn] = tracker.frame(1008);
    const expected = deadReckon(44.9, -93.2, 300, 180, 8);
    expect(drawn.displayLat).toBeCloseTo(expected.lat, 6);
    expect(drawn.displayLon).toBeCloseTo(expected.lon, 6);
    expect(drawn.stale).toBe(false);
  });

  it("reads report times on the feed's clock, so a phone with a wrong clock still places planes right", () => {
    const tracker = new PlaneTracker();
    // The feed says it is 1000; this device thinks it is 1090.
    tracker.ingest(at(1000, [plane({ positionAt: 998 })]), 1090);
    const [drawn] = tracker.frame(1090);
    // Two seconds of flight from the report, not ninety-two.
    const expected = deadReckon(44.9, -93.2, 300, 180, 2);
    expect(drawn.displayLat).toBeCloseTo(expected.lat, 6);
  });

  it('closes the gap to a new report smoothly rather than jumping', () => {
    const tracker = new PlaneTracker();
    tracker.ingest(at(1000, [plane()]), 1000);
    const before = tracker.frame(1010)[0];
    // The plane turned: the new report is somewhere the old guess was not.
    tracker.ingest(at(1010, [plane({ lat: 44.93, lon: -93.25, track: 270, positionAt: 1010 })]), 1010);
    const sameMoment = tracker.frame(1010)[0];
    expect(sameMoment.displayLat).toBeCloseTo(before.displayLat, 6);
    expect(sameMoment.displayLon).toBeCloseTo(before.displayLon, 6);
    // A few seconds on, it is where the new report says.
    const later = tracker.frame(1015)[0];
    const expected = deadReckon(44.93, -93.25, 270, 180, 5);
    expect(later.displayLat).toBeCloseTo(expected.lat, 6);
    expect(later.displayLon).toBeCloseTo(expected.lon, 6);
    expect(later.displayTrack).toBeCloseTo(270, 6);
  });

  it('stops guessing after a while, and says the position is old', () => {
    const tracker = new PlaneTracker();
    tracker.ingest(at(1000, [plane()]), 1000);
    const a = tracker.frame(1045)[0];
    const b = tracker.frame(1070)[0];
    expect(b.displayLat).toBe(a.displayLat);
    expect(b.stale).toBe(true);
  });

  it('forgets a plane nothing has been heard of for minutes, even with the feed down', () => {
    const tracker = new PlaneTracker();
    tracker.ingest(at(1000, [plane()]), 1000);
    expect(tracker.frame(1190)).toHaveLength(1);
    expect(tracker.frame(1210)).toHaveLength(0);
    expect(tracker.get('a095aa')).toBeUndefined();
  });

  it('holds a plane that was not placed on a moving track where it was', () => {
    const tracker = new PlaneTracker();
    tracker.ingest(at(1000, [plane({ onGround: true, altitude: 0, groundSpeed: 0, track: undefined })]), 1000);
    const [drawn] = tracker.frame(1009);
    expect(drawn.displayLat).toBe(44.9);
    expect(drawn.displayLon).toBe(-93.2);
  });

  it('lets a plane go once the feed has stopped mentioning it', () => {
    const tracker = new PlaneTracker();
    tracker.ingest(at(1000, [plane(), plane({ id: 'b', callsign: 'DAL1' })]), 1000);
    tracker.ingest(at(1010, [plane({ positionAt: 1010 })]), 1010);
    // A short gap is ridden out…
    expect(tracker.frame(1010).map((p) => p.id).sort()).toEqual(['a095aa', 'b']);
    tracker.ingest(at(1040, [plane({ positionAt: 1040 })]), 1040);
    // …a long one is not.
    expect(tracker.frame(1040).map((p) => p.id)).toEqual(['a095aa']);
  });

  it('keeps a trail of reports, ending at the plane', () => {
    const tracker = new PlaneTracker();
    tracker.ingest(at(1000, [plane()]), 1000);
    tracker.ingest(at(1010, [plane({ lat: 44.91, lon: -93.23, positionAt: 1010 })]), 1010);
    // The same report repeated adds nothing.
    tracker.ingest(at(1012, [plane({ lat: 44.91, lon: -93.23, positionAt: 1010 })]), 1012);
    vi.spyOn(Date, 'now').mockReturnValue(1012_000);
    const trail = tracker.trail('a095aa');
    expect(trail).toHaveLength(3);
    expect(trail[0]).toEqual([-93.2, 44.9]);
    expect(trail[1]).toEqual([-93.23, 44.91]);
  });

  it('reports what it has', () => {
    const tracker = new PlaneTracker();
    const statuses: string[] = [];
    tracker.onStatus((status) => statuses.push(`${status.state}:${status.count}`));
    tracker.ingest({ planes: [plane()], now: 1000, source: 'adsb.lol' }, 1000);
    expect(statuses).toEqual(['off:0', 'live:1']);
  });
});

describe('pollDelay', () => {
  it('asks briskly while the map is in use, and less as it sits untouched', () => {
    expect(pollDelay(0)).toBe(PLANE_POLL_MS);
    expect(pollDelay(4 * 60_000)).toBe(15_000);
    expect(pollDelay(6 * 60_000)).toBe(30_000);
    expect(pollDelay(45 * 60_000)).toBe(120_000);
  });
});
