import { formatGtfsTime } from '../gtfs/csv.js';
import { haversineMeters } from '../geo.js';
import { serviceDateAt, shiftServiceDate, splitServiceDate } from '../gtfs/time.js';

/**
 * A synthetic Twin Cities-shaped feed.
 *
 * Real Metro Transit data lives behind the network, which makes development,
 * tests and demos depend on it being reachable and on service running at the
 * moment you look. This generates a small but structurally complete GTFS feed
 * with the same shape as the real one — two rail lines that share a downtown
 * transfer point, three bus routes crossing them, and service that runs past
 * midnight — so every code path (transfers, 24h+ times, realtime overlay) is
 * exercised without a single request leaving the process.
 *
 * Station coordinates follow the real alignments closely enough that the map
 * looks like the Twin Cities; the timetable is invented.
 */

interface LineSpec {
  routeId: string;
  shortName: string;
  longName: string;
  /** GTFS route_type. */
  routeType: number;
  color: string;
  textColor: string;
  /** Minutes between departures. */
  headwayMinutes: number;
  /** Average speed in km/h, used to derive running times between stops. */
  speedKph: number;
  /** Seconds a vehicle sits at each stop. */
  dwellSeconds: number;
  stations: { id: string; name: string; lat: number; lon: number }[];
}

const LINES: LineSpec[] = [
  {
    routeId: 'BLUE',
    shortName: 'Blue',
    longName: 'Blue Line (Mall of America - Target Field)',
    routeType: 0,
    color: '003DA5',
    textColor: 'FFFFFF',
    headwayMinutes: 10,
    speedKph: 32,
    dwellSeconds: 30,
    stations: [
      { id: 'BL01', name: 'Target Field Station', lat: 44.9832, lon: -93.2777 },
      { id: 'BL02', name: 'Warehouse District/Hennepin Ave', lat: 44.9799, lon: -93.2733 },
      { id: 'BL03', name: 'Nicollet Mall Station', lat: 44.9784, lon: -93.2699 },
      { id: 'BL04', name: 'Government Plaza Station', lat: 44.9769, lon: -93.2657 },
      { id: 'BL05', name: 'U.S. Bank Stadium Station', lat: 44.9750, lon: -93.2596 },
      { id: 'BL06', name: 'Cedar-Riverside Station', lat: 44.9683, lon: -93.2510 },
      { id: 'BL07', name: 'Franklin Ave Station', lat: 44.9626, lon: -93.2472 },
      { id: 'BL08', name: 'Lake St/Midtown Station', lat: 44.9482, lon: -93.2390 },
      { id: 'BL09', name: '38th St Station', lat: 44.9345, lon: -93.2295 },
      { id: 'BL10', name: '46th St Station', lat: 44.9208, lon: -93.2197 },
      { id: 'BL11', name: 'Fort Snelling Station', lat: 44.8934, lon: -93.1980 },
      { id: 'BL12', name: 'Terminal 1 - Lindbergh Station', lat: 44.8807, lon: -93.2044 },
      { id: 'BL13', name: 'Mall of America Station', lat: 44.8548, lon: -93.2381 },
    ],
  },
  {
    routeId: 'GREEN',
    shortName: 'Green',
    longName: 'Green Line (Union Depot - Target Field)',
    routeType: 0,
    color: '00A94F',
    textColor: 'FFFFFF',
    headwayMinutes: 12,
    speedKph: 26,
    dwellSeconds: 30,
    stations: [
      { id: 'BL01', name: 'Target Field Station', lat: 44.9832, lon: -93.2777 },
      { id: 'BL02', name: 'Warehouse District/Hennepin Ave', lat: 44.9799, lon: -93.2733 },
      { id: 'BL03', name: 'Nicollet Mall Station', lat: 44.9784, lon: -93.2699 },
      { id: 'BL04', name: 'Government Plaza Station', lat: 44.9769, lon: -93.2657 },
      { id: 'BL05', name: 'U.S. Bank Stadium Station', lat: 44.9750, lon: -93.2596 },
      { id: 'GR06', name: 'West Bank Station', lat: 44.9721, lon: -93.2465 },
      { id: 'GR07', name: 'East Bank Station', lat: 44.9738, lon: -93.2310 },
      { id: 'GR08', name: 'Stadium Village Station', lat: 44.9749, lon: -93.2227 },
      { id: 'GR09', name: 'Prospect Park Station', lat: 44.9714, lon: -93.2154 },
      { id: 'GR10', name: 'Westgate Station', lat: 44.9675, lon: -93.2069 },
      { id: 'GR11', name: 'Raymond Ave Station', lat: 44.9633, lon: -93.1952 },
      { id: 'GR12', name: 'Fairview Ave Station', lat: 44.9558, lon: -93.1783 },
      { id: 'GR13', name: 'Snelling Ave Station', lat: 44.9556, lon: -93.1668 },
      { id: 'GR14', name: 'Lexington Pkwy Station', lat: 44.9556, lon: -93.1466 },
      { id: 'GR15', name: 'Western Ave Station', lat: 44.9556, lon: -93.1197 },
      { id: 'GR16', name: 'Capitol/Rice St Station', lat: 44.9552, lon: -93.1052 },
      { id: 'GR17', name: 'Central Station', lat: 44.9461, lon: -93.0925 },
      { id: 'GR18', name: 'Union Depot', lat: 44.9479, lon: -93.0855 },
    ],
  },
  {
    routeId: 'ROUTE21',
    shortName: '21',
    longName: 'Lake St / Marshall Ave',
    routeType: 3,
    color: '0B5FA5',
    textColor: 'FFFFFF',
    headwayMinutes: 15,
    speedKph: 18,
    dwellSeconds: 20,
    stations: [
      { id: 'R21A', name: 'Lake St & Hennepin Ave', lat: 44.9483, lon: -93.2980 },
      { id: 'R21B', name: 'Lake St & Lyndale Ave', lat: 44.9483, lon: -93.2880 },
      { id: 'R21C', name: 'Lake St & Nicollet Ave', lat: 44.9483, lon: -93.2778 },
      { id: 'BL08', name: 'Lake St/Midtown Station', lat: 44.9482, lon: -93.2390 },
      { id: 'R21E', name: 'Lake St & Minnehaha Ave', lat: 44.9483, lon: -93.2190 },
      { id: 'R21F', name: 'Marshall Ave & Cretin Ave', lat: 44.9487, lon: -93.1960 },
      { id: 'R21G', name: 'Marshall Ave & Snelling Ave', lat: 44.9490, lon: -93.1668 },
      { id: 'R21H', name: 'Selby Ave & Dale St', lat: 44.9463, lon: -93.1265 },
    ],
  },
  {
    routeId: 'ROUTE5',
    shortName: '5',
    longName: 'Chicago Ave / Fremont Ave',
    routeType: 3,
    color: '0B5FA5',
    textColor: 'FFFFFF',
    headwayMinutes: 12,
    speedKph: 17,
    dwellSeconds: 20,
    stations: [
      { id: 'R05A', name: 'Fremont Ave & 44th St N', lat: 45.0350, lon: -93.3080 },
      { id: 'R05B', name: 'Fremont Ave & Broadway', lat: 45.0000, lon: -93.2980 },
      { id: 'BL02', name: 'Warehouse District/Hennepin Ave', lat: 44.9799, lon: -93.2733 },
      { id: 'R05D', name: 'Chicago Ave & Franklin Ave', lat: 44.9628, lon: -93.2625 },
      { id: 'R05E', name: 'Chicago Ave & Lake St', lat: 44.9483, lon: -93.2625 },
      { id: 'R05F', name: 'Chicago Ave & 38th St', lat: 44.9345, lon: -93.2625 },
      { id: 'R05G', name: 'Chicago Ave & 46th St', lat: 44.9208, lon: -93.2625 },
      { id: 'BL13', name: 'Mall of America Station', lat: 44.8548, lon: -93.2381 },
    ],
  },
  {
    routeId: 'ROUTEA',
    shortName: 'A Line',
    longName: 'A Line BRT (46th St - Rosedale)',
    routeType: 3,
    color: 'C8102E',
    textColor: 'FFFFFF',
    headwayMinutes: 10,
    speedKph: 22,
    dwellSeconds: 20,
    stations: [
      { id: 'BL10', name: '46th St Station', lat: 44.9208, lon: -93.2197 },
      { id: 'RAB', name: 'Snelling Ave & Randolph Ave', lat: 44.9270, lon: -93.1668 },
      { id: 'RAC', name: 'Snelling Ave & Grand Ave', lat: 44.9400, lon: -93.1668 },
      { id: 'GR13', name: 'Snelling Ave Station', lat: 44.9556, lon: -93.1668 },
      { id: 'RAE', name: 'Snelling Ave & Hewitt Ave', lat: 44.9680, lon: -93.1668 },
      { id: 'RAF', name: 'Snelling Ave & Roselawn Ave', lat: 44.9950, lon: -93.1668 },
      { id: 'RAG', name: 'Rosedale Transit Center', lat: 45.0122, lon: -93.1700 },
    ],
  },
];

/** First and last departure of the service day, in seconds after midnight. */
const SERVICE_START = 5 * 3600;
/** 01:30 the following morning, encoded the GTFS way as hour 25. */
const SERVICE_END = 25 * 3600 + 1800;

function csv(rows: (string | number)[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const text = String(cell);
          return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        })
        .join(','),
    )
    .join('\n');
}

/** Seconds to travel between two stations at a line's average speed. */
function runningTime(line: LineSpec, from: LineSpec['stations'][0], to: LineSpec['stations'][0]): number {
  const meters = haversineMeters(from.lat, from.lon, to.lat, to.lon);
  return Math.max(45, Math.round(meters / ((line.speedKph * 1000) / 3600)));
}

/**
 * Builds the full set of GTFS files as text, ready for `GtfsStore.load`.
 *
 * Service is generated for a window around today so the feed is always "in
 * service" whenever it is loaded, which is what makes the demo work at any hour
 * and keeps tests from breaking overnight.
 */
export function buildMockGtfs(timezone = 'America/Chicago', now = Date.now()): Map<string, string> {
  const today = serviceDateAt(Math.floor(now / 1000), timezone);
  const startDate = shiftServiceDate(today, -7);
  const endDate = shiftServiceDate(today, 180);

  const stops = new Map<string, { id: string; name: string; lat: number; lon: number }>();
  const tripRows: (string | number)[][] = [['route_id', 'service_id', 'trip_id', 'trip_headsign', 'direction_id', 'shape_id']];
  const stopTimeRows: (string | number)[][] = [
    ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence', 'pickup_type', 'drop_off_type'],
  ];
  const shapeRows: (string | number)[][] = [['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence']];
  const routeRows: (string | number)[][] = [
    ['route_id', 'route_short_name', 'route_long_name', 'route_desc', 'route_type', 'route_color', 'route_text_color'],
  ];

  for (const line of LINES) {
    routeRows.push([
      line.routeId,
      line.shortName,
      line.longName,
      line.routeType === 0 ? 'Light rail' : 'Bus route',
      line.routeType,
      line.color,
      line.textColor,
    ]);

    for (const station of line.stations) stops.set(station.id, station);

    // Both directions: 0 is the listed order, 1 is the reverse.
    for (const direction of [0, 1] as const) {
      const stations = direction === 0 ? line.stations : [...line.stations].reverse();
      const shapeId = `${line.routeId}_${direction}`;

      stations.forEach((station, index) => {
        shapeRows.push([shapeId, station.lat, station.lon, index]);
      });

      // Cumulative offsets from the trip's first departure.
      const offsets: number[] = [0];
      for (let i = 1; i < stations.length; i++) {
        offsets.push(offsets[i - 1] + line.dwellSeconds + runningTime(line, stations[i - 1], stations[i]));
      }

      const headway = line.headwayMinutes * 60;
      // Offset the reverse direction by half a headway so the two directions
      // do not depart in lockstep, as on a real line.
      const firstDeparture = SERVICE_START + (direction === 1 ? headway / 2 : 0);
      let tripSeq = 0;

      for (let departure = firstDeparture; departure <= SERVICE_END; departure += headway) {
        const tripId = `${line.routeId}_${direction}_${tripSeq++}`;
        tripRows.push([
          line.routeId,
          'DAILY',
          tripId,
          stations[stations.length - 1].name,
          direction,
          shapeId,
        ]);
        stations.forEach((station, index) => {
          const time = formatGtfsTime(departure + offsets[index]);
          stopTimeRows.push([
            tripId,
            time,
            time,
            station.id,
            index,
            // Cannot board at the very last stop, nor alight at the first.
            index === stations.length - 1 ? 1 : 0,
            index === 0 ? 1 : 0,
          ]);
        });
      }
    }
  }

  const stopRows: (string | number)[][] = [['stop_id', 'stop_code', 'stop_name', 'stop_lat', 'stop_lon', 'location_type']];
  for (const stop of stops.values()) {
    stopRows.push([stop.id, stop.id, stop.name, stop.lat, stop.lon, 0]);
  }

  const { year, month, day } = splitServiceDate(today);
  const version = `mock-${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;

  return new Map<string, string>([
    [
      'agency.txt',
      csv([
        ['agency_id', 'agency_name', 'agency_url', 'agency_timezone'],
        ['MOCK', 'Demo Transit (synthetic)', 'https://example.invalid', timezone],
      ]),
    ],
    ['stops.txt', csv(stopRows)],
    ['routes.txt', csv(routeRows)],
    ['trips.txt', csv(tripRows)],
    ['stop_times.txt', csv(stopTimeRows)],
    [
      'calendar.txt',
      csv([
        ['service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date'],
        ['DAILY', 1, 1, 1, 1, 1, 1, 1, startDate, endDate],
      ]),
    ],
    ['calendar_dates.txt', csv([['service_id', 'date', 'exception_type']])],
    ['shapes.txt', csv(shapeRows)],
    [
      'feed_info.txt',
      csv([
        ['feed_publisher_name', 'feed_publisher_url', 'feed_lang', 'feed_version'],
        ['livetrains demo feed', 'https://example.invalid', 'en', version],
      ]),
    ],
  ]);
}

export { LINES as MOCK_LINES };
