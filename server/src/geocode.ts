import type { Place } from './shared/api.js';
import type { GtfsStore } from './gtfs/store.js';
import { haversineMeters } from './geo.js';
import { log } from './log.js';

/**
 * Destination search.
 *
 * Runs entirely against the loaded feed by default — every transit stop and
 * station is searchable, plus a small list of landmarks — so the app needs no
 * geocoding key and no third-party account to be useful. An optional Nominatim
 * backend adds free-text address search for operators who want it and accept
 * its usage policy.
 */

interface Landmark {
  name: string;
  detail: string;
  lat: number;
  lon: number;
  /** Agency ids this landmark belongs to; empty means "any". */
  agencies?: string[];
}

/**
 * Places riders search for that are not themselves transit stops.
 *
 * Deliberately short: the stop list already covers most of what people type,
 * and a long hand-maintained gazetteer would rot. Anything missing is handled
 * by the optional address backend or by dropping a pin on the map.
 */
const LANDMARKS: Landmark[] = [
  { name: 'Mall of America', detail: 'Bloomington', lat: 44.8549, lon: -93.2422, agencies: ['metro-transit'] },
  { name: 'MSP Airport Terminal 1', detail: 'Lindbergh Terminal', lat: 44.8819, lon: -93.2064, agencies: ['metro-transit'] },
  { name: 'MSP Airport Terminal 2', detail: 'Humphrey Terminal', lat: 44.8742, lon: -93.2243, agencies: ['metro-transit'] },
  { name: 'University of Minnesota', detail: 'East Bank campus', lat: 44.9740, lon: -93.2277, agencies: ['metro-transit'] },
  { name: 'Target Center', detail: 'Downtown Minneapolis', lat: 44.9795, lon: -93.2761, agencies: ['metro-transit'] },
  { name: 'Target Field', detail: 'Downtown Minneapolis', lat: 44.9817, lon: -93.2777, agencies: ['metro-transit'] },
  { name: 'U.S. Bank Stadium', detail: 'Downtown Minneapolis', lat: 44.9736, lon: -93.2575, agencies: ['metro-transit'] },
  { name: 'Minnesota State Capitol', detail: 'St Paul', lat: 44.9553, lon: -93.1022, agencies: ['metro-transit'] },
  { name: 'Xcel Energy Center', detail: 'Downtown St Paul', lat: 44.9448, lon: -93.1013, agencies: ['metro-transit'] },
  { name: 'Minneapolis Institute of Art', detail: 'Whittier', lat: 44.9583, lon: -93.2736, agencies: ['metro-transit'] },
  { name: 'Walker Art Center', detail: 'Loring Park', lat: 44.9683, lon: -93.2887, agencies: ['metro-transit'] },
  { name: 'Minnehaha Falls', detail: 'Minnehaha Regional Park', lat: 44.9153, lon: -93.2111, agencies: ['metro-transit'] },
  { name: 'Como Park Zoo', detail: 'St Paul', lat: 44.9803, lon: -93.1521, agencies: ['metro-transit'] },
  { name: 'Minnesota Zoo', detail: 'Apple Valley', lat: 44.7683, lon: -93.1953, agencies: ['metro-transit'] },
  { name: 'Union Depot', detail: 'Lowertown, St Paul', lat: 44.9479, lon: -93.0855, agencies: ['metro-transit'] },
];

/** Normalises a query for comparison: lowercase, no punctuation or extra space. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Scores how well a candidate name matches a query. Higher is better; 0 means
 * no match.
 *
 * Favours prefix matches over "contains", and whole-word matches over partial,
 * so typing "lake" surfaces "Lake Street Station" ahead of "Snelling Ave &
 * Lakeview Ter".
 */
function score(query: string, name: string): number {
  const haystack = normalise(name);
  if (haystack === query) return 1000;
  if (haystack.startsWith(query)) return 800 - haystack.length;

  const words = haystack.split(' ');
  if (words.some((word) => word === query)) return 600;
  if (words.some((word) => word.startsWith(query))) return 500 - haystack.length;
  if (haystack.includes(query)) return 300 - haystack.length;

  // All query terms present somewhere, in any order ("snelling university").
  const terms = query.split(' ').filter(Boolean);
  if (terms.length > 1 && terms.every((term) => haystack.includes(term))) return 400 - haystack.length;

  return 0;
}

/** Parses a raw "44.9778, -93.265" coordinate pair, if that is what was typed. */
export function parseCoordinates(query: string): Place | null {
  const match = query.trim().match(/^(-?\d{1,3}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return {
    id: `${lat},${lon}`,
    name: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
    detail: 'Coordinates',
    lat,
    lon,
    kind: 'coordinate',
  };
}

export interface GeocodeOptions {
  limit?: number;
  /** Bias results toward this point, when the client knows where the user is. */
  nearLat?: number;
  nearLon?: number;
  agencyId?: string;
}

export class Geocoder {
  constructor(
    private readonly store: GtfsStore,
    private readonly agencyId: string,
    /** Optional Nominatim base URL; address search is disabled when unset. */
    private readonly nominatimUrl?: string,
  ) {}

  /** Searches stops and landmarks. Synchronous and allocation-light. */
  searchLocal(query: string, options: GeocodeOptions = {}): Place[] {
    const limit = options.limit ?? 8;
    const coordinate = parseCoordinates(query);
    if (coordinate) return [coordinate];

    const needle = normalise(query);
    if (needle.length < 2) return [];

    const results: { place: Place; score: number }[] = [];

    for (const landmark of LANDMARKS) {
      if (landmark.agencies && !landmark.agencies.includes(this.agencyId)) continue;
      const value = score(needle, landmark.name);
      if (value > 0) {
        results.push({
          place: {
            id: `landmark:${landmark.name}`,
            name: landmark.name,
            detail: landmark.detail,
            lat: landmark.lat,
            lon: landmark.lon,
            kind: 'landmark',
          },
          // Landmarks outrank same-scoring stops: someone typing "Target Field"
          // means the ballpark, not one particular bus pole outside it.
          score: value + 50,
        });
      }
    }

    // Collapse stops that share a name (the two sides of a street) into one
    // result, keeping whichever is closest to the bias point.
    const byName = new Map<string, { place: Place; score: number }>();
    for (let i = 0; i < this.store.stops.length; i++) {
      const stop = this.store.stops[i];
      const value = score(needle, stop.name);
      if (value <= 0) continue;

      const place: Place = {
        id: stop.id,
        name: stop.name,
        detail: `Stop ${stop.code}`,
        lat: stop.lat,
        lon: stop.lon,
        kind: 'stop',
      };
      const existing = byName.get(stop.name);
      if (!existing) {
        byName.set(stop.name, { place, score: value });
      } else if (options.nearLat !== undefined && options.nearLon !== undefined) {
        const current = haversineMeters(options.nearLat, options.nearLon, existing.place.lat, existing.place.lon);
        const candidate = haversineMeters(options.nearLat, options.nearLon, stop.lat, stop.lon);
        if (candidate < current) byName.set(stop.name, { place, score: value });
      }
    }
    results.push(...byName.values());

    const biased = options.nearLat !== undefined && options.nearLon !== undefined;
    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (!biased) return a.place.name.localeCompare(b.place.name);
      // Equal textual relevance: prefer whatever is nearer the rider.
      return (
        haversineMeters(options.nearLat!, options.nearLon!, a.place.lat, a.place.lon) -
        haversineMeters(options.nearLat!, options.nearLon!, b.place.lat, b.place.lon)
      );
    });

    return results.slice(0, limit).map((r) => r.place);
  }

  /**
   * Local results, topped up with addresses when an address backend is set.
   *
   * Local matches always come first: a rider typing a stop name wants that
   * stop, and the local index is instant where a network call is not.
   */
  async search(query: string, options: GeocodeOptions = {}): Promise<Place[]> {
    const limit = options.limit ?? 8;
    const local = this.searchLocal(query, options);
    if (!this.nominatimUrl || local.length >= limit || parseCoordinates(query)) return local;

    try {
      const url = new URL('/search', this.nominatimUrl);
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'jsonv2');
      url.searchParams.set('limit', String(limit - local.length));
      url.searchParams.set('addressdetails', '0');
      if (options.nearLat !== undefined && options.nearLon !== undefined) {
        // A viewbox around the rider keeps "3rd st" local rather than global.
        const pad = 0.5;
        url.searchParams.set(
          'viewbox',
          [options.nearLon - pad, options.nearLat + pad, options.nearLon + pad, options.nearLat - pad].join(','),
        );
      }

      const response = await fetch(url, {
        headers: { 'user-agent': 'livetrains/0.1 (transit trip planner)' },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const payload = (await response.json()) as {
        place_id?: number;
        lat: string;
        lon: string;
        name?: string;
        display_name: string;
      }[];

      const addresses: Place[] = payload.map((item) => {
        const parts = item.display_name.split(',').map((p) => p.trim());
        return {
          id: `osm:${item.place_id ?? `${item.lat},${item.lon}`}`,
          name: item.name || parts[0],
          detail: parts.slice(1, 4).join(', '),
          lat: Number(item.lat),
          lon: Number(item.lon),
          kind: 'address' as const,
        };
      });
      return [...local, ...addresses].slice(0, limit);
    } catch (err) {
      // Address search is a bonus; never fail the whole query over it.
      log.warn(`geocode: address lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      return local;
    }
  }

  /** The nearest named place to a point, for labelling map clicks and GPS. */
  reverse(lat: number, lon: number): Place {
    const near = this.store.nearbyStops(lat, lon, 400, 1);
    if (near.length > 0) {
      const stop = this.store.stops[near[0].index];
      return {
        id: `${lat},${lon}`,
        name: `Near ${stop.name}`,
        detail: `${Math.round(near[0].distance)} m from stop ${stop.code}`,
        lat,
        lon,
        kind: 'coordinate',
      };
    }
    return {
      id: `${lat},${lon}`,
      name: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
      detail: 'Dropped pin',
      lat,
      lon,
      kind: 'coordinate',
    };
  }
}
