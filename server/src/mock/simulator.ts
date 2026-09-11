import type { ServiceAlert, Vehicle } from '../shared/api.js';
import type { GtfsStore } from '../gtfs/store.js';
import { bearingDegrees } from '../geo.js';
import { candidateServiceDays, epochFor } from '../gtfs/time.js';
import type { StopPrediction, TripUpdate } from '../realtime/state.js';

/**
 * Drives synthetic vehicles along the mock timetable.
 *
 * Rather than inventing random dots, this places a vehicle on every trip that
 * should be running right now and interpolates it between its scheduled stops.
 * The result behaves like a real GTFS-Realtime feed — vehicles appear at the
 * start of a trip, move at timetable speed, and disappear at the end — so the
 * client's interpolation, matching and delay handling get exercised properly.
 */
export class MockSimulator {
  /** Per-trip delay in seconds, held stable so vehicles don't jitter. */
  private readonly delays = new Map<string, number>();

  constructor(private readonly store: GtfsStore) {}

  /**
   * A pseudo-random but stable delay for a trip.
   *
   * Deterministic in the trip id so a given trip keeps the same delay across
   * polls: a bus that is four minutes late stays four minutes late, which is
   * what makes the countdowns on screen behave believably.
   */
  private delayFor(tripId: string): number {
    let cached = this.delays.get(tripId);
    if (cached === undefined) {
      let hash = 0;
      for (let i = 0; i < tripId.length; i++) hash = (hash * 31 + tripId.charCodeAt(i)) | 0;
      const bucket = Math.abs(hash) % 100;
      // Roughly: 55% on time, 35% a little late, 8% quite late, 2% early.
      if (bucket < 55) cached = 0;
      else if (bucket < 90) cached = 30 + (bucket % 5) * 30;
      else if (bucket < 98) cached = 240 + (bucket % 7) * 60;
      else cached = -60;
      this.delays.set(tripId, cached);
      if (this.delays.size > 20_000) this.delays.clear();
    }
    return cached;
  }

  /** Every vehicle that should be in motion at `now` (epoch seconds). */
  vehicles(now: number = Math.floor(Date.now() / 1000)): Vehicle[] {
    const store = this.store;
    const out: Vehicle[] = [];

    for (const { date, secondsOfDay } of candidateServiceDays(now, store.timezone)) {
      const services = store.activeServices(date);
      if (services.size === 0) continue;

      for (let trip = 0; trip < store.tripIds.length; trip++) {
        if (!services.has(store.tripService[trip])) continue;

        const from = store.stopTimeStart[trip];
        const to = store.stopTimeStart[trip + 1];
        if (to - from < 2) continue;

        const tripId = store.tripIds[trip];
        const delay = this.delayFor(tripId);
        const start = store.stopTimeDeparture[from] + delay;
        const end = store.stopTimeArrival[to - 1] + delay;
        if (secondsOfDay < start || secondsOfDay > end) continue;

        // Find the segment the vehicle is currently on.
        let segment = from;
        while (segment < to - 2 && store.stopTimeArrival[segment + 1] + delay < secondsOfDay) segment++;

        const departure = store.stopTimeDeparture[segment] + delay;
        const arrival = store.stopTimeArrival[segment + 1] + delay;
        const a = store.stops[store.stopTimeStop[segment]];
        const b = store.stops[store.stopTimeStop[segment + 1]];
        if (!a || !b) continue;

        const span = Math.max(1, arrival - departure);
        const progress = Math.min(1, Math.max(0, (secondsOfDay - departure) / span));

        const route = store.routes[store.tripRoute[trip]];
        const lat = a.lat + (b.lat - a.lat) * progress;
        const lon = a.lon + (b.lon - a.lon) * progress;

        out.push({
          id: `sim-${tripId}`,
          tripId,
          routeId: route.id,
          routeShortName: route.shortName,
          mode: route.mode,
          color: route.color,
          lat,
          lon,
          bearing: bearingDegrees(a.lat, a.lon, b.lat, b.lon),
          // Dwelling at a stop reads as zero speed, as it would in a real feed.
          speed: progress >= 1 ? 0 : Math.round(((b.lat - a.lat) ** 2 + (b.lon - a.lon) ** 2) ** 0.5 * 111_320) / span,
          headsign: store.tripHeadsigns[trip],
          directionId: store.tripDirection[trip],
          timestamp: now,
          delaySeconds: delay,
          occupancy: delay > 200 ? 'STANDING_ROOM_ONLY' : 'MANY_SEATS_AVAILABLE',
        });
      }
    }

    return out;
  }

  /** Trip updates matching the delays the simulated vehicles are carrying. */
  tripUpdates(now: number = Math.floor(Date.now() / 1000)): TripUpdate[] {
    const store = this.store;
    const updates: TripUpdate[] = [];

    for (const { date, secondsOfDay } of candidateServiceDays(now, store.timezone)) {
      const services = store.activeServices(date);
      if (services.size === 0) continue;

      for (let trip = 0; trip < store.tripIds.length; trip++) {
        if (!services.has(store.tripService[trip])) continue;
        const from = store.stopTimeStart[trip];
        const to = store.stopTimeStart[trip + 1];
        if (to - from < 2) continue;

        const tripId = store.tripIds[trip];
        const delay = this.delayFor(tripId);
        const start = store.stopTimeDeparture[from] + delay;
        const end = store.stopTimeArrival[to - 1] + delay;
        // Predictions exist for trips running now or starting within the hour,
        // mirroring how far ahead real producers publish.
        if (secondsOfDay < start - 3600 || secondsOfDay > end) continue;
        if (delay === 0) continue;

        const stops = new Map<string, StopPrediction>();
        for (let i = from; i < to; i++) {
          const stop = store.stops[store.stopTimeStop[i]];
          if (!stop) continue;
          stops.set(stop.id, {
            delaySeconds: delay,
            arrivalTime: epochFor(date, store.stopTimeArrival[i] + delay, store.timezone),
            departureTime: epochFor(date, store.stopTimeDeparture[i] + delay, store.timezone),
          });
        }

        updates.push({
          tripId,
          routeId: store.routes[store.tripRoute[trip]].id,
          stops,
          tripDelaySeconds: delay,
          cancelled: false,
          timestamp: now,
        });
      }
    }

    return updates;
  }

  /** A couple of fixed alerts, so the alerts UI has something to render. */
  alerts(): ServiceAlert[] {
    return [
      {
        id: 'mock-alert-1',
        header: 'Elevator out of service at Nicollet Mall Station',
        description:
          'The eastbound platform elevator is out of service for maintenance. Use Government Plaza Station for step-free access.',
        cause: 'MAINTENANCE',
        effect: 'ACCESSIBILITY_ISSUE',
        routeIds: ['BLUE', 'GREEN'],
        stopIds: ['BL03'],
      },
      {
        id: 'mock-alert-2',
        header: 'Route 21 detour on Lake Street',
        description: 'Buses are detouring via 28th Street between Hennepin and Nicollet due to construction.',
        cause: 'CONSTRUCTION',
        effect: 'DETOUR',
        routeIds: ['ROUTE21'],
        stopIds: [],
      },
    ];
  }
}
