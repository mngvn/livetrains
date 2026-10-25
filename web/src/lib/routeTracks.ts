import type { RouteNetwork } from './api.ts';

/**
 * Keeps vehicles on their lines between reports.
 *
 * A vehicle glides from where it is drawn to where it last reported. Drawn as
 * a straight line, that glide cuts every corner on the way, and the longer a
 * feed lags the more of the street grid it cuts across, until a bus is seen
 * sailing over a block of houses to catch up. Run along the route's own drawn
 * line instead, it turns where the street turns.
 *
 * The lines are the network underlay's, one per route and direction, and a
 * selected or ridden vehicle's own trip when it is known. A report further than
 * SNAP_METRES from all of them (a detour, or a branch the underlay does not
 * draw) has no line to follow, and the glide runs straight as it always did.
 *
 * Flat-earth geometry, with longitude scaled by the cosine of the latitude:
 * at the size of a city, indistinguishable from the real thing.
 */

type Point = [number, number];

/**
 * How far from its line a position may be and still be held to it. GPS noise
 * and the underlay's simplification are each worth ten or twenty metres;
 * a block over is a different street.
 */
export const SNAP_METRES = 60;

/**
 * Going back along a line costs this much extra, and twice the distance.
 * Vehicles run forwards: a way along the line that has to reverse is only
 * taken when nothing better fits, which leaves it to GPS jitter at a stop.
 */
const BACKTRACK_METRES = 40;

/**
 * The longest way round accepted, as a multiple of the straight distance
 * plus a margin. Round a block is about three sides to one; anything far
 * longer means the two ends were matched to the wrong parts of the line,
 * and a straight glide is the lesser evil.
 */
const DETOUR_RATIO = 3;
const DETOUR_MARGIN_METRES = 300;

const METRES_PER_DEGREE = 111_320;

export interface TrackLine {
  points: Point[];
  /** Metres from the line's start to each point. */
  along: number[];
  /** Metres per degree of longitude, at the line's latitude. */
  xScale: number;
  /** [west, south, east, north], widened by SNAP_METRES, to skip lines that are nowhere near. */
  bounds: [number, number, number, number];
}

/** The nearest place on one pass of a line. */
interface Hit {
  segment: number;
  /** Metres along the line. */
  along: number;
  /** Metres from the line. */
  offset: number;
  point: Point;
}

function xScaleAt(lat: number): number {
  return METRES_PER_DEGREE * Math.cos((lat * Math.PI) / 180);
}

/** Straight-line metres between two points. */
export function metresBetween(a: Point, b: Point): number {
  return Math.hypot((b[0] - a[0]) * xScaleAt((a[1] + b[1]) / 2), (b[1] - a[1]) * METRES_PER_DEGREE);
}

/** Degrees clockwise from north, from one point to another; null when they coincide. */
export function headingBetween(a: Point, b: Point): number | null {
  const x = (b[0] - a[0]) * xScaleAt((a[1] + b[1]) / 2);
  const y = (b[1] - a[1]) * METRES_PER_DEGREE;
  if (x === 0 && y === 0) return null;
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}

/** Prepares a line for snapping to, or null when it is too short to be one. */
export function trackLine(points: Point[]): TrackLine | null {
  if (points.length < 2) return null;
  const xScale = xScaleAt(points.reduce((sum, p) => sum + p[1], 0) / points.length);
  const along = [0];
  let [west, south, east, north] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < points.length; i++) {
    const [lon, lat] = points[i];
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
    if (i > 0) {
      const prev = points[i - 1];
      along.push(along[i - 1] + Math.hypot((lon - prev[0]) * xScale, (lat - prev[1]) * METRES_PER_DEGREE));
    }
  }
  const padLat = SNAP_METRES / METRES_PER_DEGREE;
  const padLon = SNAP_METRES / xScale;
  return { points, along, xScale, bounds: [west - padLon, south - padLat, east + padLon, north + padLat] };
}

/** Every route's lines from the network underlay, by route id. */
export function routeLines(network: RouteNetwork): Map<string, TrackLine[]> {
  const byRoute = new Map<string, TrackLine[]>();
  for (const feature of network.features) {
    const line = trackLine(feature.geometry.coordinates);
    if (!line) continue;
    const routeId = feature.properties.routeId;
    const lines = byRoute.get(routeId);
    if (lines) lines.push(line);
    else byRoute.set(routeId, [line]);
  }
  return byRoute;
}

/**
 * The nearest place on each pass a line makes within SNAP_METRES of a point.
 *
 * A line can come by the same spot more than once (out along a street and
 * back down it, or round a terminal loop) and which pass a vehicle is on
 * depends on where it came from, so every pass is kept, not only the nearest.
 */
function passesNear(line: TrackLine, target: Point): Hit[] {
  const [west, south, east, north] = line.bounds;
  if (target[0] < west || target[0] > east || target[1] < south || target[1] > north) return [];

  const { points, along, xScale } = line;
  const hits: Hit[] = [];
  let pass: Hit | null = null;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = (b[0] - a[0]) * xScale;
    const dy = (b[1] - a[1]) * METRES_PER_DEGREE;
    const px = (target[0] - a[0]) * xScale;
    const py = (target[1] - a[1]) * METRES_PER_DEGREE;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared > 0 ? Math.min(1, Math.max(0, (px * dx + py * dy) / lengthSquared)) : 0;
    const offset = Math.hypot(px - dx * t, py - dy * t);
    if (offset > SNAP_METRES) {
      if (pass) hits.push(pass);
      pass = null;
      continue;
    }
    if (!pass || offset < pass.offset) {
      pass = {
        segment: i,
        along: along[i] + (along[i + 1] - along[i]) * t,
        offset,
        point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
      };
    }
  }
  if (pass) hits.push(pass);
  return hits;
}

/** The stretch of a line between two places on it, in the order travelled. */
function stretch(line: TrackLine, from: Hit, to: Hit): Point[] {
  const out: Point[] = [from.point];
  if (to.along >= from.along) {
    for (let i = from.segment + 1; i <= to.segment; i++) out.push(line.points[i]);
  } else {
    for (let i = from.segment; i > to.segment; i--) out.push(line.points[i]);
  }
  out.push(to.point);
  return out;
}

/**
 * The way along the lines from one point to another, from the nearest place
 * on the line to each, in the order travelled. Null when no line passes near
 * both, or the only way round is implausibly long.
 */
export function followLines(lines: readonly TrackLine[], from: Point, to: Point): Point[] | null {
  let best: { score: number; line: TrackLine; a: Hit; b: Hit } | null = null;
  for (const line of lines) {
    const ends = passesNear(line, to);
    if (ends.length === 0) continue;
    const starts = passesNear(line, from);
    for (const a of starts) {
      for (const b of ends) {
        const distance = Math.abs(b.along - a.along);
        const travel = b.along >= a.along ? distance : distance * 2 + BACKTRACK_METRES;
        // Nearer the line is likelier the right line, where two run close.
        const score = travel + (a.offset + b.offset) * 2;
        if (!best || score < best.score) best = { score, line, a, b };
      }
    }
  }
  if (!best) return null;
  const distance = Math.abs(best.b.along - best.a.along);
  if (distance > metresBetween(from, to) * DETOUR_RATIO + DETOUR_MARGIN_METRES) return null;
  return stretch(best.line, best.a, best.b);
}

/** The nearest place on any of the lines, or null when none is within SNAP_METRES. */
export function snapToLines(lines: readonly TrackLine[], point: Point): Point | null {
  let best: Hit | null = null;
  for (const line of lines) {
    for (const hit of passesNear(line, point)) {
      if (!best || hit.offset < best.offset) best = hit;
    }
  }
  return best?.point ?? null;
}
