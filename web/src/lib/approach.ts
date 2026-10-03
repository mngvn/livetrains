import { approxMeters, bearingDegrees } from '../../../server/src/geo.js';

/**
 * Which vehicles are pulling in to a stop, for the connector drawn between
 * them on a zoomed-in map: a line that shortens as the vehicle closes in,
 * and turns green while it stands at the stop.
 *
 * The feed's word wins when it gives one — GTFS-Realtime can say which stop
 * a vehicle is at or heading for, and whether it is stopped there. Not every
 * feed says, so without it the stop is inferred: the nearest stop on the
 * vehicle's route that lies ahead of it.
 */

/** Further than this from its stop, a vehicle is not "arriving" yet. */
export const APPROACH_RANGE_M = 300;
/** Within this, a vehicle is at the stop rather than approaching it. */
export const AT_STOP_M = 20;
/** How far off its heading a stop can be and still count as ahead. */
const AHEAD_WITHIN_DEG = 60;
/** Slower than this (m/s), a vehicle at a stop is standing at it. */
const STANDING_SPEED = 0.5;

export interface ApproachStop {
  id: string;
  lat: number;
  lon: number;
  /** The routes calling here. A stop with none listed is never inferred. */
  routeIds: ReadonlySet<string>;
}

export interface ApproachVehicle {
  id: string;
  routeId?: string;
  lat: number;
  lon: number;
  /** Heading in degrees, only when the feed reported one. */
  bearing?: number;
  /** Metres per second. */
  speed?: number;
  stopId?: string;
  currentStatus?: 'incoming' | 'stopped' | 'in-transit';
  stale: boolean;
}

export interface Approach {
  vehicleId: string;
  stopId: string;
  vehicle: [number, number];
  stop: [number, number];
  /** 0 at the edge of range, 1 at the stop. */
  closeness: number;
  stopped: boolean;
}

/** Smallest angle between two headings, in degrees. */
function angleBetween(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** The nearest stop on the vehicle's route that it is at, or heading towards. */
function inferStop(vehicle: ApproachVehicle, stops: Iterable<ApproachStop>): { stop: ApproachStop; distance: number } | null {
  if (!vehicle.routeId) return null;
  let best: { stop: ApproachStop; distance: number } | null = null;
  for (const stop of stops) {
    if (!stop.routeIds.has(vehicle.routeId)) continue;
    // A cheap box first: most stops are nowhere near.
    if (Math.abs(stop.lat - vehicle.lat) > 0.004 || Math.abs(stop.lon - vehicle.lon) > 0.006) continue;
    const distance = approxMeters(vehicle.lat, vehicle.lon, stop.lat, stop.lon);
    if (distance > APPROACH_RANGE_M || (best && distance >= best.distance)) continue;
    if (distance > AT_STOP_M) {
      // Without a heading there is no telling a stop ahead from one just passed.
      if (vehicle.bearing === undefined) continue;
      const toStop = bearingDegrees(vehicle.lat, vehicle.lon, stop.lat, stop.lon);
      if (angleBetween(vehicle.bearing, toStop) > AHEAD_WITHIN_DEG) continue;
    }
    best = { stop, distance };
  }
  return best;
}

/** Every vehicle within range of the stop it is arriving at or standing at. */
export function findApproaches(
  vehicles: Iterable<ApproachVehicle>,
  stopsById: ReadonlyMap<string, ApproachStop>,
): Approach[] {
  const out: Approach[] = [];
  for (const vehicle of vehicles) {
    // Where a bus last was is worth showing; that it is pulling in is not.
    if (vehicle.stale) continue;

    let stop: ApproachStop | undefined;
    let distance: number;
    let stopped: boolean;
    const reported = vehicle.stopId ? stopsById.get(vehicle.stopId) : undefined;
    if (reported) {
      stop = reported;
      distance = approxMeters(vehicle.lat, vehicle.lon, stop.lat, stop.lon);
      stopped = vehicle.currentStatus === 'stopped';
    } else {
      const inferred = inferStop(vehicle, stopsById.values());
      if (!inferred) continue;
      ({ stop, distance } = inferred);
      stopped = distance <= AT_STOP_M && vehicle.speed !== undefined && vehicle.speed < STANDING_SPEED;
    }
    if (distance > APPROACH_RANGE_M) continue;

    out.push({
      vehicleId: vehicle.id,
      stopId: stop.id,
      vehicle: [vehicle.lon, vehicle.lat],
      stop: [stop.lon, stop.lat],
      closeness: stopped ? 1 : 1 - distance / APPROACH_RANGE_M,
      stopped,
    });
  }
  return out;
}

/** The approaches as map features: a connector each, and a ring on each stop. */
export function approachFeatures(approaches: Approach[]): {
  lines: GeoJSON.FeatureCollection;
  rings: GeoJSON.FeatureCollection;
} {
  // Two vehicles can share a stop; the ring shows the closest, and green
  // whenever either is standing there.
  const rings = new Map<string, Approach>();
  for (const a of approaches) {
    const held = rings.get(a.stopId);
    if (!held || (a.stopped && !held.stopped) || (a.stopped === held.stopped && a.closeness > held.closeness)) {
      rings.set(a.stopId, a);
    }
  }
  return {
    lines: {
      type: 'FeatureCollection',
      features: approaches.map((a) => ({
        type: 'Feature' as const,
        geometry: { type: 'LineString' as const, coordinates: [a.vehicle, a.stop] },
        properties: { id: a.vehicleId, closeness: a.closeness, stopped: a.stopped },
      })),
    },
    rings: {
      type: 'FeatureCollection',
      features: [...rings.values()].map((a) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: a.stop },
        properties: { id: a.stopId, closeness: a.closeness, stopped: a.stopped },
      })),
    },
  };
}
