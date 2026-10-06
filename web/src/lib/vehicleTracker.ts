import { getApiBase, type Vehicle } from './api.ts';

/**
 * Keeps the live vehicle picture and smooths it for display.
 *
 * A GTFS-Realtime feed arrives every 10-20 seconds, so drawing positions as
 * they land makes vehicles jump across several blocks at a time. This holds the
 * last known position and the newly reported one and interpolates between them
 * on an animation frame, which is what makes the map read as "live" rather than
 * as a slideshow.
 *
 * Deliberately outside React: at 60fps, routing every frame through component
 * state would dominate the render budget. Subscribers get the interpolated
 * frame directly and push it into MapLibre's source.
 */

export interface TrackedVehicle extends Vehicle {
  /** Interpolated position for the current frame. */
  displayLat: number;
  displayLon: number;
  /** Smoothed heading, so a vehicle rotates rather than snapping. */
  displayBearing: number;
  /**
   * The position is too old to call live: the feed has gone quiet, the
   * connection has dropped, or this is a last-known position from an earlier
   * visit. Drawn faded, never dropped — where a bus last was is still useful.
   */
  stale: boolean;
}

/** A position older than this is not live any more. */
export const STALE_AFTER_SECONDS = 180;

/**
 * How much of each vehicle's recent path is kept, for the trail drawn behind
 * a selected one. Twenty minutes is a few stops on a bus and most of a
 * light-rail run through downtown — enough to see whether it has been
 * crawling — and at one point per feed update it is a few kilobytes a vehicle.
 */
export const TRAIL_SECONDS = 20 * 60;

interface TrailPoint {
  lat: number;
  lon: number;
  /** The vehicle's own report time, Unix seconds. */
  t: number;
  /** Its delay against the timetable at that report, when the feed gave one. */
  delay?: number;
}

interface Track {
  vehicle: Vehicle;
  fromLat: number;
  fromLon: number;
  fromBearing: number;
  startedAt: number;
  durationMs: number;
  /** Timestamp of the last feed message that mentioned this vehicle. */
  lastSeen: number;
  /** Restored from an earlier visit rather than received this session. */
  restored?: boolean;
  /** Reported positions over the last TRAIL_SECONDS, oldest first. */
  trail: TrailPoint[];
}

/**
 * Anything that can push vehicle updates.
 *
 * The in-browser engine satisfies this structurally, which lets the tracker
 * stay agnostic about whether positions arrive from a worker in this tab or
 * over Server-Sent Events from a server.
 */
export interface VehiclePushSource {
  mode: 'browser' | 'server';
  onVehicles(
    listener: (payload: {
      vehicles: Vehicle[];
      timestamp: number | null;
      error: string | null;
      vehiclesOk?: boolean;
      nextPollAt?: number;
    }) => void,
  ): () => void;
  setRouteFilter(routeId?: string): void;
}

export type FrameListener = (vehicles: TrackedVehicle[]) => void;
export type StatusListener = (status: StreamStatus) => void;

export interface StreamStatus {
  connected: boolean;
  vehicleCount: number;
  /** Feed timestamp of the most recent message, in epoch seconds. */
  lastUpdate: number | null;
  error: string | null;
  /** When the feed will next be tried, epoch milliseconds, if known. */
  nextRetryAt?: number | null;
}

/**
 * Adds a new report to a trail, skipping repeats of the same report, and lets
 * go of anything older than the trail's span.
 */
function extendTrail(trail: TrailPoint[], vehicle: Vehicle): TrailPoint[] {
  const last = trail[trail.length - 1];
  const next =
    last && last.t >= vehicle.timestamp
      ? trail
      : [...trail, { lat: vehicle.lat, lon: vehicle.lon, t: vehicle.timestamp, delay: vehicle.delaySeconds }];
  const cutoff = vehicle.timestamp - TRAIL_SECONDS;
  let start = 0;
  while (start < next.length - 1 && next[start].t < cutoff) start++;
  return start > 0 ? next.slice(start) : next;
}

/**
 * How much longer than the feed's cadence each glide is stretched.
 *
 * Vehicles move at constant speed from where they are drawn towards where they
 * were last reported, timed to arrive a little *after* the next report is due.
 * So when that report lands the vehicle is still moving, and simply turns
 * towards the new target: one continuous glide rather than a series of hops.
 * A report that is a few seconds late finds the vehicle still under way
 * instead of parked and waiting to jump.
 */
const GLIDE_STRETCH = 1.2;

/** Interpolates between two bearings the short way around the circle. */
function lerpAngle(from: number, to: number, t: number): number {
  let delta = ((to - from + 540) % 360) - 180;
  return (from + delta * t + 360) % 360;
}

export class VehicleTracker {
  private source: EventSource | null = null;
  private tracks = new Map<string, Track>();
  private frameHandle: number | null = null;
  private readonly frameListeners = new Set<FrameListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private reconnectDelay = 1_000;
  private reconnectTimer: number | null = null;
  private filter: { routeId?: string } = {};
  /**
   * Set when the filter changes, so the next message replaces the fleet rather
   * than merging into it.
   *
   * Normally a vehicle missing from one message is kept for a grace period —
   * feeds drop entries transiently and a vehicle should not blink out. But
   * after a filter change, every vehicle outside the new filter is *supposed*
   * to disappear, and the grace period would leave the wrong routes on the map
   * for a full minute.
   */
  private resetOnNextMessage = false;
  /** Set in browser mode, where a worker pushes instead of an SSE stream. */
  private pushSource: VehiclePushSource | null = null;
  private unsubscribePush: (() => void) | null = null;

  private status: StreamStatus = { connected: false, vehicleCount: 0, lastUpdate: null, error: null };

  /**
   * How long a vehicle takes to travel to its newly reported position.
   *
   * Matched to the feed cadence so the animation finishes just as the next
   * message lands. Measured from the gap between messages rather than assumed,
   * because agencies publish at different rates.
   */
  private animationMs = 15_000;
  private lastMessageAt = 0;

  /**
   * Starts receiving positions.
   *
   * With a push source (the in-browser engine) the tracker subscribes to it;
   * without one it opens the server's SSE stream. Either way the interpolation
   * and frame loop below are identical.
   */
  connect(filter: { routeId?: string } = {}, source?: VehiclePushSource): void {
    this.filter = filter;

    if (source && source.mode === 'browser') {
      this.pushSource = source;
      this.unsubscribePush = source.onVehicles(({ vehicles, timestamp, error, vehiclesOk, nextPollAt }) => {
        // A failed poll with nothing to show is not news that every vehicle
        // has left service; keep what is on the map (it fades as it ages).
        if (!(error !== null && vehicles.length === 0)) this.ingest(vehicles);
        this.setStatus({
          // Live as long as positions are arriving, whatever the other feeds do.
          connected: vehiclesOk ?? error === null,
          vehicleCount: vehicles.length,
          lastUpdate: timestamp,
          error,
          nextRetryAt: nextPollAt ?? null,
        });
      });
      if (filter.routeId) source.setRouteFilter(filter.routeId);
    } else {
      this.openStream();
    }

    this.startFrames();
  }

  disconnect(): void {
    this.unsubscribePush?.();
    this.unsubscribePush = null;
    this.pushSource = null;
    this.source?.close();
    this.source = null;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
    this.tracks.clear();
    this.setStatus({ connected: false, vehicleCount: 0, lastUpdate: null, error: null });
  }

  /** Re-opens the stream with a different filter, keeping current positions. */
  setFilter(filter: { routeId?: string }): void {
    if (filter.routeId === this.filter.routeId) return;
    this.filter = filter;
    this.resetOnNextMessage = true;
    if (this.pushSource) this.pushSource.setRouteFilter(filter.routeId);
    else this.openStream();
  }

  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  /** The most recent raw position reported for a vehicle. */
  get(id: string): Vehicle | undefined {
    return this.tracks.get(id)?.vehicle;
  }

  /**
   * Where a vehicle has been over the last twenty minutes, oldest first, as
   * [lon, lat] — ending at where it is drawn right now, so the trail stays
   * attached to the marker while it glides between reports.
   */
  trail(id: string): [number, number][] {
    const track = this.tracks.get(id);
    if (!track) return [];
    const points: [number, number][] = track.trail.map((p) => [p.lon, p.lat]);
    const here = this.positionAt(track, performance.now());
    // The glide runs from the previous report towards the newest, so the
    // newest is still ahead of the marker: end the trail at the marker.
    if (points.length > 0 && track.durationMs > 0 && performance.now() - track.startedAt < track.durationMs) points.pop();
    points.push([here.lon, here.lat]);
    return points;
  }

  /**
   * How late a vehicle has been over the last twenty minutes, oldest first:
   * enough to tell a bus that is losing time from one that has been late
   * since it set out.
   */
  delayHistory(id: string): { t: number; delay: number }[] {
    const track = this.tracks.get(id);
    if (!track) return [];
    return track.trail.flatMap((p) => (p.delay === undefined ? [] : [{ t: p.t, delay: p.delay }]));
  }

  /** Every vehicle's last reported position, for saving. */
  snapshot(): Vehicle[] {
    return [...this.tracks.values()].filter((t) => !t.restored).map((t) => t.vehicle);
  }

  /**
   * Places last-known positions from an earlier visit, until live ones land.
   *
   * Only onto an empty map: live data always wins, and the first live
   * message clears every restored vehicle it does not mention.
   */
  restore(vehicles: Vehicle[]): void {
    if (this.tracks.size > 0) return;
    const now = performance.now();
    for (const vehicle of vehicles) {
      this.tracks.set(vehicle.id, {
        vehicle,
        fromLat: vehicle.lat,
        fromLon: vehicle.lon,
        fromBearing: vehicle.bearing ?? 0,
        startedAt: now,
        durationMs: 0,
        lastSeen: now,
        restored: true,
        trail: [],
      });
    }
    this.setStatus({ vehicleCount: this.status.vehicleCount || vehicles.length });
  }

  private setStatus(next: Partial<StreamStatus>): void {
    this.status = { ...this.status, ...next };
    for (const listener of this.statusListeners) listener(this.status);
  }

  private openStream(): void {
    this.source?.close();

    // The same server every other request goes to. This once used the page's
    // own origin, so a build or override pointing the API elsewhere fetched
    // everything from that server except the live vehicles.
    const url = new URL('/api/vehicles/stream', `${getApiBase()}/`);
    if (this.filter.routeId) url.searchParams.set('routeId', this.filter.routeId);

    const source = new EventSource(url);
    this.source = source;

    source.addEventListener('open', () => {
      this.reconnectDelay = 1_000;
      this.setStatus({ connected: true, error: null });
    });

    source.addEventListener('vehicles', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as {
          vehicles: Vehicle[];
          timestamp: number | null;
        };
        this.ingest(payload.vehicles);
        this.setStatus({
          connected: true,
          vehicleCount: payload.vehicles.length,
          lastUpdate: payload.timestamp,
          error: null,
        });
      } catch {
        this.setStatus({ error: 'Could not read the vehicle feed' });
      }
    });

    source.addEventListener('error', () => {
      // EventSource reconnects on its own, but not with a backoff, and not
      // after the server closes the stream deliberately. Manage it here so a
      // server restart does not turn into a tight reconnect loop.
      source.close();
      this.setStatus({
        connected: false,
        error: 'Reconnecting to the live feed…',
        nextRetryAt: Date.now() + this.reconnectDelay,
      });
      if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = window.setTimeout(() => this.openStream(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    });
  }

  private ingest(vehicles: Vehicle[]): void {
    const now = performance.now();

    if (this.lastMessageAt > 0) {
      const gap = now - this.lastMessageAt;
      // Track the real cadence, clamped so one delayed message does not make
      // every vehicle crawl for the next minute.
      if (gap > 1_000 && gap < 60_000) this.animationMs = this.animationMs * 0.7 + gap * 0.3;
    }
    this.lastMessageAt = now;

    const seen = new Set<string>();
    for (const vehicle of vehicles) {
      seen.add(vehicle.id);
      const existing = this.tracks.get(vehicle.id);

      if (!existing) {
        // First sighting: place it immediately rather than animating from
        // nowhere, which would make it streak across the map.
        this.tracks.set(vehicle.id, {
          vehicle,
          fromLat: vehicle.lat,
          fromLon: vehicle.lon,
          fromBearing: vehicle.bearing ?? 0,
          startedAt: now,
          durationMs: 0,
          lastSeen: now,
          trail: [{ lat: vehicle.lat, lon: vehicle.lon, t: vehicle.timestamp, delay: vehicle.delaySeconds }],
        });
        continue;
      }

      // The feed repeating a report it has already sent is not a new
      // position: restarting the glide towards the same point would only
      // slow the vehicle down. Keep it moving; just note it is still there.
      if (
        existing.vehicle.timestamp === vehicle.timestamp &&
        existing.vehicle.lat === vehicle.lat &&
        existing.vehicle.lon === vehicle.lon
      ) {
        existing.vehicle = vehicle;
        existing.lastSeen = now;
        existing.restored = undefined;
        continue;
      }

      const current = this.positionAt(existing, now);
      this.tracks.set(vehicle.id, {
        vehicle,
        fromLat: current.lat,
        fromLon: current.lon,
        fromBearing: current.bearing,
        startedAt: now,
        durationMs: this.animationMs * GLIDE_STRETCH,
        lastSeen: now,
        trail: extendTrail(existing.trail, vehicle),
      });
    }

    // Drop vehicles the feed stopped reporting — they have gone out of service.
    // After a filter change the drop is immediate; otherwise a grace period
    // rides out transient gaps in the feed.
    const grace = this.resetOnNextMessage ? 0 : 60_000;
    for (const [id, track] of this.tracks) {
      if (seen.has(id)) continue;
      if (track.restored || now - track.lastSeen >= grace) this.tracks.delete(id);
    }
    this.resetOnNextMessage = false;
  }

  private positionAt(track: Track, now: number): { lat: number; lon: number; bearing: number } {
    if (track.durationMs <= 0) {
      return { lat: track.vehicle.lat, lon: track.vehicle.lon, bearing: track.vehicle.bearing ?? track.fromBearing };
    }
    const t = Math.min(1, (now - track.startedAt) / track.durationMs);
    return {
      lat: track.fromLat + (track.vehicle.lat - track.fromLat) * t,
      lon: track.fromLon + (track.vehicle.lon - track.fromLon) * t,
      bearing: lerpAngle(track.fromBearing, track.vehicle.bearing ?? track.fromBearing, t),
    };
  }

  private startFrames(): void {
    if (this.frameHandle !== null) return;

    const frame = () => {
      const now = performance.now();
      const wall = Date.now() / 1000;
      const out: TrackedVehicle[] = [];
      for (const track of this.tracks.values()) {
        const position = this.positionAt(track, now);
        out.push({
          ...track.vehicle,
          displayLat: position.lat,
          displayLon: position.lon,
          displayBearing: position.bearing,
          // By the vehicle's own report time, not when the feed last
          // repeated it: a feed that keeps re-sending a frozen position is
          // exactly the case this has to catch.
          stale: track.restored === true || wall - track.vehicle.timestamp > STALE_AFTER_SECONDS,
        });
      }
      for (const listener of this.frameListeners) listener(out);
      this.frameHandle = requestAnimationFrame(frame);
    };
    this.frameHandle = requestAnimationFrame(frame);
  }
}
