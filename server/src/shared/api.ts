/**
 * The wire contract between server and web client.
 *
 * This file is type-only on purpose: the web app imports it with `import type`,
 * so it erases at build time and never becomes a runtime dependency across the
 * workspace boundary.
 */

/** A transit agency whose feeds this server has loaded. */
export interface AgencyInfo {
  id: string;
  name: string;
  timezone: string;
  /** [west, south, east, north] — where to point the map on first load. */
  bbox: [number, number, number, number];
  center: [number, number];
  /** True when the agency publishes GTFS-Realtime vehicle positions. */
  hasVehicles: boolean;
}

/**
 * GTFS route_type, narrowed to the modes we render differently.
 * Values follow the GTFS spec; anything else falls back to `bus` styling.
 */
export type Mode = 'tram' | 'metro' | 'rail' | 'bus' | 'ferry' | 'cable' | 'funicular' | 'other';

export interface RouteSummary {
  id: string;
  /** Short public-facing designator, e.g. "Blue", "10", "921". */
  shortName: string;
  longName: string;
  mode: Mode;
  /** Hex colour without the leading '#', from GTFS routes.txt. */
  color: string;
  textColor: string;
  description?: string;
}

export interface StopSummary {
  id: string;
  /** The number riders see on the pole / use for text-for-departures. */
  code: string;
  name: string;
  lat: number;
  lon: number;
  /** Metres from the query point; only present on nearby-stop responses. */
  distance?: number;
  /** Distinct routes serving this stop, for the stop list badges. */
  routes?: RouteSummary[];
}

/** One upcoming departure from a stop. */
export interface Departure {
  tripId: string;
  routeId: string;
  routeShortName: string;
  mode: Mode;
  color: string;
  textColor: string;
  headsign: string;
  directionId: number;
  /** Unix seconds — scheduled time. */
  scheduledTime: number;
  /** Unix seconds — scheduled time plus any realtime delay. */
  expectedTime: number;
  /** Seconds of delay; positive is late. Null when no prediction exists. */
  delaySeconds: number | null;
  /** True when `expectedTime` came from a realtime feed rather than the timetable. */
  isRealtime: boolean;
  /** Live vehicle serving this trip, when we can match one. */
  vehicleId?: string;
}

/** A vehicle's current position, as broadcast on the SSE stream. */
export interface Vehicle {
  id: string;
  tripId?: string;
  routeId?: string;
  routeShortName?: string;
  mode: Mode;
  color: string;
  lat: number;
  lon: number;
  /** Degrees clockwise from north; undefined when the feed omits it. */
  bearing?: number;
  /** Metres per second. */
  speed?: number;
  headsign?: string;
  directionId?: number;
  /** Unix seconds when the vehicle reported this position. */
  timestamp: number;
  delaySeconds?: number;
  occupancy?: string;
}

export interface ServiceAlert {
  id: string;
  header: string;
  description: string;
  cause?: string;
  effect?: string;
  url?: string;
  /** Route ids this alert applies to. Empty means agency-wide. */
  routeIds: string[];
  stopIds: string[];
  activeFrom?: number;
  activeUntil?: number;
}

/** A geocoded place the rider can plan to or from. */
export interface Place {
  id: string;
  name: string;
  /** Secondary line, e.g. an address or the stop's cross-street. */
  detail?: string;
  lat: number;
  lon: number;
  kind: 'stop' | 'landmark' | 'address' | 'coordinate' | 'current-location';
}

export interface WalkLeg {
  type: 'walk';
  from: Place;
  to: Place;
  distanceMeters: number;
  durationSeconds: number;
  departureTime: number;
  arrivalTime: number;
  /** Straight-line geometry [lon, lat][] for drawing on the map. */
  geometry: [number, number][];
}

export interface TransitLeg {
  type: 'transit';
  route: RouteSummary;
  tripId: string;
  headsign: string;
  directionId: number;
  from: StopSummary;
  to: StopSummary;
  /** Unix seconds, realtime-adjusted when a prediction exists. */
  departureTime: number;
  arrivalTime: number;
  scheduledDepartureTime: number;
  scheduledArrivalTime: number;
  delaySeconds: number | null;
  isRealtime: boolean;
  /** Number of stops travelled, for the "7 stops" summary line. */
  numStops: number;
  /** Intermediate stops, in order, excluding the boarding stop. */
  intermediateStops: StopSummary[];
  geometry: [number, number][];
  /** The live vehicle operating this trip right now, if we found one. */
  vehicleId?: string;
}

export type Leg = WalkLeg | TransitLeg;

export interface Itinerary {
  /** Unix seconds at which the rider leaves the origin. */
  departureTime: number;
  arrivalTime: number;
  durationSeconds: number;
  walkDistanceMeters: number;
  walkDurationSeconds: number;
  transfers: number;
  /** True when at least one leg has a realtime prediction. */
  hasRealtime: boolean;
  legs: Leg[];
}

export interface PlanRequest {
  fromLat: number;
  fromLon: number;
  toLat: number;
  toLon: number;
  /** Unix seconds. Defaults to now. */
  departAt?: number;
  /** Treat `departAt` as the desired arrival instead of departure. */
  arriveBy?: boolean;
  maxWalkMeters?: number;
  maxTransfers?: number;
  /** Walking speed in metres per second. Defaults to 1.33 (~3 mph). */
  walkSpeed?: number;
}

export interface PlanResponse {
  from: Place;
  to: Place;
  itineraries: Itinerary[];
  /** Populated when no itinerary was found, explaining why. */
  message?: string;
}

export interface FeedStatus {
  agency: AgencyInfo;
  /** Whether the server is serving the synthetic demo feed. */
  mock: boolean;
  gtfs: {
    loaded: boolean;
    /** Unix seconds of the last successful static feed load. */
    loadedAt: number | null;
    stops: number;
    routes: number;
    trips: number;
    stopTimes: number;
    /** GTFS feed_info version string, when the agency publishes one. */
    version?: string;
    /** Why the static feed failed to load, when it did. */
    error?: string;
  };
  realtime: {
    vehicles: number;
    tripUpdates: number;
    alerts: number;
    lastVehicleUpdate: number | null;
    lastTripUpdate: number | null;
    /** Last polling error, if the most recent poll failed. */
    lastError: string | null;
  };
}
