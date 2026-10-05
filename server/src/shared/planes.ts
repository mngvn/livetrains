/**
 * Aircraft over the map: what one is, and how to read the feeds that say so.
 *
 * Positions come from community ADS-B exchanges — adsb.lol and adsb.fi —
 * which aggregate what hobbyist receivers hear and publish it openly with no
 * key. Both speak the same "v2" JSON that readsb produces, so one reader
 * serves both. Shared by the server, which relays the feed in server mode,
 * and the browser, which reads it through a relay on a static host (neither
 * exchange sends CORS headers, so a page cannot read them directly).
 */

export interface Plane {
  /** ICAO 24-bit address in hex; a leading `~` marks a non-ICAO (TIS-B) target. */
  id: string;
  /** The flight's callsign as transmitted, trimmed: "DAL447", "N1588J". */
  callsign?: string;
  /** Tail number: "N137EV". */
  registration?: string;
  /** ICAO aircraft type designator: "CRJ9", "B738", "C172". */
  typeCode?: string;
  /** The type spelled out, when the feed knows it: "BOMBARDIER Regional Jet CRJ-900". */
  typeName?: string;
  /** Registered owner or operator, when the feed knows it. */
  owner?: string;
  /** ADS-B emitter category: A1 light … A5 heavy, A7 rotorcraft, B1 glider… */
  category?: string;
  lat: number;
  lon: number;
  /** Barometric altitude in feet; 0 on the ground; absent when not reported. */
  altitude?: number;
  onGround: boolean;
  /** Knots over the ground. */
  groundSpeed?: number;
  /** Degrees true, the direction it is moving over the ground. */
  track?: number;
  /** Feet per minute, positive climbing. */
  verticalRate?: number;
  squawk?: string;
  /** Declared emergency, when there is one: "general", "lifeguard", "nordo"… */
  emergency?: string;
  /** Unix seconds when this position was received. */
  positionAt: number;
}

/** What the server's `/api/planes` returns, and what the browser reads into. */
export interface PlanesResponse {
  planes: Plane[];
  /** Unix seconds, the feed's own clock. */
  now: number;
  /** Who the positions came from, for attribution: "adsb.lol". */
  source?: string;
}

/** A circle to ask a feed about: centre and radius in nautical miles. */
export interface PlaneArea {
  lat: number;
  lon: number;
  radiusNm: number;
}

/**
 * How far beyond the agency's box to look, in nautical miles.
 *
 * Enough that a plane is already on the map as it crosses into the area,
 * rather than popping into existence over the suburbs — about four minutes'
 * flying at approach speed.
 */
const AREA_MARGIN_NM = 15;

/** The feeds cap a point query at 250nm; a metro never needs more than this. */
const MAX_RADIUS_NM = 100;

/**
 * The circle that covers an agency's map, plus a margin: what to ask the
 * aircraft feed for. Centred on the box rather than the agency's chosen
 * centre (often downtown), so the margin is even on every side.
 */
export function planeArea(bbox: [number, number, number, number]): PlaneArea {
  const [west, south, east, north] = bbox;
  const lat = (south + north) / 2;
  const lon = (west + east) / 2;
  // A nautical mile is a minute of latitude.
  const dy = ((north - south) / 2) * 60;
  const dx = ((east - west) / 2) * 60 * Math.cos((lat * Math.PI) / 180);
  const radiusNm = Math.min(MAX_RADIUS_NM, Math.ceil(Math.hypot(dx, dy) + AREA_MARGIN_NM));
  return { lat: round(lat, 4), lon: round(lon, 4), radiusNm };
}

function round(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

/**
 * Fills a feed URL template: `{lat}`, `{lon}` and `{radius}` (nautical
 * miles), as written or URL-encoded, so a template can sit inside another
 * URL's query string.
 */
export function fillPlaneUrl(template: string, area: PlaneArea): string {
  const values: Record<string, string> = {
    lat: String(area.lat),
    lon: String(area.lon),
    radius: String(area.radiusNm),
  };
  return template.replace(/\{(lat|lon|radius)\}|%7B(lat|lon|radius)%7D/gi, (_m, plain?: string, encoded?: string) => {
    const key = (plain ?? encoded ?? '').toLowerCase();
    return values[key] ?? '';
  });
}

/**
 * Positions older than this are not worth drawing: the feed has stopped
 * hearing the aircraft, and where it was a minute ago is a guess.
 */
export const MAX_POSITION_AGE_SECONDS = 60;

const KNOT_MS = 0.514444;
const EARTH_RADIUS_M = 6_371_000;

/**
 * Where something moving at `knots` along `trackDeg` will be after
 * `seconds`. Flat-earth, which over the half-mile of a few seconds' flight
 * is exact to well under a pixel.
 */
export function deadReckon(
  lat: number,
  lon: number,
  trackDeg: number,
  knots: number,
  seconds: number,
): { lat: number; lon: number } {
  const metres = knots * KNOT_MS * seconds;
  const theta = (trackDeg * Math.PI) / 180;
  const dLat = (metres * Math.cos(theta)) / EARTH_RADIUS_M;
  const dLon = (metres * Math.sin(theta)) / (EARTH_RADIUS_M * Math.cos((lat * Math.PI) / 180));
  return { lat: lat + (dLat * 180) / Math.PI, lon: lon + (dLon * 180) / Math.PI };
}

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const text = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * Reads any of the shapes an aircraft feed arrives in into one list.
 *
 * - readsb "v2" from adsb.lol: `{ ac: [...], now: <ms> }`
 * - the same from adsb.fi: `{ aircraft: [...], now: <s> }`
 * - this app's own relay: `{ planes: [...], now: <s> }`, already read
 *
 * Anything that is not an aircraft with a recent position is left out:
 * surface vehicles and obstacles (ADS-B category C — airport service trucks,
 * radio masts), and targets the feed has not placed in the last minute.
 */
export function readPlanes(payload: unknown, receivedAt = Date.now() / 1000): PlanesResponse {
  if (!payload || typeof payload !== 'object') return { planes: [], now: receivedAt };
  const body = payload as Record<string, unknown>;

  // `now` is milliseconds from one exchange and seconds from the other.
  const rawNow = num(body.now);
  const now = rawNow === undefined ? receivedAt : rawNow > 1e11 ? rawNow / 1000 : rawNow;

  if (Array.isArray(body.planes)) {
    const planes = (body.planes as Plane[]).filter(
      (p) => p && typeof p.id === 'string' && num(p.lat) !== undefined && num(p.lon) !== undefined,
    );
    return { planes, now, source: text(body.source) };
  }

  const list = Array.isArray(body.ac) ? body.ac : Array.isArray(body.aircraft) ? body.aircraft : [];
  const planes: Plane[] = [];
  for (const entry of list) {
    const plane = readAircraft(entry, now);
    if (plane) planes.push(plane);
  }
  // A relay passing the feed through says which one it was, for the credit.
  return { planes, now, source: text(body.source) };
}

function readAircraft(entry: unknown, now: number): Plane | null {
  if (!entry || typeof entry !== 'object') return null;
  const a = entry as Record<string, unknown>;
  const id = text(a.hex)?.toLowerCase();
  const lat = num(a.lat);
  const lon = num(a.lon);
  if (!id || lat === undefined || lon === undefined) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

  const category = text(a.category)?.toUpperCase();
  if (category?.startsWith('C')) return null;

  const age = num(a.seen_pos) ?? num(a.seen) ?? 0;
  if (age > MAX_POSITION_AGE_SECONDS) return null;

  const onGround = a.alt_baro === 'ground';
  const altitude = onGround ? 0 : (num(a.alt_baro) ?? num(a.alt_geom));
  const emergency = text(a.emergency);

  return {
    id,
    callsign: text(a.flight),
    registration: text(a.r),
    typeCode: text(a.t),
    typeName: text(a.desc),
    owner: text(a.ownOp),
    category,
    lat,
    lon,
    altitude,
    onGround,
    groundSpeed: num(a.gs),
    // Track is the direction of travel; heading is where the nose points,
    // which in a crosswind is not the same thing.
    track: num(a.track) ?? num(a.true_heading) ?? num(a.mag_heading),
    verticalRate: num(a.baro_rate) ?? num(a.geom_rate),
    squawk: text(a.squawk),
    emergency: emergency && emergency !== 'none' ? emergency : undefined,
    positionAt: now - age,
  };
}
