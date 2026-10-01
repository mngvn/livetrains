import type { GtfsStore } from './gtfs/store.js';

/**
 * How prominently a line belongs on the map.
 *
 * A metro network is a handful of lines riders navigate by — light rail, and
 * the bus rapid transit lines branded with their own colour — and a large mass
 * of ordinary routes that nearly always share one house colour. Drawing all of
 * them at the same weight is what makes a transit map look like spaghetti. So
 * lines are sorted into tiers, the way a printed network diagram does it:
 *
 * - `rail`: trains of any kind, always drawn boldest.
 * - `branded`: buses with their own colour (Metro Transit's A–E lines, say).
 * - `bus`: everything that wears the shared house colour.
 *
 * The house colour is found, not hardcoded: it is the most common colour, if
 * enough routes share it to be a house style rather than a coincidence. In a
 * small feed where every route is distinct, every bus counts as branded.
 */
export type LineTier = 'rail' | 'branded' | 'bus';

/** Below this many routes, a shared colour is a coincidence, not a house style. */
const HOUSE_STYLE_THRESHOLD = 4;

const RAIL_MODES = new Set(['rail', 'tram', 'metro', 'funicular', 'cable']);

const cache = new WeakMap<GtfsStore, LineTier[]>();

/** The tier of every route, by route index. */
export function lineTiers(store: GtfsStore): LineTier[] {
  const cached = cache.get(store);
  if (cached) return cached;

  const byColor = new Map<string, number>();
  for (const route of store.routes) {
    if (RAIL_MODES.has(route.mode)) continue;
    const color = route.color.toUpperCase();
    byColor.set(color, (byColor.get(color) ?? 0) + 1);
  }
  let houseColor: string | null = null;
  let houseCount = 0;
  for (const [color, count] of byColor) {
    if (count > houseCount) {
      houseColor = color;
      houseCount = count;
    }
  }
  if (houseCount < HOUSE_STYLE_THRESHOLD) houseColor = null;

  const tiers = store.routes.map((route): LineTier => {
    if (RAIL_MODES.has(route.mode)) return 'rail';
    return houseColor !== null && route.color.toUpperCase() === houseColor ? 'bus' : 'branded';
  });
  cache.set(store, tiers);
  return tiers;
}
