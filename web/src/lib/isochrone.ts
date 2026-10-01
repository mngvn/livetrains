import type { Reachability } from './api.ts';

/**
 * Turns "these stops, this many minutes away" into shaded ground.
 *
 * From each stop reached, the rest of the budget is spent walking: a stop
 * reached in 22 minutes still covers the streets eight minutes' walk around
 * it. The ground is cut into a grid of square cells and each takes the
 * quickest way anyone could reach it, which keeps the bands clean where
 * overlapping circles would pile up into blotches — and a grid reads as a
 * map of the network's reach rather than a weather chart.
 */

/** The bands drawn, in minutes. */
export const ISOCHRONE_BANDS = [10, 20, 30] as const;

/** Side of a grid cell, in metres: about a city block. */
export const CELL_METERS = 160;

/** Nobody walks further than this from a stop to finish a trip. */
const MAX_WALK_METERS = 800;

/** Real streets are longer than straight lines; matches the planner's default. */
const CIRCUITY = 1.35;

const METERS_PER_DEGREE = 111_320;

export interface IsochroneGrid {
  cells: GeoJSON.FeatureCollection<GeoJSON.Polygon, { band: number }>;
  /** Bounds of everything shaded, for fitting the camera. */
  bounds: [number, number, number, number] | null;
}

export function isochroneGrid(reach: Reachability, cellMeters = CELL_METERS): IsochroneGrid {
  const budget = reach.minutes * 60;
  const bands = ISOCHRONE_BANDS.filter((b) => b * 60 <= budget || b === ISOCHRONE_BANDS[0]);
  const lat0 = reach.origin.lat;
  const lon0 = reach.origin.lon;
  const perLat = METERS_PER_DEGREE;
  const perLon = METERS_PER_DEGREE * Math.cos((lat0 * Math.PI) / 180);
  const speed = reach.walkSpeed > 0 ? reach.walkSpeed : 1.33;

  /** Quickest seconds to each cell, keyed "ix,iy". */
  const best = new Map<string, number>();
  for (const stop of reach.stops) {
    const remaining = budget - stop.seconds;
    if (remaining < 0) continue;
    const walk = Math.min(MAX_WALK_METERS, (remaining * speed) / CIRCUITY);
    const x = (stop.lon - lon0) * perLon;
    const y = (stop.lat - lat0) * perLat;
    const cx = Math.floor(x / cellMeters);
    const cy = Math.floor(y / cellMeters);
    const reachCells = Math.ceil(walk / cellMeters) + 1;
    for (let ix = cx - reachCells; ix <= cx + reachCells; ix++) {
      for (let iy = cy - reachCells; iy <= cy + reachCells; iy++) {
        const dx = (ix + 0.5) * cellMeters - x;
        const dy = (iy + 0.5) * cellMeters - y;
        const distance = Math.hypot(dx, dy);
        if (distance > walk) continue;
        const seconds = stop.seconds + (distance * CIRCUITY) / speed;
        const key = `${ix},${iy}`;
        const current = best.get(key);
        if (current === undefined || seconds < current) best.set(key, seconds);
      }
    }
  }

  // Band each cell, then merge runs of the same band along a row into one
  // rectangle: a tenth of the features for the same picture.
  const rows = new Map<number, { ix: number; band: number }[]>();
  for (const [key, seconds] of best) {
    const band = bands.find((b) => seconds <= b * 60);
    if (band === undefined) continue;
    const [ix, iy] = key.split(',').map(Number);
    const row = rows.get(iy);
    if (row) row.push({ ix, band });
    else rows.set(iy, [{ ix, band }]);
  }

  const features: GeoJSON.Feature<GeoJSON.Polygon, { band: number }>[] = [];
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const toLon = (ix: number) => lon0 + (ix * cellMeters) / perLon;
  const toLat = (iy: number) => lat0 + (iy * cellMeters) / perLat;

  for (const [iy, cells] of rows) {
    cells.sort((a, b) => a.ix - b.ix);
    let start = 0;
    for (let i = 1; i <= cells.length; i++) {
      const runEnds =
        i === cells.length || cells[i].band !== cells[start].band || cells[i].ix !== cells[i - 1].ix + 1;
      if (!runEnds) continue;
      const w = toLon(cells[start].ix);
      const e = toLon(cells[i - 1].ix + 1);
      const s = toLat(iy);
      const n = toLat(iy + 1);
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
        properties: { band: cells[start].band },
      });
      west = Math.min(west, w);
      east = Math.max(east, e);
      south = Math.min(south, s);
      north = Math.max(north, n);
      start = i;
    }
  }

  return {
    cells: { type: 'FeatureCollection', features },
    bounds: features.length > 0 ? [west, south, east, north] : null,
  };
}
