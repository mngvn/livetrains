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
  /**
   * GTFS wheelchair_boarding: 0 unknown, 1 some accessible boarding, 2 none.
   * A platform left at 0 inherits its station's value, as the spec says.
   */
  wheelchair: 0 | 1 | 2;
  /** The platform or bay identifier riders see on signs, e.g. "B" or "2". */
  platformCode: string;
  /** stop_desc: free text, often a cross-street or boarding location. */
  description: string;
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
  /** The operator, from routes.txt agency_id; the feed's only agency if blank. */
  agencyId: string;
}

/** An operator named in agency.txt. One feed can carry several. */
export interface Agency {
  id: string;
  name: string;
  url: string;
  phone: string;
}

/**
 * GTFS pathway_mode: how a rider gets between two points inside a station.
 * Kept as names because the only use is telling a rider what is there.
 */
export type PathwayMode =
  | 'walkway'
  | 'stairs'
  | 'moving-sidewalk'
  | 'escalator'
  | 'elevator'
  | 'fare-gate'
  | 'exit-gate';

/** One way through a station, from pathways.txt. */
export interface Pathway {
  mode: PathwayMode;
  /** The agency's own description, e.g. "North tower elevator to track 2". */
  description: string;
  lengthMeters: number | null;
  stairCount: number | null;
  bidirectional: boolean;
}

const PATHWAY_MODES: Record<string, PathwayMode> = {
  '1': 'walkway',
  '2': 'stairs',
  '3': 'moving-sidewalk',
  '4': 'escalator',
  '5': 'elevator',
  '6': 'fare-gate',
  '7': 'exit-gate',
};

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
 * A transfer rule stated by the feed, from transfers.txt.
 *
 * `type` follows GTFS: 0 recommended, 1 timed (the vehicle waits), 2 requires
 * at least `minSeconds`, 3 not possible.
 */
export interface TransferRule {
  type: 0 | 1 | 2 | 3;
  minSeconds: number | null;
}

/**
 * Stride for packing a stop pair into one numeric key.
 *
 * Comfortably above any real feed's stop count, and small enough that the
 * largest key stays an exact integer in a double. Exported because unpacking
 * `transferRules` requires the same number that packed it.
 */
export const TRANSFER_KEY_STRIDE = 1_000_000;

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
  /**
   * Every operator in agency.txt.
   *
   * One regional feed routinely carries several: Metro Transit's names Maple
   * Grove, Plymouth, SouthWest Transit, the airport and the University of
   * Minnesota alongside itself. Which one runs a bus is worth telling a rider
   * — fares, passes and customer service all differ.
   */
  agencies: Agency[] = [];

  readonly stopIndexById = new Map<string, number>();
  readonly routeIndexById = new Map<string, number>();
  readonly agencyById = new Map<string, Agency>();

  // --- Trips, one entry per trip index -------------------------------------
  tripIds: string[] = [];
  tripHeadsigns: string[] = [];
  tripRoute = new Int32Array(0);
  tripService = new Int32Array(0);
  tripDirection = new Uint8Array(0);
  /** GTFS wheelchair_accessible per trip: 0 unknown, 1 accessible, 2 not. */
  tripWheelchair = new Uint8Array(0);
  tripShape: (string | null)[] = [];
  readonly tripIndexById = new Map<string, number>();

  /**
   * Routes through each station, by the station's stop index.
   *
   * From pathways.txt: the elevators, stairs and escalators between street
   * and platform. For a rider who cannot manage stairs this is the difference
   * between a station they can use and one they cannot, and it pairs with the
   * alerts feed, which is where an elevator being out of service is announced.
   */
  readonly stationPathways = new Map<number, Pathway[]>();

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

  /**
   * Stop-to-stop transfer rules from transfers.txt, keyed `from * stops + to`.
   *
   * The agency knows things the coordinates do not: that two platforms are
   * joined by a tunnel, that a pair of stops facing each other across eight
   * lanes cannot actually be walked between, that a particular connection is
   * held for two minutes. Where the feed says so, it outranks anything
   * computed from latitude and longitude.
   */
  readonly transferRules = new Map<number, TransferRule>();

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
  /**
   * The rows and columns that hold any stop at all.
   *
   * A query's cell range is clipped to this. Without it the scan is sized by
   * the query alone, and a degree of longitude shrinks towards nothing at the
   * poles: a search at latitude 90 asked for some 10^16 columns, which froze
   * the server (or a visitor's tab) on a single request.
   */
  private gridExtent = { rowMin: 0, rowMax: -1, colMin: 0, colMax: -1 };

  get stopTimeCount(): number {
    return this.stopTimeStop.length;
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  /**
   * Builds a store from the raw text of each GTFS file.
   *
   * **Consumes `files`**: each entry is dropped as soon as it has been parsed.
   * That is deliberate. JavaScript strings are UTF-16, so a 60MB feed costs
   * about 120MB held as text — on top of the arrays being built from it. On a
   * phone that transient peak, not the finished store, is what gets a tab
   * killed. Releasing as we go roughly halves it, and no caller needs the text
   * afterwards.
   */
  static load(files: Map<string, string>): GtfsStore {
    const store = new GtfsStore();
    const started = Date.now();

    /** Reads a file and immediately lets its text be collected. */
    const take = (name: string, required = false): string | undefined => {
      const text = files.get(name);
      if (text === undefined && required) {
        throw new Error(`GTFS archive is missing required file ${name}`);
      }
      files.delete(name);
      return text;
    };

    store.loadAgency(take('agency.txt'));
    store.loadStops(take('stops.txt', true)!);
    store.loadPathways(take('pathways.txt'));
    store.loadRoutes(take('routes.txt', true)!);
    store.loadCalendar(take('calendar.txt'), take('calendar_dates.txt'));
    store.loadTrips(take('trips.txt', true)!);
    store.loadFeedInfo(take('feed_info.txt'));
    // Shapes before stop_times: they are the two largest files in the feed, and
    // parsing them in this order means both are never held as text at once.
    store.loadTransfers(take('transfers.txt'));
    store.loadShapes(take('shapes.txt'));
    store.loadStopTimes(take('stop_times.txt', true)!);

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
    // GTFS requires every agency in a feed to share one timezone.
    if (rows[0]?.agency_timezone) this.timezone = rows[0].agency_timezone.trim();
    for (const row of rows) {
      const name = (row.agency_name || '').trim();
      if (!name) continue;
      // agency_id may be omitted when a feed has only one agency.
      const agency: Agency = {
        id: (row.agency_id ?? '').trim(),
        name,
        url: (row.agency_url || '').trim(),
        phone: (row.agency_phone || '').trim(),
      };
      this.agencies.push(agency);
      this.agencyById.set(agency.id, agency);
    }
  }

  /** The operator of a route, falling back to the feed's first agency. */
  agencyOf(route: Route): Agency | undefined {
    return this.agencyById.get(route.agencyId) ?? this.agencies[0];
  }

  /**
   * Station nodes (entrances, generic nodes, boarding areas), by id, to the
   * station they belong to. Only needed to place pathways, so it is dropped
   * once they are loaded.
   */
  private stationNodes: Map<string, string> | null = new Map();

  private loadFeedInfo(text: string | undefined): void {
    if (!text) return;
    const rows = parseCsv(text);
    this.feedVersion = rows[0]?.feed_version?.trim() || undefined;
  }

  /**
   * Reads transfers.txt.
   *
   * Rules qualified by route or trip are skipped: they constrain a particular
   * connection rather than the pair of stops, and applying them to every
   * transfer between those stops would forbid or force connections the feed
   * never spoke about. Stop-level rules are the ones that describe walking.
   */
  private loadTransfers(text: string | undefined): void {
    if (!text) return;
    let kept = 0;
    forEachRow(text, (row) => {
      if (row.from_route_id || row.to_route_id || row.from_trip_id || row.to_trip_id) return;
      const from = this.stopIndexById.get(row.from_stop_id ?? '');
      const to = this.stopIndexById.get(row.to_stop_id ?? '');
      if (from === undefined || to === undefined || from === to) return;

      // An absent transfer_type means 0, "recommended point", per the spec.
      const type = Number(row.transfer_type ?? '0');
      if (!Number.isInteger(type) || type < 0 || type > 3) return;
      const min = Number(row.min_transfer_time);

      this.transferRules.set(from * TRANSFER_KEY_STRIDE + to, {
        type: type as TransferRule['type'],
        minSeconds: Number.isFinite(min) && min >= 0 ? Math.round(min) : null,
      });
      kept++;
    });
    if (kept > 0) log.info(`gtfs: read ${kept} stop-level transfer rules`);
  }

  /** The transfer rule for a stop pair, if the feed states one. */
  transferRule(from: number, to: number): TransferRule | undefined {
    return this.transferRules.get(from * TRANSFER_KEY_STRIDE + to);
  }

  private loadStops(text: string): void {
    const parentIds: string[] = [];
    forEachRow(text, (row) => {
      const locationType = row.location_type?.trim();
      // Entrances, generic nodes and boarding areas are not boardable, but
      // pathways run between them, so remember which station each is in.
      if (locationType === '2' || locationType === '3' || locationType === '4') {
        const parent = row.parent_station?.trim();
        if (parent) this.stationNodes?.set(row.stop_id, parent);
        return;
      }
      if (locationType && locationType !== '0' && locationType !== '1') return;

      const lat = Number(row.stop_lat);
      const lon = Number(row.stop_lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

      const wheelchair = row.wheelchair_boarding?.trim();
      this.stopIndexById.set(row.stop_id, this.stops.length);
      parentIds.push(row.parent_station ?? '');
      this.stops.push({
        id: row.stop_id,
        code: (row.stop_code || row.stop_id).trim(),
        name: (row.stop_name || row.stop_id).trim(),
        lat,
        lon,
        parent: -1,
        wheelchair: wheelchair === '1' ? 1 : wheelchair === '2' ? 2 : 0,
        platformCode: (row.platform_code || '').trim(),
        description: (row.stop_desc || '').trim(),
      });
    });

    for (let i = 0; i < this.stops.length; i++) {
      const parentId = parentIds[i];
      if (parentId) this.stops[i].parent = this.stopIndexById.get(parentId) ?? -1;
    }

    // A platform that says nothing about wheelchair boarding takes its
    // station's answer; the spec defines 0 on a child stop as "inherit".
    for (const stop of this.stops) {
      if (stop.wheelchair === 0 && stop.parent >= 0) stop.wheelchair = this.stops[stop.parent].wheelchair;
    }
  }

  /**
   * Reads pathways.txt, grouping each pathway under the station it is in.
   *
   * A pathway joins two nodes — a platform, an entrance, a landing — and
   * either end identifies the station: a boardable stop by its parent, a node
   * by the parent remembered while loading stops.
   */
  private loadPathways(text: string | undefined): void {
    const nodes = this.stationNodes;
    this.stationNodes = null;
    if (!text) return;

    const stationFor = (id: string): number | undefined => {
      const index = this.stopIndexById.get(id);
      if (index !== undefined) {
        const stop = this.stops[index];
        return stop.parent >= 0 ? stop.parent : index;
      }
      const parent = nodes?.get(id);
      return parent === undefined ? undefined : this.stopIndexById.get(parent);
    };

    forEachRow(text, (row) => {
      const mode = PATHWAY_MODES[row.pathway_mode?.trim() ?? ''];
      if (!mode) return;
      const station = stationFor(row.from_stop_id ?? '') ?? stationFor(row.to_stop_id ?? '');
      if (station === undefined) return;

      const length = Number(row.length);
      const stairs = Number(row.stair_count);
      const pathway: Pathway = {
        mode,
        description: (row.signposted_as || row.pathway_code || '').trim(),
        lengthMeters: row.length && Number.isFinite(length) ? length : null,
        stairCount: row.stair_count && Number.isFinite(stairs) ? Math.abs(stairs) : null,
        bidirectional: row.is_bidirectional?.trim() === '1',
      };
      let list = this.stationPathways.get(station);
      if (!list) this.stationPathways.set(station, (list = []));
      list.push(pathway);
    });
  }

  /** The station a stop belongs to: its parent, or itself if it has none. */
  stationOf(stopIndex: number): number {
    const parent = this.stops[stopIndex].parent;
    return parent >= 0 ? parent : stopIndex;
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
        agencyId: (row.agency_id ?? '').trim() || (this.agencies[0]?.id ?? ''),
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
    const wheelchair: number[] = [];

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
      const access = row.wheelchair_accessible?.trim();
      wheelchair.push(access === '1' ? 1 : access === '2' ? 2 : 0);
    });

    this.tripRoute = Int32Array.from(routeIdx);
    this.tripService = Int32Array.from(serviceIdx);
    this.tripDirection = Uint8Array.from(direction);
    this.tripWheelchair = Uint8Array.from(wheelchair);
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

  private buildSpatialIndex(): void {
    const cell = GtfsStore.CELL_DEG;
    this.grid = new Map();
    const extent = { rowMin: Infinity, rowMax: -Infinity, colMin: Infinity, colMax: -Infinity };
    for (let i = 0; i < this.stops.length; i++) {
      const row = Math.floor(this.stops[i].lat / cell);
      const col = Math.floor(this.stops[i].lon / cell);
      // Pack (row, col) into one integer key; 100000 columns is ample for 360deg.
      const key = row * 100_000 + col;
      let bucket = this.grid.get(key);
      if (!bucket) {
        bucket = [];
        this.grid.set(key, bucket);
      }
      bucket.push(i);
      extent.rowMin = Math.min(extent.rowMin, row);
      extent.rowMax = Math.max(extent.rowMax, row);
      extent.colMin = Math.min(extent.colMin, col);
      extent.colMax = Math.max(extent.colMax, col);
    }
    this.gridExtent = this.stops.length > 0 ? extent : { rowMin: 0, rowMax: -1, colMin: 0, colMax: -1 };
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
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !(radiusMeters >= 0)) return found;
    // Only cells that can hold a stop: see `gridExtent`.
    const extent = this.gridExtent;
    const firstRow = Math.max(rowFrom, extent.rowMin);
    const lastRow = Math.min(rowTo, extent.rowMax);
    const firstCol = Math.max(colFrom, extent.colMin);
    const lastCol = Math.min(colTo, extent.colMax);
    for (let row = firstRow; row <= lastRow; row++) {
      for (let col = firstCol; col <= lastCol; col++) {
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

/**
 * The largest GTFS file read, uncompressed, and the most read in total.
 *
 * Each file becomes one JavaScript string, and V8 cannot build a string much
 * past 512MB, so a bigger file fails regardless. An archive that claims one
 * is far likelier to be malformed or hostile — a "zip bomb" that inflates a
 * few kilobytes into gigabytes — than a timetable. Checking the sizes the
 * archive declares, before inflating anything, turns that into a clear error
 * instead of an out-of-memory crash. Metro Transit's feed is about 60MB.
 */
export const MAX_GTFS_FILE_BYTES = 512 * 1024 * 1024;
export const MAX_GTFS_TOTAL_BYTES = 1024 * 1024 * 1024;

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
  'transfers.txt',
  'pathways.txt',
] as const;
