import { describe, expect, it } from 'vitest';
import { simplifyPath, haversineMeters, bearingDegrees } from './geo.js';

describe('simplifyPath', () => {
  it('keeps the endpoints', () => {
    const line: [number, number][] = [
      [-93.3, 44.9],
      [-93.2, 44.95],
      [-93.1, 44.9],
    ];
    const out = simplifyPath(line, 0.01);
    expect(out[0]).toEqual(line[0]);
    expect(out[out.length - 1]).toEqual(line[2]);
  });

  it('drops points that lie along a straight line', () => {
    const straight: [number, number][] = Array.from({ length: 50 }, (_, i) => [
      -93.3 + i * 0.001,
      44.9,
    ]);
    expect(simplifyPath(straight, 1e-6)).toHaveLength(2);
  });

  it('keeps a corner that a straight line would cut', () => {
    const corner: [number, number][] = [
      [-93.3, 44.9],
      [-93.2, 44.9],
      [-93.2, 45.0],
    ];
    expect(simplifyPath(corner, 1e-5)).toHaveLength(3);
  });

  it('never moves the line further than the tolerance', () => {
    // A jagged path whose wobble is far below the tolerance.
    const jagged: [number, number][] = Array.from({ length: 400 }, (_, i) => [
      -93.3 + i * 0.0005,
      44.9 + (i % 2 === 0 ? 0.000_002 : -0.000_002),
    ]);
    const tolerance = 1e-4;
    const simplified = simplifyPath(jagged, tolerance);
    expect(simplified.length).toBeLessThan(10);

    // The guarantee is about distance to the simplified *line*, not to its
    // vertices — a dropped point halfway along a kept segment is still exactly
    // on the line.
    for (const point of jagged) {
      expect(distanceToPolyline(point, simplified)).toBeLessThanOrEqual(tolerance);
    }
  });

  it('leaves short paths alone', () => {
    expect(simplifyPath([], 0.01)).toEqual([]);
    const two: [number, number][] = [
      [-93.3, 44.9],
      [-93.2, 44.9],
    ];
    expect(simplifyPath(two, 0.01)).toEqual(two);
  });

  it('cuts a realistic route shape down substantially', () => {
    // A gently curving corridor sampled every few metres, as GTFS shapes are.
    const shape: [number, number][] = Array.from({ length: 2000 }, (_, i) => {
      const t = i / 2000;
      return [-93.3 + t * 0.2, 44.9 + Math.sin(t * Math.PI) * 0.05] as [number, number];
    });
    // ~1e-4 degrees is roughly 11 metres, finer than a line is wide on screen.
    const simplified = simplifyPath(shape, 1e-4);
    expect(simplified.length).toBeLessThan(shape.length / 10);
    expect(simplified.length).toBeGreaterThan(2);
  });
});

/** Perpendicular distance from a point to the nearest segment of a polyline. */
function distanceToPolyline(point: [number, number], line: [number, number][]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1];
    const [bx, by] = line[i];
    const dx = bx - ax;
    const dy = by - ay;
    let t = 0;
    if (dx !== 0 || dy !== 0) {
      t = Math.max(0, Math.min(1, ((point[0] - ax) * dx + (point[1] - ay) * dy) / (dx * dx + dy * dy)));
    }
    best = Math.min(best, Math.hypot(point[0] - (ax + dx * t), point[1] - (ay + dy * t)));
  }
  return best;
}

describe('bearingDegrees', () => {
  it('reports compass bearings', () => {
    expect(bearingDegrees(44.9, -93.2, 45.0, -93.2)).toBeCloseTo(0, 0); // north
    expect(bearingDegrees(44.9, -93.2, 44.9, -93.1)).toBeCloseTo(90, 0); // east
    expect(bearingDegrees(45.0, -93.2, 44.9, -93.2)).toBeCloseTo(180, 0); // south
    expect(bearingDegrees(44.9, -93.1, 44.9, -93.2)).toBeCloseTo(270, 0); // west
  });
});

describe('haversineMeters', () => {
  it('measures a known distance', () => {
    // Downtown Minneapolis to downtown St Paul is about 14 km.
    const metres = haversineMeters(44.9778, -93.265, 44.9537, -93.09);
    expect(metres).toBeGreaterThan(13_000);
    expect(metres).toBeLessThan(15_000);
  });
});
