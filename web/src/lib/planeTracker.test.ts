import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Plane, PlanesResponse } from '@shared/planes.ts';
import { PLANE_POLL_MS, PlaneTracker, deadReckon, pollDelay, type PlaneFeed } from './planeTracker.ts';

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

describe('listening rather than polling', () => {
  /** A page: timers, and a tab that can be hidden, shown and touched. */
  let page: { hide: () => void; show: () => void; touch: () => void };
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const listeners = new Map<string, Set<() => void>>();
    const target = {
      addEventListener: (type: string, fn: () => void) => void (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn),
      removeEventListener: (type: string, fn: () => void) => void listeners.get(type)?.delete(fn),
    };
    const fire = (type: string) => [...(listeners.get(type) ?? [])].forEach((fn) => fn());
    const doc = { ...target, visibilityState: 'visible' };
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', { ...target, setTimeout, clearTimeout });
    page = {
      hide: () => ((doc.visibilityState = 'hidden'), fire('visibilitychange')),
      show: () => ((doc.visibilityState = 'visible'), fire('visibilitychange')),
      touch: () => fire('pointerdown'),
    };
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** A relay that pushes: each call to `listen` is one request, open until ended. */
  function pushingFeed() {
    const open: { signal: AbortSignal; push: () => void; end: (how?: 'ended' | 'polled') => void; drop: () => void }[] = [];
    const feed: PlaneFeed = {
      fetch: vi.fn(async () => at(Date.now() / 1000, [plane()])),
      listen: vi.fn<NonNullable<PlaneFeed['listen']>>(
        (signal, on) =>
          new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')));
            open.push({
              signal,
              push: () => on.planes(at(Date.now() / 1000, [plane({ positionAt: Date.now() / 1000 })])),
              end: (how = 'ended') => resolve(how),
              drop: () => reject(new Error('connection lost')),
            });
          }),
      ),
    };
    return { feed, open };
  }

  it('holds one connection for as long as the map is watched', async () => {
    const { feed, open } = pushingFeed();
    const tracker = new PlaneTracker();
    tracker.start(feed);
    await vi.advanceTimersByTimeAsync(0);
    // Ten minutes of a sky every fifteen seconds, all down the one request.
    for (let i = 0; i < 40; i++) {
      open[0].push();
      page.touch();
      await vi.advanceTimersByTimeAsync(15_000);
    }
    expect(feed.listen).toHaveBeenCalledTimes(1);
    expect(feed.fetch).not.toHaveBeenCalled();
    expect(tracker.frame()).toHaveLength(1);
    tracker.stop();
    expect(open[0].signal.aborted).toBe(true);
  });

  it('listens again when the relay ends a stream, or one drops', async () => {
    const { feed, open } = pushingFeed();
    const tracker = new PlaneTracker();
    const states: string[] = [];
    tracker.onStatus((status) => states.push(status.state));
    tracker.start(feed);
    await vi.advanceTimersByTimeAsync(0);
    open[0].push();
    await vi.advanceTimersByTimeAsync(60_000);
    open[0].end();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(feed.listen).toHaveBeenCalledTimes(2);
    open[1].push();
    await vi.advanceTimersByTimeAsync(60_000);
    open[1].drop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(feed.listen).toHaveBeenCalledTimes(3);
    // A stream that was working and dropped is not reported as an outage.
    expect(states).not.toContain('error');
    tracker.stop();
  });

  it('paces a relay that cuts every stream short like a poll, never faster', async () => {
    const { feed, open } = pushingFeed();
    const tracker = new PlaneTracker();
    tracker.start(feed);
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(0);
      open[i].push();
      open[i].drop();
      await vi.advanceTimersByTimeAsync(PLANE_POLL_MS - 1);
      expect(feed.listen).toHaveBeenCalledTimes(i + 1);
      await vi.advanceTimersByTimeAsync(1);
    }
    tracker.stop();
  });

  it('polls a relay that cannot push', async () => {
    const { feed, open } = pushingFeed();
    const tracker = new PlaneTracker();
    tracker.start(feed);
    await vi.advanceTimersByTimeAsync(0);
    open[0].push();
    open[0].end('polled');
    await vi.advanceTimersByTimeAsync(PLANE_POLL_MS - 1);
    expect(feed.listen).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(feed.listen).toHaveBeenCalledTimes(2);
    tracker.stop();
  });

  it('hangs up while the tab is hidden, and listens again when it is looked at', async () => {
    const { feed, open } = pushingFeed();
    const tracker = new PlaneTracker();
    tracker.start(feed);
    await vi.advanceTimersByTimeAsync(0);
    open[0].push();
    page.hide();
    expect(open[0].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(feed.listen).toHaveBeenCalledTimes(1);
    page.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(feed.listen).toHaveBeenCalledTimes(2);
    tracker.stop();
  });

  it('lets the connection go once the map has sat untouched for half an hour', async () => {
    const { feed, open } = pushingFeed();
    const tracker = new PlaneTracker();
    tracker.start(feed);
    await vi.advanceTimersByTimeAsync(0);
    open[0].push();
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000);
    expect(open[0].signal.aborted).toBe(true);
    // From here a poll every two minutes…
    expect(feed.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(feed.fetch).toHaveBeenCalledTimes(6);
    expect(feed.listen).toHaveBeenCalledTimes(1);
    // …until someone comes back.
    page.touch();
    await vi.advanceTimersByTimeAsync(0);
    expect(feed.listen).toHaveBeenCalledTimes(2);
    tracker.stop();
  });

  it('says so when the relay never answers, and backs off', async () => {
    const feed: PlaneFeed = {
      fetch: vi.fn(),
      listen: vi.fn(async () => {
        throw new Error('The aircraft feed answered 429');
      }),
    };
    const tracker = new PlaneTracker();
    let error: string | null = null;
    tracker.onStatus((status) => (error = status.error));
    tracker.start(feed);
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toBe('The aircraft feed answered 429');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(feed.listen).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(feed.listen).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(feed.listen).toHaveBeenCalledTimes(3);
    tracker.stop();
  });
});
