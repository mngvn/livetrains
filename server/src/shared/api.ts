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

/**
 * An operator named in the feed's agency.txt.
 *
 * Distinct from `AgencyInfo`, which describes the deployment — the feed this
 * app was pointed at. One regional feed can carry many operators.
 */
export interface Operator {
  id: string;
  name: string;
  url?: string;
  phone?: string;
}

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
  /** Who runs it. Absent only for feeds with no agency.txt. */
  operator?: Operator;
}

/**
 * Step-free access, from GTFS wheelchair_boarding / wheelchair_accessible.
 * Omitted when the feed does not say, which is not the same as "no".
 */
export type Accessibility = 'accessible' | 'not-accessible';

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
  wheelchair?: Accessibility;
  /** Bay or platform letter shown on signs, e.g. "B". */
  platformCode?: string;
  /** Free-text location detail from the feed, e.g. "Nicollet Mall & 5th St". */
  description?: string;
}

/** A way through a station — an elevator, a stair — from pathways.txt. */
export interface PathwaySummary {
  mode: 'walkway' | 'stairs' | 'moving-sidewalk' | 'escalator' | 'elevator' | 'fare-gate' | 'exit-gate';
  description: string;
  stairCount?: number;
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
  /** The feed says this trip will not stop here after all. */
  skipped?: boolean;
  /** Whether this particular trip is run with an accessible vehicle. */
  wheelchair?: Accessibility;
  /** The whole trip has been cancelled. Still listed, so nobody waits for it. */
  cancelled?: boolean;
  /** Its vehicle is standing at this stop right now. */
  atStop?: boolean;
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
  /**
   * Seconds behind (positive) or ahead of (negative) the timetable, at the
   * stop the vehicle is at or heading for. Absent when there is no prediction
   * for its trip — which is not the same as being on time.
   */
  delaySeconds?: number;
  /** The stop the vehicle is at or approaching, when the feed says. */
  stopId?: string;
  /** Whether it is at `stopId`, about to reach it, or between stops. */
  currentStatus?: 'incoming' | 'stopped' | 'in-transit';
  occupancy?: string;
  /**
   * Whether the trip it is running is scheduled with an accessible vehicle.
   * (Who operates it lives on the trip detail, `VehicleTrip.route.operator`,
   * rather than here: this object is broadcast for every vehicle on every
   * poll, and only the selected one needs it.)
   */
  wheelchair?: Accessibility;
}

/**
 * One thing an alert is about, as the feed stated it.
 *
 * Kept whole rather than flattened, because the combinations carry meaning:
 * {route 156, stop 53316} is "this stop is closed for the 156", which is news
 * at that stop — not, as a flattened list of routes and stops would have it,
 * at every stop the 156 serves.
 */
export interface InformedEntity {
  agencyId?: string;
  routeId?: string;
  stopId?: string;
  tripId?: string;
}

export interface ServiceAlert {
  id: string;
  header: string;
  description: string;
  /** GTFS-RT Cause enum name, e.g. "CONSTRUCTION". */
  cause?: string;
  /** GTFS-RT Effect enum name, e.g. "NO_SERVICE", "DETOUR", "ACCESSIBILITY_ISSUE". */
  effect?: string;
  url?: string;
  /** Every route mentioned, for badges. Empty for agency-wide alerts. */
  routeIds: string[];
  /** Every stop mentioned. */
  stopIds: string[];
  informed: InformedEntity[];
  /** First active period, kept for simple display. */
  activeFrom?: number;
  activeUntil?: number;
  /** Every active period; an alert can recur, e.g. nightly closures. */
  periods: { start?: number; end?: number }[];
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

/** Everything the stop sidebar shows. */
export interface StopDetail {
  stop: StopSummary;
  /** Which GTFS stops were merged — both sides of the street, every platform. */
  groupedStopIds: string[];
  departures: Departure[];
  alerts: ServiceAlert[];
  /** Every route calling at any of the grouped stops. */
  routes: RouteSummary[];
  /** For a stop inside a station: the station, and its ways in and out. */
  station?: { id: string; name: string; pathways: PathwaySummary[] };
}

export interface RouteDetail {
  route: RouteSummary;
  directions: {
    directionId: number;
    headsign: string;
    stops: StopSummary[];
    geometry: [number, number][];
  }[];
  alerts: ServiceAlert[];
}

/** One stop along a vehicle's current trip. */
export interface TripStop {
  stop: StopSummary;
  /** Unix seconds, from the timetable. */
  scheduledTime: number;
  /** Unix seconds, from the realtime feed when it has a prediction. */
  predictedTime: number | null;
  delaySeconds: number | null;
  skipped: boolean;
}

/** A vehicle's whole trip: where it has been, where it is going, and when. */
export interface VehicleTrip {
  vehicleId: string;
  tripId: string;
  route: RouteSummary;
  headsign: string;
  /** The trip's drawn path, from shapes.txt when the feed has one. */
  geometry: [number, number][];
  stops: TripStop[];
  /** Index into `stops` of the stop the vehicle is at or heading for. */
  nextStopIndex: number;
  alerts: ServiceAlert[];
}

/** One result from searching routes and stops by name or number. */
export type TransitSearchResult =
  | { kind: 'route'; route: RouteSummary }
  | { kind: 'stop'; stop: StopSummary };

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
