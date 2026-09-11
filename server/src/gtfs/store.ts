import type { Mode } from '../shared/api.js';
import { forEachRow, parseCsv, parseGtfsTime, type Row } from './csv.js';
import { approxMeters, latDegreesFor, lonDegreesFor } from '../geo.js';
import {
  dayOfWeek,
  shiftServiceDate,
  type ServiceDate,
} from './time.js';
import { log } from '../log.js';

export interface Stop {
  id: string;
  code: string;
  name: string;
  lat: number;
  lon: number;
  /** Index of the parent station, or -1. Used to merge platform-level stops. */
  parent: number;
}

export interface Route {
  id: string;
  shortName: string;
  longName: string;
  mode: Mode;
  color: string;
  textColor: string;
  description: string;
  /** Lower sorts first in route lists; from routes.txt route_sort_order. */
  sortOrder: number;
}

/** GTFS route_type -> the mode names the client styles against. */
function modeFromRouteType(routeType: string): Mode {
  switch (routeType.trim()) {
    case '0':
      return 'tram';
    case '1':
      return 'metro';
    case '2':
      return 'rail';
    case '3':
      return 'bus';
    case '4':
      return 'ferry';
    case '5':
      return 'cable';
    case '6':
      return 'cable'; // aerial lift
    case '7':
      return 'funicular';
    default: {
      // Extended route types (the 100-1700 block) bucket by their hundreds digit.
      const n = Number(routeType);
      if (!Number.isFinite(n)) return 'other';
      if (n >= 100 && n < 200) return 'rail';
      if (n >= 200 && n < 300) return 'bus';
      if (n >= 400 && n < 500) return 'metro';
      if (n >= 700 && n < 900) return 'bus';
      if (n >= 900 && n < 1000) return 'tram';
      if (n >= 1000 && n < 1100) return 'ferry';
      return 'other';
    }
  }
}

/** Default colours when an agency leaves routes.txt colour columns blank. */
const MODE_FALLBACK_COLOR: Record<Mode, string> = {
  tram: '0055A5',
  metro: '0055A5',
  rail: '6F7C82',
  bus: '0B5FA5',
  ferry: '007B8A',
  cable: '8A5A00',
  funicular: '8A5A00',
  other: '555555',
};

interface ServiceWindow {
  /** Bit 0 = Sunday .. bit 6 = Saturday, matching `dayOfWeek`. */
  days: number;
  start: ServiceDate;
  end: ServiceDate;
}

/**
 * The parsed static feed.
 *
 * Stops and routes stay as objects (there are only thousands of them), while
 * trips and stop_times are held in parallel typed arrays. For Metro Transit
 * that is roughly 1.5M stop times: as objects they would cost hundreds of
 * megabytes and stall the GC, as Int32Arrays they cost about 18MB.
 */
export class GtfsStore {
  stops: Stop[] = [];
  routes: Route[] = [];

  readonly stopIndexById = new Map<string, number>();
  readonly routeIndexById = new Map<string, number>();

  // --- Trips, one entry per trip index -------------------------------------
  tripIds: string[] = [];
  tripHeadsigns: string[] = [];
  tripRoute = new Int32Array(0);
  tripService = new Int32Array(0);
  tripDirection = new Uint8Array(0);
  tripShape: (string | null)[] = [];
  readonly tripIndexById = new Map<string, number>();

  /** `stopTimeStart[t] .. stopTimeStart[t+1]` bounds trip `t`'s stop times. */
  stopTimeStart = new Int32Array(0);
  stopTimeStop = new Int32Array(0);
  stopTimeArrival = new Int32Array(0);
  stopTimeDeparture = new Int32Array(0);
  /** Whether riders may board / alight here (GTFS pickup_type/drop_off_type). */
  stopTimePickup = new Uint8Array(0);
  stopTimeDropOff = new Uint8Array(0);

  // --- Calendar -------------------------------------------------------------
  serviceIds: string[] = [];
  private readonly serviceIndexById = new Map<string, number>();
  private readonly serviceWindows: ServiceWindow[] = [];
  /** serviceIdx -> date -> true (added) / false (removed), from calendar_dates. */
  private readonly serviceExceptions = new Map<number, Map<ServiceDate, boolean>>();
  private readonly activeServiceCache = new Map<ServiceDate, Set<number>>();

  shapes = new Map<string, [number, number][]>();
  feedVersion: string | undefined;
  timezone = 'America/Chicago';
  loadedAt: number | null = null;

  /** Distinct route indices serving each stop, for stop badges and filtering. */
  routesAtStop: number[][] = [];

  // --- Spatial index --------------------------------------------------------
  /** Grid cell size in degrees latitude; ~1.1km, a good fit for walk radii. */
  private static readonly CELL_DEG = 0.01;
  private grid = new Map<number, number[]>();

  get stopTimeCount(): number {
    return this.stopTimeStop.length;
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  /** Builds a store from the raw text of each GTFS file. */
  static load(files: Map<string, string>): GtfsStore {
    const store = new GtfsStore();
    const started = Date.now();

    store.loadAgency(files.get('agency.txt'));
    store.loadStops(requireFile(files, 'stops.txt'));
    store.loadRoutes(requireFile(files, 'routes.txt'));
    store.loadCalendar(files.get('calendar.txt'), files.get('calendar_dates.txt'));
    store.loadTrips(requireFile(files, 'trips.txt'));
    store.loadStopTimes(requireFile(files, 'stop_times.txt'));
    store.loadShapes(files.get('shapes.txt'));
    store.loadFeedInfo(files.get('feed_info.txt'));

    store.buildSpatialIndex();
    store.buildRoutesAtStop();
    store.loadedAt = Math.floor(Date.now() / 1000);

    log.info(
      `gtfs: loaded ${store.stops.length} stops, ${store.routes.length} routes, ` +
        `${store.tripIds.length} trips, ${store.stopTimeCount} stop times ` +
        `in ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
    return store;
  }

  private loadAgency(text: string | undefined): void {
    if (!text) return;
    const rows = parseCsv(text);
    if (rows[0]?.agency_timezone) this.timezone = rows[0].agency_timezone.trim();
  }

  private loadFeedInfo(text: string | undefined): void {
    if (!text) return;
    const rows = parseCsv(text);
    this.feedVersion = rows[0]?.feed_version?.trim() || undefined;
  }

  private loadStops(text: string): void {
    const parentIds: string[] = [];
    forEachRow(text, (row) => {
      const lat = Number(row.stop_lat);
      const lon = Number(row.stop_lon);
      // Entrances and generic nodes carry no coordinates; they are not boardable.
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      const locationType = row.location_type?.trim();
      if (locationType && locationType !== '0' && locationType !== '1') return;

      this.stopIndexById.set(row.stop_id, this.stops.length);
      parentIds.push(row.parent_station ?? '');
      this.stops.push({
        id: row.stop_id,
        code: (row.stop_code || row.stop_id).trim(),
        name: (row.stop_name || row.stop_id).trim(),
        lat,
        lon,
        parent: -1,
      });
    });

    for (let i = 0; i < this.stops.length; i++) {
      const parentId = parentIds[i];
      if (parentId) this.stops[i].parent = this.stopIndexById.get(parentId) ?? -1;
    }
  }

  private loadRoutes(text: string): void {
    forEachRow(text, (row) => {
      const mode = modeFromRouteType(row.route_type ?? '3');
      const color = (row.route_color || '').trim().replace(/^#/, '');
      this.routeIndexById.set(row.route_id, this.routes.length);
      this.routes.push({
        id: row.route_id,
        shortName: (row.route_short_name || row.route_long_name || row.route_id).trim(),
        longName: (row.route_long_name || '').trim(),
        mode,
        color: /^[0-9a-fA-F]{6}$/.test(color) ? color.toUpperCase() : MODE_FALLBACK_COLOR[mode],
        textColor: (row.route_text_color || '').trim().replace(/^#/, '') || 'FFFFFF',
        description: (row.route_desc || '').trim(),
        sortOrder: Number(row.route_sort_order) || 0,
      });
    });
  }

  private serviceIndex(id: string): number {
    let idx = this.serviceIndexById.get(id);
    if (idx === undefined) {
      idx = this.serviceIds.length;
      this.serviceIds.push(id);
      this.serviceIndexById.set(id, idx);
      this.serviceWindows.push({ days: 0, start: 0, end: 0 });
    }
    return idx;
  }

  private loadCalendar(calendar: string | undefined, calendarDates: string | undefined): void {
    if (calendar) {
      forEachRow(calendar, (row) => {
        const idx = this.serviceIndex(row.service_id);
        const on = (v: string) => (v?.trim() === '1' ? 1 : 0);
        this.serviceWindows[idx] = {
          days:
            (on(row.sunday) << 0) |
            (on(row.monday) << 1) |
            (on(row.tuesday) << 2) |
            (on(row.wednesday) << 3) |
            (on(row.thursday) << 4) |
            (on(row.friday) << 5) |
            (on(row.saturday) << 6),
          start: Number(row.start_date) || 0,
          end: Number(row.end_date) || 99999999,
        };
      });
    }

    if (calendarDates) {
      forEachRow(calendarDates, (row) => {
        const idx = this.serviceIndex(row.service_id);
        const date = Number(row.date);
        if (!date) return;
        let map = this.serviceExceptions.get(idx);
        if (!map) {
          map = new Map();
          this.serviceExceptions.set(idx, map);
        }
        // exception_type 1 = service added, 2 = service removed.
        map.set(date, row.exception_type?.trim() === '1');
      });
    }
  }

  private loadTrips(text: string): void {
    const routeIdx: number[] = [];
    const serviceIdx: number[] = [];
    const direction: number[] = [];

    forEachRow(text, (row) => {
      const r = this.routeIndexById.get(row.route_id);
      if (r === undefined) return; // trip references a route we skipped
      this.tripIndexById.set(row.trip_id, this.tripIds.length);
      this.tripIds.push(row.trip_id);
      this.tripHeadsigns.push((row.trip_headsign || '').trim());
      this.tripShape.push(row.shape_id?.trim() || null);
      routeIdx.push(r);
      serviceIdx.push(this.serviceIndex(row.service_id));
      direction.push(row.direction_id?.trim() === '1' ? 1 : 0);
    });

    this.tripRoute = Int32Array.from(routeIdx);
    this.tripService = Int32Array.from(serviceIdx);
    this.tripDirection = Uint8Array.from(direction);
  }

  /**
   * Loads stop_times in two passes.
   *
   * The first pass counts times per trip so the flat arrays can be allocated
   * once at exactly the right size; the second fills them. Two passes over the
   * text beat growing arrays, and avoid holding an intermediate object per row.
   * GTFS does not guarantee stop_times are grouped or sorted, so each trip's
   * slice is sorted by stop_sequence at the end.
   */
  private loadStopTimes(text: string): void {
    const tripCount = this.tripIds.length;
    const counts = new Int32Array(tripCount);

    forEachRow(text, (row) => {
      const t = this.tripIndexById.get(row.trip_id);
      if (t !== undefined) counts[t]++;
    });

    const start = new Int32Array(tripCount + 1);
    for (let t = 0; t < tripCount; t++) start[t + 1] = start[t] + counts[t];
    const total = start[tripCount];

    const stopIdx = new Int32Array(total);
    const arrival = new Int32Array(total);
    const departure = new Int32Array(total);
    const pickup = new Uint8Array(total);
    const dropOff = new Uint8Array(total);
    const sequence = new Int32Array(total);
    const cursor = start.slice(0, tripCount);

    forEachRow(text, (row: Row) => {
      const t = this.tripIndexById.get(row.trip_id);
      if (t === undefined) return;
      const s = this.stopIndexById.get(row.stop_id);
      if (s === undefined) return;

      const i = cursor[t]++;
      let arr = parseGtfsTime(row.arrival_time);
      let dep = parseGtfsTime(row.departure_time);
      // Interpolated (blank) times are common at minor stops; fall back to
      // whichever of the pair is present so the trip stays usable.
      if (arr < 0) arr = dep;
      if (dep < 0) dep = arr;

      stopIdx[i] = s;
      arrival[i] = arr;
      departure[i] = dep;
      sequence[i] = Number(row.stop_sequence) || 0;
      // pickup/drop_off type 1 means "not available" at this stop.
      pickup[i] = row.pickup_type?.trim() === '1' ? 0 : 1;
      dropOff[i] = row.drop_off_type?.trim() === '1' ? 0 : 1;
    });

    // Trim trips whose rows were short (a stop_time referencing a dropped stop).
    for (let t = 0; t < tripCount; t++) {
      const end = start[t + 1];
      for (let i = cursor[t]; i < end; i++) {
        stopIdx[i] = -1;
        arrival[i] = -1;
        departure[i] = -1;
        sequence[i] = Number.MAX_SAFE_INTEGER;
      }
    }

    this.sortStopTimes(start, sequence, stopIdx, arrival, departure, pickup, dropOff);

    this.stopTimeStart = start;
    this.stopTimeStop = stopIdx;
    this.stopTimeArrival = arrival;
    this.stopTimeDeparture = departure;
    this.stopTimePickup = pickup;
    this.stopTimeDropOff = dropOff;
  }

  /** Orders each trip's slice by stop_sequence, in place. */
  private sortStopTimes(
    start: Int32Array,
    sequence: Int32Array,
    stopIdx: Int32Array,
    arrival: Int32Array,
    departure: Int32Array,
    pickup: Uint8Array,
    dropOff: Uint8Array,
  ): void {
    const order: number[] = [];
    for (let t = 0; t < this.tripIds.length; t++) {
      const from = start[t];
      const to = start[t + 1];
      const n = to - from;
      if (n < 2) continue;

      let sorted = true;
      for (let i = from + 1; i < to; i++) {
        if (sequence[i] < sequence[i - 1]) {
          sorted = false;
          break;
        }
      }
      if (sorted) continue;

      order.length = 0;
      for (let i = from; i < to; i++) order.push(i);
      order.sort((a, b) => sequence[a] - sequence[b]);

      const s = order.map((i) => stopIdx[i]);
      const a = order.map((i) => arrival[i]);
      const d = order.map((i) => departure[i]);
      const p = order.map((i) => pickup[i]);
      const o = order.map((i) => dropOff[i]);
      for (let k = 0; k < n; k++) {
        stopIdx[from + k] = s[k];
        arrival[from + k] = a[k];
        departure[from + k] = d[k];
        pickup[from + k] = p[k];
        dropOff[from + k] = o[k];
      }
    }
  }

  private loadShapes(text: string | undefined): void {
    if (!text) return;
    const withSequence = new Map<string, { seq: number; pt: [number, number] }[]>();
    forEachRow(text, (row) => {
      const id = row.shape_id;
      if (!id) return;
      const lat = Number(row.shape_pt_lat);
      const lon = Number(row.shape_pt_lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      let pts = withSequence.get(id);
      if (!pts) {
        pts = [];
        withSequence.set(id, pts);
      }
      pts.push({ seq: Number(row.shape_pt_sequence) || 0, pt: [lon, lat] });
    });

    for (const [id, pts] of withSequence) {
      pts.sort((a, b) => a.seq - b.seq);
      this.shapes.set(
        id,
        pts.map((p) => p.pt),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Derived indexes
  // -------------------------------------------------------------------------

  private cellKey(lat: number, lon: number): number {
    const cell = GtfsStore.CELL_DEG;
    // Pack (row, col) into one integer key; 100000 columns is ample for 360deg.
    return Math.floor(lat / cell) * 100_000 + Math.floor(lon / cell);
  }

  private buildSpatialIndex(): void {
    this.grid = new Map();
    for (let i = 0; i < this.stops.length; i++) {
      const key = this.cellKey(this.stops[i].lat, this.stops[i].lon);
      let bucket = this.grid.get(key);
      if (!bucket) {
        bucket = [];
        this.grid.set(key, bucket);
      }
      bucket.push(i);
    }
  }

  private buildRoutesAtStop(): void {
    const sets = Array.from({ length: this.stops.length }, () => new Set<number>());
    for (let t = 0; t < this.tripIds.length; t++) {
      const r = this.tripRoute[t];
      for (let i = this.stopTimeStart[t]; i < this.stopTimeStart[t + 1]; i++) {
        const s = this.stopTimeStop[i];
        if (s >= 0) sets[s].add(r);
      }
    }
    this.routesAtStop = sets.map((set) => [...set].sort((a, b) => a - b));
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /**
   * Stops within `radiusMeters` of a point, nearest first.
   *
   * Scans only the grid cells the radius touches, so cost scales with the
   * result size rather than the size of the feed.
   */
  nearbyStops(
    lat: number,
    lon: number,
    radiusMeters: number,
    limit = 50,
  ): { index: number; distance: number }[] {
    const cell = GtfsStore.CELL_DEG;
    const latSpan = latDegreesFor(radiusMeters);
    const lonSpan = lonDegreesFor(radiusMeters, lat);
    const cosLat = Math.cos((lat * Math.PI) / 180);

    const rowFrom = Math.floor((lat - latSpan) / cell);
    const rowTo = Math.floor((lat + latSpan) / cell);
    const colFrom = Math.floor((lon - lonSpan) / cell);
    const colTo = Math.floor((lon + lonSpan) / cell);

    const found: { index: number; distance: number }[] = [];
    for (let row = rowFrom; row <= rowTo; row++) {
      for (let col = colFrom; col <= colTo; col++) {
        const bucket = this.grid.get(row * 100_000 + col);
        if (!bucket) continue;
        for (const index of bucket) {
          const stop = this.stops[index];
          const distance = approxMeters(lat, lon, stop.lat, stop.lon, cosLat);
          if (distance <= radiusMeters) found.push({ index, distance });
        }
      }
    }

    found.sort((a, b) => a.distance - b.distance);
    return found.length > limit ? found.slice(0, limit) : found;
  }

  /** Whether `serviceIdx` operates on `date`, honouring calendar_dates. */
  isServiceActive(serviceIdx: number, date: ServiceDate): boolean {
    const exception = this.serviceExceptions.get(serviceIdx)?.get(date);
    if (exception !== undefined) return exception;
    const window = this.serviceWindows[serviceIdx];
    if (!window || window.days === 0) return false;
    if (date < window.start || date > window.end) return false;
    return (window.days & (1 << dayOfWeek(date))) !== 0;
  }

  /** The set of service indices running on `date`, memoised per date. */
  activeServices(date: ServiceDate): Set<number> {
    let cached = this.activeServiceCache.get(date);
    if (cached) return cached;
    cached = new Set<number>();
    for (let s = 0; s < this.serviceIds.length; s++) {
      if (this.isServiceActive(s, date)) cached.add(s);
    }
    // Bound the cache; queries only ever touch a handful of dates around today.
    if (this.activeServiceCache.size > 32) this.activeServiceCache.clear();
    this.activeServiceCache.set(date, cached);
    return cached;
  }

  /** The most recent service date on which any service runs, for diagnostics. */
  lastServiceDate(from: ServiceDate): ServiceDate | null {
    for (let i = 0; i < 400; i++) {
      const date = shiftServiceDate(from, i);
      if (this.activeServices(date).size > 0) return date;
    }
    return null;
  }

  stopById(id: string): Stop | undefined {
    const idx = this.stopIndexById.get(id);
    return idx === undefined ? undefined : this.stops[idx];
  }

  routeById(id: string): Route | undefined {
    const idx = this.routeIndexById.get(id);
    return idx === undefined ? undefined : this.routes[idx];
  }

  /** The shape for a trip, falling back to a line through its stops. */
  tripGeometry(tripIdx: number): [number, number][] {
    const shapeId = this.tripShape[tripIdx];
    if (shapeId) {
      const shape = this.shapes.get(shapeId);
      if (shape && shape.length > 1) return shape;
    }
    const pts: [number, number][] = [];
    for (let i = this.stopTimeStart[tripIdx]; i < this.stopTimeStart[tripIdx + 1]; i++) {
      const s = this.stopTimeStop[i];
      if (s >= 0) pts.push([this.stops[s].lon, this.stops[s].lat]);
    }
    return pts;
  }
}

function requireFile(files: Map<string, string>, name: string): string {
  const text = files.get(name);
  if (text === undefined) throw new Error(`GTFS archive is missing required file ${name}`);
  return text;
}

/** The GTFS files this server reads. Anything else in the zip is ignored. */
export const GTFS_FILES = [
  'agency.txt',
  'stops.txt',
  'routes.txt',
  'trips.txt',
  'stop_times.txt',
  'calendar.txt',
  'calendar_dates.txt',
  'shapes.txt',
  'feed_info.txt',
] as const;
