import type { Plane } from '@shared/planes.ts';
import type { Airport } from './planeLookup.ts';

/**
 * Where a plane is going, as well as anyone on the ground can tell.
 *
 * Three answers, from most to least certain:
 *
 * - `destination`: its published route, when the route database has one and
 *   the plane is actually on it.
 * - `landing`: no route (most small planes have none), but it is low,
 *   descending and pointed at an airport a few miles ahead.
 * - `toward`: neither, so the direction it is flying and the city that lies
 *   that way — "west, towards Fargo".
 */

export interface BoundPlace {
  code: string;
  /** "Flying Cloud", "Fargo". */
  name: string;
  lat: number;
  lon: number;
}

export interface Bound {
  kind: 'destination' | 'landing' | 'toward';
  place: BoundPlace;
  /** Straight-line distance, statute miles. */
  miles: number;
  /** At its current ground speed; null when it is not moving. */
  minutes: number | null;
}

/** Airports a small plane over the Twin Cities is likely to be landing at. */
const LOCAL_AIRPORTS: BoundPlace[] = [
  { code: 'MSP', name: 'Minneapolis–St Paul', lat: 44.882, lon: -93.2218 },
  { code: 'STP', name: 'St Paul Downtown', lat: 44.9345, lon: -93.06 },
  { code: 'FCM', name: 'Flying Cloud', lat: 44.8272, lon: -93.4571 },
  { code: 'ANE', name: 'Anoka County–Blaine', lat: 45.145, lon: -93.211 },
  { code: 'MIC', name: 'Crystal', lat: 45.062, lon: -93.354 },
  { code: '21D', name: 'Lake Elmo', lat: 44.9975, lon: -92.8557 },
  { code: 'SGS', name: 'South St Paul', lat: 44.8571, lon: -93.0329 },
  { code: 'LVN', name: 'Airlake', lat: 44.6279, lon: -93.2281 },
];

/** Cities a plane leaving the area might be heading for, by their main airport. */
const CITIES: BoundPlace[] = [
  { code: 'STC', name: 'St Cloud', lat: 45.5466, lon: -94.0599 },
  { code: 'RST', name: 'Rochester', lat: 43.908, lon: -92.5 },
  { code: 'DLH', name: 'Duluth', lat: 46.842, lon: -92.194 },
  { code: 'EAU', name: 'Eau Claire', lat: 44.8658, lon: -91.4843 },
  { code: 'LSE', name: 'La Crosse', lat: 43.879, lon: -91.2567 },
  { code: 'FAR', name: 'Fargo', lat: 46.92, lon: -96.8158 },
  { code: 'FSD', name: 'Sioux Falls', lat: 43.582, lon: -96.742 },
  { code: 'DSM', name: 'Des Moines', lat: 41.534, lon: -93.663 },
  { code: 'MSN', name: 'Madison', lat: 43.1399, lon: -89.3375 },
  { code: 'GRB', name: 'Green Bay', lat: 44.485, lon: -88.13 },
  { code: 'MKE', name: 'Milwaukee', lat: 42.947, lon: -87.8966 },
  { code: 'ORD', name: 'Chicago', lat: 41.9786, lon: -87.9048 },
  { code: 'BIS', name: 'Bismarck', lat: 46.7727, lon: -100.746 },
  { code: 'YWG', name: 'Winnipeg', lat: 49.91, lon: -97.24 },
  { code: 'OMA', name: 'Omaha', lat: 41.303, lon: -95.894 },
  { code: 'MCI', name: 'Kansas City', lat: 39.2976, lon: -94.7139 },
  { code: 'STL', name: 'St Louis', lat: 38.7487, lon: -90.37 },
  { code: 'DTW', name: 'Detroit', lat: 42.2124, lon: -83.3534 },
  { code: 'YYZ', name: 'Toronto', lat: 43.6777, lon: -79.6248 },
  { code: 'DEN', name: 'Denver', lat: 39.8617, lon: -104.673 },
  { code: 'YYC', name: 'Calgary', lat: 51.1139, lon: -114.02 },
  { code: 'SLC', name: 'Salt Lake City', lat: 40.7884, lon: -111.978 },
  { code: 'SEA', name: 'Seattle', lat: 47.449, lon: -122.309 },
  { code: 'PDX', name: 'Portland', lat: 45.5887, lon: -122.5975 },
  { code: 'SFO', name: 'San Francisco', lat: 37.619, lon: -122.375 },
  { code: 'LAS', name: 'Las Vegas', lat: 36.084, lon: -115.1537 },
  { code: 'LAX', name: 'Los Angeles', lat: 33.9425, lon: -118.408 },
  { code: 'PHX', name: 'Phoenix', lat: 33.4343, lon: -112.012 },
  { code: 'DFW', name: 'Dallas', lat: 32.8968, lon: -97.038 },
  { code: 'IAH', name: 'Houston', lat: 29.9844, lon: -95.3414 },
  { code: 'ATL', name: 'Atlanta', lat: 33.6367, lon: -84.4281 },
  { code: 'MCO', name: 'Orlando', lat: 28.4294, lon: -81.309 },
  { code: 'MIA', name: 'Miami', lat: 25.7959, lon: -80.287 },
  { code: 'DCA', name: 'Washington', lat: 38.8521, lon: -77.0377 },
  { code: 'JFK', name: 'New York', lat: 40.6398, lon: -73.7789 },
  { code: 'BOS', name: 'Boston', lat: 42.3656, lon: -71.0096 },
];

const EARTH_KM = 6371;
const KM_PER_MILE = 1.609344;
const rad = Math.PI / 180;

export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial great-circle bearing from a to b, degrees clockwise from north. */
export function bearingTo(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
  const x =
    Math.cos(a.lat * rad) * Math.sin(b.lat * rad) -
    Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

const offTrack = (track: number, bearing: number) => Math.abs(((bearing - track + 540) % 360) - 180);

/**
 * The great circle from a to b as [lon, lat] points: how a plane actually
 * flies, and why a line to Atlanta leaves the Twin Cities heading south-east
 * rather than along the straight line a flat map would draw.
 */
export function greatCircle(a: { lat: number; lon: number }, b: { lat: number; lon: number }, steps = 64): [number, number][] {
  const d = distanceKm(a, b) / EARTH_KM;
  if (d < 1e-6) return [[a.lon, a.lat], [b.lon, b.lat]];
  const [la1, lo1, la2, lo2] = [a.lat * rad, a.lon * rad, b.lat * rad, b.lon * rad];
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
    const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
    const z = A * Math.sin(la1) + B * Math.sin(la2);
    out.push([Math.atan2(y, x) / rad, Math.atan2(z, Math.hypot(x, y)) / rad]);
  }
  return out;
}

function bound(kind: Bound['kind'], plane: Plane, place: BoundPlace): Bound {
  const km = distanceKm(plane, place);
  const kmh = (plane.groundSpeed ?? 0) * 1.852;
  return { kind, place, miles: km / KM_PER_MILE, minutes: kmh > 20 ? (km / kmh) * 60 : null };
}

export function whereBound(
  plane: Plane,
  route: { destination: Airport } | null,
): Bound | null {
  if (route) {
    const d = route.destination;
    return bound('destination', plane, { code: d.iata, name: d.city || d.name, lat: d.lat, lon: d.lon });
  }
  if (plane.onGround || plane.track === undefined || (plane.groundSpeed ?? 0) < 30) return null;
  const track = plane.track;

  // Low, descending and lined up with an airport a few miles on: landing.
  if ((plane.verticalRate ?? 0) < -200 && (plane.altitude ?? Infinity) < 5000) {
    const landing = LOCAL_AIRPORTS.map((a) => ({ a, km: distanceKm(plane, a), off: offTrack(track, bearingTo(plane, a)) }))
      .filter(({ km, off }) => km < 30 && (off < 20 || km < 3))
      .sort((x, y) => x.km - y.km)[0];
    if (landing) return bound('landing', plane, landing.a);
  }

  // Otherwise the nearest notable city that lies along its heading.
  const ahead = CITIES.map((c) => ({ c, km: distanceKm(plane, c), off: offTrack(track, bearingTo(plane, c)) }))
    .filter(({ km, off }) => km > 40 && km < 2500 && off < 12)
    .sort((x, y) => x.km * (1 + x.off / 12) - y.km * (1 + y.off / 12))[0];
  return ahead ? bound('toward', plane, ahead.c) : null;
}

/** "about 25 min", "about 2 hr 10 min". */
export function flyingTime(minutes: number): string {
  const m = Math.max(1, Math.round(minutes / (minutes > 60 ? 5 : 1)) * (minutes > 60 ? 5 : 1));
  if (m < 60) return `about ${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `about ${h} hr` : `about ${h} hr ${rest} min`;
}
