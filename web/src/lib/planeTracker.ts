import { deadReckon, type Plane, type PlanesResponse } from '@shared/planes.ts';

export { deadReckon };

/**
 * Keeps the aircraft over the map and moves them smoothly between reports.
 *
 * Buses are interpolated from where they were drawn towards where they last
 * reported (see `vehicleTracker.ts`), which costs a feed interval of lag —
 * fine for a bus doing 20 mph, a mile behind for a jet on approach. Aircraft
 * report their ground speed and track, so they are dead-reckoned instead:
 * drawn where the last report says they are *now*, carried forward along
 * their track at their speed. When a new report lands, the small gap between
 * the guess and the truth is closed over a couple of seconds rather than
 * jumped, so a plane in a turn bends round instead of teleporting.
 *
 * Like the vehicle tracker it lives outside React and pushes frames straight
 * to the map.
 */

export interface TrackedPlane extends Plane {
  displayLat: number;
  displayLon: number;
  /** Smoothed track, so a turning plane rotates rather than snapping. */
  displayTrack: number;
  /** Nothing new heard for long enough that the position is a guess. */
  stale: boolean;
}

export interface PlaneFeedStatus {
  /** `off` until started; `live` while polls succeed; `error` once one fails. */
  state: 'off' | 'loading' | 'live' | 'error';
  count: number;
  /** How many of them are in the air rather than parked or taxiing. */
  airborne: number;
  /** Feed clock of the last good poll, Unix seconds. */
  lastUpdate: number | null;
  error: string | null;
  /** Who the positions come from, for attribution. */
  source: string | null;
}

/** Asks the feed for the planes in the area. */
export type PlaneFetcher = (signal: AbortSignal) => Promise<PlanesResponse>;

/**
 * How often the feed is asked, by how long since anyone touched the page.
 *
 * Every poll is a request against someone's free allowance — the relay's
 * host and the community feed behind it — so the map asks briskly while it
 * is being used and less as it sits: a tab left open on a desk all day costs
 * a fraction of one being explored. Between polls the planes keep moving by
 * dead reckoning, so a slower rhythm shows as the odd small correction, not
 * as planes stopping. A hidden tab asks nothing at all.
 */
export const PLANE_POLL_MS = 15_000;
const IDLE_POLL_MS = 30_000;
const ASLEEP_POLL_MS = 120_000;
const IDLE_AFTER_MS = 5 * 60_000;
const ASLEEP_AFTER_MS = 30 * 60_000;

/** How long to wait before the next poll, given the last sign of someone there. */
export function pollDelay(sinceActivityMs: number): number {
  if (sinceActivityMs >= ASLEEP_AFTER_MS) return ASLEEP_POLL_MS;
  if (sinceActivityMs >= IDLE_AFTER_MS) return IDLE_POLL_MS;
  return PLANE_POLL_MS;
}

/** What counts as someone being at the page. */
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;

/** After a failed poll, how long before the next try; doubling to the cap. */
const RETRY_MS = 20_000;
const RETRY_MAX_MS = 120_000;

/**
 * How far past its last report a plane is carried forward.
 *
 * Comfortably more than one poll plus the report's own age, so a single late
 * response does not freeze anything. Beyond it a plane holds where it was
 * last placed, and goes stale: a guess a minute old would be a fiction. (A
 * map left untouched for half an hour polls every two minutes, and its
 * planes honestly freeze and fade between polls rather than fly on.)
 */
const MAX_EXTRAPOLATE_SECONDS = 40;
const STALE_AFTER_SECONDS = 60;

/**
 * With nothing heard for this long, a plane is gone, feed or no feed. Unlike
 * a bus, whose last stop is still worth knowing, a plane frozen for minutes
 * is a fiction: it is twenty miles on.
 */
const FORGET_AFTER_SECONDS = 200;

/** A plane missing from this many seconds of good polls has left. */
const DROP_AFTER_SECONDS = 30;

/** How long the gap between guess and report takes to close. */
const BLEND_SECONDS = 2;

/** A selected plane's trail, back this far: most of its time over a metro. */
export const PLANE_TRAIL_SECONDS = 10 * 60;

/** The short way round between two bearings, -180..180. */
function angleDelta(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

interface Track {
  plane: Plane;
  /** The report's position time on this device's clock, Unix seconds. */
  reportedAt: number;
  /** Where the old guess was relative to the new one, decaying to nothing. */
  offsetLat: number;
  offsetLon: number;
  offsetTrack: number;
  /** When that correction started, this device's clock. */
  blendFrom: number;
  /** This device's clock when a good poll last mentioned the plane. */
  lastSeen: number;
  trail: { lat: number; lon: number; t: number }[];
}

/** Where a track's plane is drawn at `now` (this device's clock, seconds). */
export function planePosition(
  track: Pick<Track, 'plane' | 'reportedAt' | 'offsetLat' | 'offsetLon' | 'offsetTrack' | 'blendFrom'>,
  now: number,
): { lat: number; lon: number; track: number } {
  const { plane } = track;
  const elapsed = Math.min(MAX_EXTRAPOLATE_SECONDS, Math.max(0, now - track.reportedAt));
  const moving = plane.groundSpeed !== undefined && plane.track !== undefined && plane.groundSpeed > 0;
  const ahead = moving ? deadReckon(plane.lat, plane.lon, plane.track!, plane.groundSpeed!, elapsed) : plane;
  const left = Math.max(0, 1 - (now - track.blendFrom) / BLEND_SECONDS);
  const heading = plane.track ?? 0;
  return {
    lat: ahead.lat + track.offsetLat * left,
    lon: ahead.lon + track.offsetLon * left,
    track: (heading + track.offsetTrack * left + 360) % 360,
  };
}

export class PlaneTracker {
  private tracks = new Map<string, Track>();
  private readonly frameListeners = new Set<(planes: TrackedPlane[]) => void>();
  private readonly statusListeners = new Set<(status: PlaneFeedStatus) => void>();
  private status: PlaneFeedStatus = { state: 'off', count: 0, airborne: 0, lastUpdate: null, error: null, source: null };
  private fetcher: PlaneFetcher | null = null;
  private pollTimer: number | null = null;
  private frameHandle: number | null = null;
  private controller: AbortController | null = null;
  private retryMs = RETRY_MS;
  /** The last sign of someone at the page: a touch, a click, a key, a scroll. */
  private lastActivity = Date.now();
  private readonly onActivity = () => {
    const was = Date.now() - this.lastActivity;
    this.lastActivity = Date.now();
    // Back from a while away: ask now, rather than wait out a slow poll.
    if (was >= IDLE_AFTER_MS && this.fetcher && document.visibilityState === 'visible') this.schedule(0);
  };
  private readonly onVisibility = () => {
    if (!this.fetcher) return;
    // A hidden tab asks for nothing: these are free community feeds, and a
    // forgotten tab should not keep polling them all night. Coming back
    // asks at once, so the sky is current the moment it is looked at.
    if (document.visibilityState === 'visible') this.schedule(0);
    else this.clearPoll();
  };

  /** Starts polling and drawing. Calling it again swaps the feed. */
  start(fetcher: PlaneFetcher): void {
    this.stop();
    this.fetcher = fetcher;
    this.setStatus({ state: 'loading', error: null });
    this.lastActivity = Date.now();
    document.addEventListener('visibilitychange', this.onVisibility);
    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, this.onActivity, { passive: true });
    if (document.visibilityState !== 'hidden') this.schedule(0);
    this.startFrames();
  }

  /** Stops polling and clears the sky. */
  stop(): void {
    this.fetcher = null;
    this.clearPoll();
    this.controller?.abort();
    this.controller = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
    for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, this.onActivity);
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
    this.tracks.clear();
    this.retryMs = RETRY_MS;
    for (const listener of this.frameListeners) listener([]);
    this.setStatus({ state: 'off', count: 0, airborne: 0, lastUpdate: null, error: null, source: null });
  }

  onFrame(listener: (planes: TrackedPlane[]) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onStatus(listener: (status: PlaneFeedStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  /** The last report for a plane. */
  get(id: string): Plane | undefined {
    return this.tracks.get(id)?.plane;
  }

  /** Where a plane is drawn right now, for the camera. */
  position(id: string): { lat: number; lon: number } | null {
    const track = this.tracks.get(id);
    return track ? planePosition(track, Date.now() / 1000) : null;
  }

  /** Where a plane has been, oldest first as [lon, lat], ending where it is drawn. */
  trail(id: string): [number, number][] {
    const track = this.tracks.get(id);
    if (!track) return [];
    const now = Date.now() / 1000;
    const here = planePosition(track, now);
    return [...track.trail.map((p): [number, number] => [p.lon, p.lat]), [here.lon, here.lat]];
  }

  /**
   * Takes in one poll's worth of planes.
   *
   * `receivedAt` is this device's clock when the response arrived. Report
   * times are moved onto it via the feed's own `now`, so a phone whose clock
   * is a minute out still places every plane where it is, not a minute along.
   */
  ingest(response: PlanesResponse, receivedAt = Date.now() / 1000): void {
    const skew = receivedAt - response.now;
    const seen = new Set<string>();
    for (const plane of response.planes) {
      seen.add(plane.id);
      const reportedAt = plane.positionAt + skew;
      const existing = this.tracks.get(plane.id);
      if (!existing) {
        this.tracks.set(plane.id, {
          plane,
          reportedAt,
          offsetLat: 0,
          offsetLon: 0,
          offsetTrack: 0,
          blendFrom: receivedAt,
          lastSeen: receivedAt,
          trail: [{ lat: plane.lat, lon: plane.lon, t: reportedAt }],
        });
        continue;
      }
      // Close the gap from where it is drawn to where the report puts it.
      const drawn = planePosition(existing, receivedAt);
      const next = { ...existing, plane, reportedAt, offsetLat: 0, offsetLon: 0, offsetTrack: 0, blendFrom: receivedAt };
      const fresh = planePosition(next, receivedAt);
      next.offsetLat = drawn.lat - fresh.lat;
      next.offsetLon = drawn.lon - fresh.lon;
      next.offsetTrack = plane.track === undefined ? 0 : angleDelta(fresh.track, drawn.track);
      next.lastSeen = receivedAt;
      const last = existing.trail[existing.trail.length - 1];
      const trail = !last || reportedAt > last.t ? [...existing.trail, { lat: plane.lat, lon: plane.lon, t: reportedAt }] : existing.trail;
      const cutoff = reportedAt - PLANE_TRAIL_SECONDS;
      next.trail = trail.filter((p) => p.t >= cutoff);
      this.tracks.set(plane.id, next);
    }
    // Gone from the feed: flown out of the area, landed and shut down, or
    // out of receiver range. A short grace rides out a feed that skips a
    // plane for one poll.
    for (const [id, track] of this.tracks) {
      if (!seen.has(id) && receivedAt - track.lastSeen >= DROP_AFTER_SECONDS) this.tracks.delete(id);
    }
    let airborne = 0;
    for (const track of this.tracks.values()) if (!track.plane.onGround) airborne++;
    this.setStatus({
      state: 'live',
      count: this.tracks.size,
      airborne,
      lastUpdate: response.now,
      error: null,
      source: response.source ?? this.status.source,
    });
  }

  /** Every plane as drawn at `now`, this device's clock in seconds. */
  frame(now = Date.now() / 1000): TrackedPlane[] {
    const out: TrackedPlane[] = [];
    for (const [id, track] of this.tracks) {
      if (now - track.reportedAt > FORGET_AFTER_SECONDS) {
        this.tracks.delete(id);
        continue;
      }
      const position = planePosition(track, now);
      out.push({
        ...track.plane,
        displayLat: position.lat,
        displayLon: position.lon,
        displayTrack: position.track,
        stale: now - track.reportedAt > STALE_AFTER_SECONDS,
      });
    }
    return out;
  }

  private setStatus(next: Partial<PlaneFeedStatus>): void {
    this.status = { ...this.status, ...next };
    for (const listener of this.statusListeners) listener(this.status);
  }

  private clearPoll(): void {
    if (this.pollTimer !== null) window.clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private schedule(delayMs: number): void {
    this.clearPoll();
    this.pollTimer = window.setTimeout(() => void this.poll(), delayMs);
  }

  private async poll(): Promise<void> {
    const fetcher = this.fetcher;
    if (!fetcher) return;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    // Long enough for a couple of relays to be tried in turn.
    const timeout = window.setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetcher(controller.signal);
      if (this.fetcher !== fetcher) return;
      this.ingest(response);
      this.retryMs = RETRY_MS;
      this.schedule(pollDelay(Date.now() - this.lastActivity));
    } catch (err) {
      if (this.fetcher !== fetcher) return;
      // Planes already drawn stay, and go stale as they age; the legend says
      // the feed is not answering. Retries back off so an outage upstream is
      // not met with a stampede from every open tab.
      this.setStatus({
        state: 'error',
        error: err instanceof Error && err.name !== 'AbortError' ? err.message : 'The aircraft feed did not answer',
      });
      this.schedule(this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    } finally {
      window.clearTimeout(timeout);
    }
  }

  private startFrames(): void {
    if (this.frameHandle !== null) return;
    const step = () => {
      const planes = this.frame();
      for (const listener of this.frameListeners) listener(planes);
      this.frameHandle = requestAnimationFrame(step);
    };
    this.frameHandle = requestAnimationFrame(step);
  }
}
