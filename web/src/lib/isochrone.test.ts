import { describe, expect, it } from 'vitest';
import type { Reachability } from './api.ts';
import { isochroneGrid } from './isochrone.ts';

const ORIGIN = { id: 'A', code: 'A', name: 'Origin', lat: 44.97, lon: -93.27 };

function reach(stops: Reachability['stops'], minutes = 30): Reachability {
  return { origin: ORIGIN, departAt: 0, minutes, walkSpeed: 1.33, stops };
}

/** The band of the cell containing a point, if it is shaded at all. */
function bandAt(grid: ReturnType<typeof isochroneGrid>, lon: number, lat: number): number | null {
  for (const feature of grid.cells.features) {
    const ring = feature.geometry.coordinates[0];
    const [w, s] = ring[0];
    const [e, n] = ring[2];
    if (lon >= w && lon < e && lat >= s && lat < n) return feature.properties.band;
  }
  return null;
}

describe('isochroneGrid', () => {
  it('shades the walk around the starting stop in the first band', () => {
    const grid = isochroneGrid(reach([{ id: 'A', lat: ORIGIN.lat, lon: ORIGIN.lon, seconds: 0 }]));
    expect(bandAt(grid, ORIGIN.lon, ORIGIN.lat)).toBe(10);
    // Two kilometres away is beyond any walk from a single stop.
    expect(bandAt(grid, ORIGIN.lon, ORIGIN.lat + 0.018)).toBeNull();
  });

  it('puts a stop reached later in a later band', () => {
    const far = { id: 'B', lat: 45.02, lon: -93.2, seconds: 15 * 60 };
    const grid = isochroneGrid(reach([{ id: 'A', lat: ORIGIN.lat, lon: ORIGIN.lon, seconds: 0 }, far]));
    expect(bandAt(grid, far.lon, far.lat)).toBe(20);
  });

  it('takes the quickest way to a cell when walks overlap', () => {
    const slow = { id: 'B', lat: ORIGIN.lat, lon: ORIGIN.lon, seconds: 25 * 60 };
    const quick = { id: 'C', lat: ORIGIN.lat, lon: ORIGIN.lon, seconds: 2 * 60 };
    expect(bandAt(isochroneGrid(reach([slow, quick])), ORIGIN.lon, ORIGIN.lat)).toBe(10);
  });

  it('merges a row of same-band cells into one rectangle', () => {
    const grid = isochroneGrid(reach([{ id: 'A', lat: ORIGIN.lat, lon: ORIGIN.lon, seconds: 0 }]));
    const rows = new Set(grid.cells.features.map((f) => f.geometry.coordinates[0][0][1].toFixed(6)));
    // At most a couple of runs per row: the 10-minute core and the 20-minute rim either side.
    expect(grid.cells.features.length).toBeLessThanOrEqual(rows.size * 3);
    expect(grid.bounds).not.toBeNull();
  });
});
