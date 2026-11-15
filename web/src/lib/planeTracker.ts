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
 * How a spell of listening finished: the relay `ended` its stream, or it
 * cannot push at all and the one answer it gave was `polled`.
 */
export type PlaneListening = 'ended' | 'polled';

/**
 * Somewhere to get aircraft from: by asking, and — where the relay can push
 * — by listening on one connection for as long as the map is being watched.
 */
export interface PlaneFeed {
  fetch: PlaneFetcher;
  listen?: (
    signal: AbortSignal,
    on: {
      planes: (response: PlanesResponse) => void;
      /** The relay is there but the feed behind it is not answering. */
      problem: (message: string) => void;
    },
  ) => Promise<PlaneListening>;
}

/**
 * How often the feed is asked, by how long since anyone touched the page.
 *
 * Every poll is a request against someone's free allowance — the relay's
 * host and the community feed behind it — so the map asks briskly while it
 * is being used and less as it sits: a tab left open on a desk all day costs
 * a fraction of one being explored. Between polls the planes keep moving by
 * dead reckoning, so a slower rhythm shows as the odd small correction, not
 * as planes stopping. A hidden tab asks nothing at all.
 *
 * A relay that can push is listened to instead, which costs it one request
 * however long the map is watched; these rhythms are then what an older
 * relay gets, and what any relay gets once the map has sat untouched for
 * half an hour and the connection is let go.
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

/** How long a relay gets to give its first answer. */
const ANSWER_TIMEOUT_MS = 20_000;

/** How soon to listen again after a stream that was working ends or drops. */
const RELISTEN_MS = 1_000;

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
  private feed: PlaneFeed | null = null;
  private pollTimer: number | null = null;
  /** Set while a stream is open: when to check whether the map has been left. */
  private sleepTimer: number | null = null;
  private frameHandle: number | null = null;
  private controller: AbortController | null = null;
  private retryMs = RETRY_MS;
  /** The last sign of someone at the page: a touch, a click, a key, a scroll. */
  private lastActivity = Date.now();
  private readonly onActivity = () => {
    const was = Date.now() - this.lastActivity;
    this.lastActivity = Date.now();
    // Back from a while away: ask now, rather than wait out a slow poll.
    // (While a stream is open there is nothing to hurry: it is already current.)
    if (was >= IDLE_AFTER_MS && this.feed && this.sleepTimer === null && document.visibilityState === 'visible') {
      this.schedule(0);
    }
  };
  private readonly onVisibility = () => {
    if (!this.feed) return;
    // A hidden tab asks for nothing: these are free community feeds, and a
    // forgotten tab should not keep polling them all night, nor hold a
    // stream open. Coming back asks at once, so the sky is current the
    // moment it is looked at.
    if (document.visibilityState === 'visible') this.schedule(0);
    else this.hangUp();
  };

  /** Starts asking and drawing. Calling it again swaps the feed. */
  start(feed: PlaneFetcher | PlaneFeed): void {
    this.stop();
    this.feed = typeof feed === 'function' ? { fetch: feed } : feed;
    this.setStatus({ state: 'loading', error: null });
    this.lastActivity = Date.now();
    document.addEventListener('visibilitychange', this.onVisibility);
    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, this.onActivity, { passive: true });
    if (document.visibilityState !== 'hidden') this.schedule(0);
    this.startFrames();
  }

  /** Stops polling and clears the sky. */
  stop(): void {
    this.feed = null;
    this.hangUp();
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

  /** Drops whatever is in flight or being listened to, and asks for nothing more. */
  private hangUp(): void {
    this.clearPoll();
    if (this.sleepTimer !== null) window.clearTimeout(this.sleepTimer);
    this.sleepTimer = null;
    this.controller?.abort();
    this.controller = null;
  }

  /**
   * While a stream is open, checks back when the map would count as left
   * untouched for half an hour. A stream costs the relay no requests, but
   * it does make it ask the feed every fifteen seconds for a map nobody is
   * looking at; past that point it is let go for a poll every two minutes.
   */
  private watchForSleep(): void {
    if (this.sleepTimer !== null) window.clearTimeout(this.sleepTimer);
    const left = ASLEEP_AFTER_MS - (Date.now() - this.lastActivity);
    this.sleepTimer = window.setTimeout(() => {
      this.sleepTimer = null;
      if (Date.now() - this.lastActivity >= ASLEEP_AFTER_MS) this.schedule(0);
      else this.watchForSleep();
    }, Math.max(1_000, left));
  }

  private schedule(delayMs: number): void {
    this.clearPoll();
    this.pollTimer = window.setTimeout(() => void this.poll(), delayMs);
  }

  private async poll(): Promise<void> {
    const feed = this.feed;
    if (!feed) return;
    this.hangUp();
    const controller = new AbortController();
    this.controller = controller;
    /** Still the feed and the request in charge: not stopped, hidden or replaced since. */
    const current = () => this.feed === feed && this.controller === controller;
    // Long enough for a couple of relays to be tried in turn.
    const timeout = window.setTimeout(() => controller.abort(), ANSWER_TIMEOUT_MS);
    let answered = false;
    const began = Date.now();
    /**
     * When to listen again once a stream that had been answering is over. A
     * stream cut short straight away is no better than a poll, so it is
     * paced like one; that way a host that will not hold a connection open
     * costs what polling it would, and never more.
     */
    const relisten = () =>
      Date.now() - began >= PLANE_POLL_MS ? RELISTEN_MS : pollDelay(Date.now() - this.lastActivity);
    const take = (response: PlanesResponse) => {
      if (!current()) return;
      window.clearTimeout(timeout);
      answered = true;
      this.ingest(response);
      this.retryMs = RETRY_MS;
    };
    try {
      const awake = Date.now() - this.lastActivity < ASLEEP_AFTER_MS;
      if (feed.listen && awake) {
        this.watchForSleep();
        const outcome = await feed.listen(controller.signal, {
          planes: take,
          problem: (message) => {
            if (!current()) return;
            window.clearTimeout(timeout);
            this.setStatus({ state: 'error', error: message });
          },
        });
        if (!current()) return;
        // The relay closes a stream every so often on purpose; listen again.
        // One that cannot push has answered the once, and is polled.
        this.schedule(outcome === 'ended' ? relisten() : pollDelay(Date.now() - this.lastActivity));
      } else {
        take(await feed.fetch(controller.signal));
        if (!current()) return;
        this.schedule(pollDelay(Date.now() - this.lastActivity));
      }
    } catch (err) {
      if (!current()) return;
      // A stream that was answering and dropped is simply picked up again;
      // if the relay has really gone, that next try is what says so.
      if (answered) {
        this.schedule(relisten());
        return;
      }
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
      if (this.controller === controller && this.sleepTimer !== null) {
        window.clearTimeout(this.sleepTimer);
        this.sleepTimer = null;
      }
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
