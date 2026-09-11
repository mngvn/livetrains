import type { ServiceAlert, Vehicle } from '../shared/api.js';

/** A realtime prediction for one stop on one trip. */
export interface StopPrediction {
  /** Seconds of delay against the timetable; positive is late. */
  delaySeconds: number | null;
  /** Absolute predicted time in epoch seconds, when the feed gives one. */
  arrivalTime: number | null;
  departureTime: number | null;
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
export class RealtimeState {
  vehicles = new Map<string, Vehicle>();
  tripUpdates = new Map<string, TripUpdate>();
  alerts: ServiceAlert[] = [];

  lastVehicleUpdate: number | null = null;
  lastTripUpdate: number | null = null;
  lastAlertUpdate: number | null = null;
  lastError: string | null = null;

  /** Vehicle ids keyed by the trip they are operating, for leg matching. */
  private vehicleByTrip = new Map<string, string>();

  setVehicles(vehicles: Vehicle[]): void {
    const next = new Map<string, Vehicle>();
    const byTrip = new Map<string, string>();
    for (const v of vehicles) {
      next.set(v.id, v);
      if (v.tripId) byTrip.set(v.tripId, v.id);
    }
    this.vehicles = next;
    this.vehicleByTrip = byTrip;
    this.lastVehicleUpdate = Math.floor(Date.now() / 1000);
  }

  setTripUpdates(updates: TripUpdate[]): void {
    const next = new Map<string, TripUpdate>();
    for (const u of updates) next.set(u.tripId, u);
    this.tripUpdates = next;
    this.lastTripUpdate = Math.floor(Date.now() / 1000);
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

  alertsFor(routeIds: string[], stopIds: string[]): ServiceAlert[] {
    if (this.alerts.length === 0) return [];
    const routes = new Set(routeIds);
    const stops = new Set(stopIds);
    return this.alerts.filter(
      (a) =>
        a.routeIds.some((id) => routes.has(id)) || a.stopIds.some((id) => stops.has(id)),
    );
  }
}
