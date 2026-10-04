import { deadReckon, type Plane, type PlanesResponse } from '../shared/planes.js';

/**
 * Synthetic aircraft for the demo feed: arrivals and departures at the
 * airport, a jet crossing high overhead, a light aircraft round the lakes, a
 * helicopter downtown, and a couple of airliners on the ground.
 *
 * Each flies a fixed loop on a clock, so every poll agrees with the last and
 * the client's dead reckoning gets exercised exactly as it would by a real
 * feed — and, like the rest of mock mode, nothing leaves the process.
 */

interface Waypoint {
  lat: number;
  lon: number;
  /** Feet; 0 on the ground. */
  alt: number;
}

interface MockFlight {
  plane: Omit<Plane, 'lat' | 'lon' | 'altitude' | 'onGround' | 'groundSpeed' | 'track' | 'verticalRate' | 'positionAt'>;
  path: Waypoint[];
  knots: number;
  /** Seconds into the loop at the epoch, so flights are spread out. */
  phase: number;
  /** Seconds spent out of the area between laps, so the sky is not always full. */
  gap?: number;
}

/** The threshold of the runway the arrivals land on, and the departures leave from. */
const RUNWAY = { lat: 44.8795, lon: -93.2005 };
const FINAL_COURSE = 300;

/** A point `nm` nautical miles from another: 3,600 knots is a mile a second. */
const out = (from: { lat: number; lon: number }, bearing: number, nm: number, alt: number): Waypoint => ({
  ...deadReckon(from.lat, from.lon, bearing, 3600, nm),
  alt,
});

const FLIGHTS: MockFlight[] = [
  {
    plane: { id: 'a5b0c1', callsign: 'DAL1554', registration: 'N390DN', typeCode: 'A321', category: 'A3', squawk: '3341' },
    path: [
      out(RUNWAY, FINAL_COURSE + 180 + 25, 40, 11000),
      out(RUNWAY, FINAL_COURSE + 180, 14, 4000),
      out(RUNWAY, FINAL_COURSE + 180, 5, 1700),
      { ...RUNWAY, alt: 900 },
    ],
    knots: 190,
    phase: 0,
    gap: 120,
  },
  {
    plane: { id: 'a095aa', callsign: 'EDV5350', registration: 'N137EV', typeCode: 'CRJ9', category: 'A3', squawk: '7325' },
    path: [
      out(RUNWAY, 20, 38, 12000),
      out(RUNWAY, FINAL_COURSE + 180, 16, 4000),
      out(RUNWAY, FINAL_COURSE + 180, 5, 1700),
      { ...RUNWAY, alt: 900 },
    ],
    knots: 180,
    phase: 400,
    gap: 200,
  },
  {
    plane: { id: 'aa1f36', callsign: 'SCX617', registration: 'N809SY', typeCode: 'B738', category: 'A3', squawk: '2214' },
    path: [
      { ...RUNWAY, alt: 900 },
      out(RUNWAY, FINAL_COURSE, 6, 4500),
      out(RUNWAY, FINAL_COURSE - 30, 38, 17000),
    ],
    knots: 230,
    phase: 150,
    gap: 240,
  },
  {
    plane: { id: 'a9c4e2', callsign: 'UAL1305', registration: 'N813UA', typeCode: 'A319', category: 'A3', squawk: '4627' },
    path: [
      { lat: 45.35, lon: -92.4, alt: 35000 },
      { lat: 44.62, lon: -94.1, alt: 35000 },
    ],
    knots: 460,
    phase: 90,
    gap: 300,
  },
  {
    plane: { id: 'a0eb60', callsign: 'N1588J', registration: 'N1588J', typeCode: 'P28A', category: 'A1', squawk: '1200' },
    // Round the Chain of Lakes and back.
    path: [
      { lat: 44.975, lon: -93.36, alt: 2500 },
      { lat: 44.955, lon: -93.33, alt: 2600 },
      { lat: 44.93, lon: -93.315, alt: 2500 },
      { lat: 44.93, lon: -93.28, alt: 2400 },
      { lat: 44.958, lon: -93.29, alt: 2500 },
      { lat: 44.975, lon: -93.36, alt: 2500 },
    ],
    knots: 95,
    phase: 0,
  },
  {
    plane: { id: 'a6c2f0', callsign: 'LIFE2', registration: 'N912LL', typeCode: 'EC35', category: 'A7', squawk: '0421' },
    path: [
      { lat: 44.9725, lon: -93.2615, alt: 1300 },
      { lat: 45.0, lon: -93.18, alt: 1500 },
      { lat: 44.9725, lon: -93.2615, alt: 1300 },
    ],
    knots: 110,
    phase: 60,
    gap: 180,
  },
  {
    plane: { id: 'a3d9b4', callsign: 'DAL2456', registration: 'N806DN', typeCode: 'B739', category: 'A3', squawk: '1000' },
    path: [
      { lat: 44.8843, lon: -93.2116, alt: 0 },
      { lat: 44.8831, lon: -93.2054, alt: 0 },
      { lat: 44.8803, lon: -93.2035, alt: 0 },
    ],
    knots: 12,
    phase: 0,
    gap: 240,
  },
];

const NM_METRES = 1852;

function distanceNm(a: Waypoint, b: Waypoint): number {
  const x = (b.lon - a.lon) * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  const y = b.lat - a.lat;
  return (Math.hypot(x, y) * 111_195) / NM_METRES;
}

function bearing(a: Waypoint, b: Waypoint): number {
  const x = (b.lon - a.lon) * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  const y = b.lat - a.lat;
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}

/** Where a flight is `t` seconds into its loop, or null while it is away. */
function fly(flight: MockFlight, t: number): Omit<Plane, 'positionAt'> | null {
  const legs = flight.path.slice(1).map((to, i) => ({ from: flight.path[i], to, nm: distanceNm(flight.path[i], to) }));
  const total = legs.reduce((sum, leg) => sum + leg.nm, 0);
  const flying = (total / flight.knots) * 3600;
  const lap = flying + (flight.gap ?? 0);
  let s = (((t + flight.phase) % lap) + lap) % lap;
  if (s > flying) return null;
  for (const leg of legs) {
    const seconds = (leg.nm / flight.knots) * 3600;
    if (s <= seconds || leg === legs[legs.length - 1]) {
      const f = seconds > 0 ? Math.min(1, s / seconds) : 1;
      const altitude = Math.round((leg.from.alt + (leg.to.alt - leg.from.alt) * f) / 25) * 25;
      return {
        ...flight.plane,
        lat: leg.from.lat + (leg.to.lat - leg.from.lat) * f,
        lon: leg.from.lon + (leg.to.lon - leg.from.lon) * f,
        altitude,
        onGround: leg.from.alt === 0 && leg.to.alt === 0,
        groundSpeed: flight.knots,
        track: Math.round(bearing(leg.from, leg.to) * 10) / 10,
        verticalRate: seconds > 0 ? Math.round(((leg.to.alt - leg.from.alt) / seconds) * 60 / 64) * 64 : 0,
      };
    }
    s -= seconds;
  }
  return null;
}

/** The demo sky at `now` (Unix seconds). */
export function mockPlanes(now = Date.now() / 1000): PlanesResponse {
  const planes: Plane[] = [];
  for (const flight of FLIGHTS) {
    const plane = fly(flight, now);
    if (plane) planes.push({ ...plane, positionAt: now });
  }
  return { planes, now, source: 'demo' };
}
