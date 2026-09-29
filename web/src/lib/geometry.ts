/**
 * Small plane geometry on [lon, lat] lines, accurate at city scale.
 *
 * Longitude degrees shrink toward the poles, so distances are measured with
 * longitude scaled by the cosine of the latitude. At the size of a bus route
 * that is indistinguishable from the real thing and needs no projection
 * library.
 */

type Point = [number, number];

/** Where along a line a point falls: which segment, and how far along it. */
export interface Projection {
  segment: number;
  /** 0 at the segment's start, 1 at its end. */
  t: number;
  point: Point;
  /** Squared distance in scaled degrees; only useful for comparisons. */
  distance: number;
}

export function projectOntoLine(line: Point[], target: Point): Projection | null {
  if (line.length === 0) return null;
  if (line.length === 1) return { segment: 0, t: 0, point: line[0], distance: squared(line[0], target, 1) };

  const scale = Math.cos((target[1] * Math.PI) / 180);
  let best: Projection | null = null;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const dx = (b[0] - a[0]) * scale;
    const dy = b[1] - a[1];
    const lengthSquared = dx * dx + dy * dy;
    let t = 0;
    if (lengthSquared > 0) {
      t = (((target[0] - a[0]) * scale) * dx + (target[1] - a[1]) * dy) / lengthSquared;
      t = Math.min(1, Math.max(0, t));
    }
    const point: Point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const distance = squared(point, target, scale);
    if (!best || distance < best.distance) best = { segment: i, t, point, distance };
  }
  return best;
}

/**
 * Cuts a line at the point nearest a position: what has been travelled, and
 * what is still ahead. The cut point belongs to both halves so they meet.
 */
export function splitLineAt(line: Point[], position: Point): { behind: Point[]; ahead: Point[] } {
  const hit = projectOntoLine(line, position);
  if (!hit || line.length < 2) return { behind: [], ahead: line };
  const behind = [...line.slice(0, hit.segment + 1), hit.point];
  const ahead = [hit.point, ...line.slice(hit.segment + 1)];
  return { behind, ahead };
}

function squared(a: Point, b: Point, scale: number): number {
  const dx = (a[0] - b[0]) * scale;
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}
