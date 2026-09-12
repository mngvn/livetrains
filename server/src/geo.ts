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

/**
 * Ramer-Douglas-Peucker line simplification.
 *
 * Route shapes are the bulk of a GTFS feed — 15MB of the 60MB for Metro
 * Transit — because they carry survey-grade detail no map at city zoom can
 * show. Drawing the whole network raw would mean moving and rendering
 * hundreds of thousands of points to draw lines a couple of pixels wide.
 *
 * `tolerance` is in degrees; roughly 1e-5 is a metre of latitude. Points are
 * kept when dropping them would move the line by more than that.
 */
export function simplifyPath(
  points: readonly [number, number][],
  tolerance: number,
): [number, number][] {
  if (points.length <= 2) return points.slice();

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  // Iterative rather than recursive: a long shape can be tens of thousands of
  // points, deep enough to overflow the stack on a pathological input.
  const stack: [number, number][] = [[0, points.length - 1]];
  const toleranceSquared = tolerance * tolerance;

  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    if (last <= first + 1) continue;

    let furthest = -1;
    let furthestDistance = 0;
    for (let i = first + 1; i < last; i++) {
      const distance = squaredDistanceToSegment(points[i], points[first], points[last]);
      if (distance > furthestDistance) {
        furthestDistance = distance;
        furthest = i;
      }
    }

    if (furthestDistance > toleranceSquared && furthest > 0) {
      keep[furthest] = 1;
      stack.push([first, furthest], [furthest, last]);
    }
  }

  const out: [number, number][] = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) out.push(points[i]);
  }
  return out;
}

/** Squared perpendicular distance from a point to a segment, in degrees. */
function squaredDistanceToSegment(
  point: readonly [number, number],
  start: readonly [number, number],
  end: readonly [number, number],
): number {
  let x = start[0];
  let y = start[1];
  let dx = end[0] - x;
  let dy = end[1] - y;

  if (dx !== 0 || dy !== 0) {
    const t = ((point[0] - x) * dx + (point[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = end[0];
      y = end[1];
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }

  dx = point[0] - x;
  dy = point[1] - y;
  return dx * dx + dy * dy;
}
