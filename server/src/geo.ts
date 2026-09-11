/** Small geodesy helpers. Distances are metres, angles degrees. */

const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;

/** Great-circle distance between two WGS84 points, in metres. */
export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Fast planar distance, accurate enough within a metro area.
 *
 * Used in the inner loops of nearby-stop search and footpath generation, where
 * a sub-metre error over a few kilometres is irrelevant but the cost of three
 * trig calls per candidate is not.
 */
export function approxMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
  cosLat: number = Math.cos(((lat1 + lat2) / 2) * DEG),
): number {
  const x = (lon2 - lon1) * DEG * cosLat;
  const y = (lat2 - lat1) * DEG;
  return Math.sqrt(x * x + y * y) * EARTH_RADIUS_M;
}

/** Degrees of longitude spanning `meters` at a given latitude. */
export function lonDegreesFor(meters: number, lat: number): number {
  const metersPerDegree = (EARTH_RADIUS_M * DEG) * Math.cos(lat * DEG);
  return metersPerDegree <= 0 ? 180 : meters / metersPerDegree;
}

/** Degrees of latitude spanning `meters`. */
export function latDegreesFor(meters: number): number {
  return meters / (EARTH_RADIUS_M * DEG);
}

/** Initial bearing from point 1 to point 2, in degrees clockwise from north. */
export function bearingDegrees(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLon = (lon2 - lon1) * DEG;
  const y = Math.sin(dLon) * Math.cos(lat2 * DEG);
  const x =
    Math.cos(lat1 * DEG) * Math.sin(lat2 * DEG) -
    Math.sin(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.cos(dLon);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}
