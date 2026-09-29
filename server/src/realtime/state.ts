import type { GtfsStore } from '../gtfs/store.js';
import type { ServiceAlert, Vehicle } from '../shared/api.js';
import { vehicleDelay } from './vehicleDelay.js';

/** A realtime prediction for one stop on one trip. */
export interface StopPrediction {
  /** Seconds of delay against the timetable; positive is late. */
  delaySeconds: number | null;
  /** Absolute predicted time in epoch seconds, when the feed gives one. */
  arrivalTime: number | null;
  departureTime: number | null;
  /**
   * The vehicle will not call here at all on this trip (a SKIPPED
   * stop_time_update) — a detour, a closed station, an express run. Kept
   * distinct from "no prediction", which it otherwise looks exactly like.
   */
  skipped: boolean;
}

export interface TripUpdate {
  tripId: string;
  routeId?: string;
  /** Predictions keyed by stop id. */
  stops: Map<string, StopPrediction>;
  /** Delay applying to the whole trip, used when a stop has no entry of its own. */
  tripDelaySeconds: number | null;
  /** The trip is cancelled (schedule_relationship CANCELED). */
  cancelled: boolean;
  timestamp: number;
}

/**
 * The current realtime picture.
 *
 * Held as plain maps and replaced wholesale on each poll: GTFS-Realtime feeds
 * are full snapshots, not deltas, so merging would leave stale vehicles behind
 * after a bus goes out of service.
 */
/**
 * How long a trip-update snapshot stays trustworthy without a refresh.
 *
 * Feeds publish every 15–30 seconds; five minutes without one means the feed
 * or the connection is down, and predictions that old have drifted enough to
 * mislead.
 */
export const TRIP_UPDATE_MAX_AGE_SECONDS = 300;

export class RealtimeState {
  vehicles = new Map<string, Vehicle>();
  tripUpdates = new Map<string, TripUpdate>();
  alerts: ServiceAlert[] = [];

  lastVehicleUpdate: number | null = null;
  lastTripUpdate: number | null = null;
  /**
   * Bumped on every trip-update snapshot, for caches keyed on "the
   * predictions have changed". Not `lastTripUpdate`: that has one-second
   * resolution, and two snapshots inside the same second would look identical.
   */
  tripUpdateVersion = 0;
  lastAlertUpdate: number | null = null;
  lastError: string | null = null;

  /** Vehicle ids keyed by the trip they are operating, for leg matching. */
  private vehicleByTrip = new Map<string, string>();

  /**
   * Replaces the fleet.
   *
   * With a store, each vehicle's delay is worked out against the trip updates
   * already held. Positions and predictions arrive on separate feeds at
   * different rates, so whichever lands second finishes the job — see
   * `setTripUpdates` — and a vehicle is never broadcast without the best
   * delay currently knowable.
   */
  setVehicles(vehicles: Vehicle[], store: GtfsStore | null = null): void {
    const next = new Map<string, Vehicle>();
    const byTrip = new Map<string, string>();
    for (const v of vehicles) {
      next.set(v.id, v);
      if (v.tripId) byTrip.set(v.tripId, v.id);
    }
    this.vehicles = next;
    this.vehicleByTrip = byTrip;
    this.lastVehicleUpdate = Math.floor(Date.now() / 1000);
    if (store) this.annotateDelays(store);
  }

  setTripUpdates(updates: TripUpdate[], store: GtfsStore | null = null): void {
    const next = new Map<string, TripUpdate>();
    for (const u of updates) next.set(u.tripId, u);
    this.tripUpdates = next;
    this.lastTripUpdate = Math.floor(Date.now() / 1000);
    this.tripUpdateVersion++;
    if (store) this.annotateDelays(store);
  }

  /**
   * Drops predictions the feed has not refreshed for too long.
   *
   * Called after a failed poll. A delay reported ten minutes ago is not a
   * prediction any more; carrying on applying it — to departures, to the
   * planner — would present a guess as live information, which is worse than
   * falling back to the timetable and saying so. Vehicle positions are left
   * alone: they carry their own timestamps, and the map fades them as they
   * age rather than making them vanish.
   */
  expireTripUpdates(maxAgeSeconds: number, now = Math.floor(Date.now() / 1000)): boolean {
    if (this.lastTripUpdate === null || this.tripUpdates.size === 0) return false;
    if (now - this.lastTripUpdate <= maxAgeSeconds) return false;
    this.tripUpdates = new Map();
    this.tripUpdateVersion++;
    for (const vehicle of this.vehicles.values()) delete vehicle.delaySeconds;
    return true;
  }

  /** Recomputes every vehicle's delay from the trip updates held now. */
  annotateDelays(store: GtfsStore, now = Math.floor(Date.now() / 1000)): void {
    for (const vehicle of this.vehicles.values()) {
      const update = vehicle.tripId ? this.tripUpdates.get(vehicle.tripId) : undefined;
      const delay = vehicleDelay(vehicle, update, store, now);
      if (delay === undefined) delete vehicle.delaySeconds;
      else vehicle.delaySeconds = delay;
    }
  }

  setAlerts(alerts: ServiceAlert[]): void {
    this.alerts = alerts;
    this.lastAlertUpdate = Math.floor(Date.now() / 1000);
  }

  vehicleForTrip(tripId: string): Vehicle | undefined {
    const id = this.vehicleByTrip.get(tripId);
    return id === undefined ? undefined : this.vehicles.get(id);
  }

  isCancelled(tripId: string): boolean {
    return this.tripUpdates.get(tripId)?.cancelled ?? false;
  }

  /**
   * Delay in seconds for a specific stop on a trip, or null if unpredicted.
   *
   * Falls back to the trip-level delay: many producers publish a single delay
   * per trip rather than a per-stop prediction, and applying it uniformly is
   * far closer to the truth than pretending the trip is on time.
   */
  delayFor(tripId: string, stopId: string): number | null {
    const update = this.tripUpdates.get(tripId);
    if (!update) return null;
    const prediction = update.stops.get(stopId);
    if (prediction?.delaySeconds != null) return prediction.delaySeconds;
    return update.tripDelaySeconds;
  }

  /** True when the feed says this trip will not stop here. */
  isSkipped(tripId: string, stopId: string): boolean {
    return this.tripUpdates.get(tripId)?.stops.get(stopId)?.skipped ?? false;
  }

  /** An absolute predicted departure time, when the feed supplied one. */
  predictedDeparture(tripId: string, stopId: string): number | null {
    const p = this.tripUpdates.get(tripId)?.stops.get(stopId);
    return p?.departureTime ?? p?.arrivalTime ?? null;
  }

  /** An absolute predicted arrival time, when the feed supplied one. */
  predictedArrival(tripId: string, stopId: string): number | null {
    const p = this.tripUpdates.get(tripId)?.stops.get(stopId);
    return p?.arrivalTime ?? p?.departureTime ?? null;
  }

  /**
   * Alerts that matter to someone standing at these stops.
   *
   * An entity naming one of the stops applies, whatever route it also names.
   * An entity naming only a route applies everywhere that route goes, so it
   * applies here if the route calls here. An entity naming a route *and a
   * different stop* does not: that is a closure somewhere else on the line,
   * and matching it by route alone — as this once did — put news of one
   * closed stop on every stop the route serves.
   */
  alertsForStop(stopIds: string[], routeIds: string[]): ServiceAlert[] {
    if (this.alerts.length === 0) return [];
    const stops = new Set(stopIds);
    const routes = new Set(routeIds);
    return this.alerts.filter((alert) =>
      alert.informed.some((e) =>
        e.stopId !== undefined ? stops.has(e.stopId) : e.routeId !== undefined && routes.has(e.routeId),
      ),
    );
  }

  /**
   * Alerts that matter to someone riding a route: anything naming it, with or
   * without a particular stop — a stop closed on your line is your problem.
   */
  alertsForRoute(routeId: string): ServiceAlert[] {
    return this.alerts.filter((alert) => alert.informed.some((e) => e.routeId === routeId));
  }

  /** Alerts naming the whole agency and nothing narrower. */
  agencyWideAlerts(): ServiceAlert[] {
    return this.alerts.filter(
      (alert) =>
        alert.informed.length === 0 ||
        alert.informed.every((e) => !e.routeId && !e.stopId && !e.tripId),
    );
  }
}
