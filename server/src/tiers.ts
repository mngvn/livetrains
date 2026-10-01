import type { GtfsStore } from './gtfs/store.js';
import { lineTier, type LineTier } from './shared/lines.js';

export type { LineTier } from './shared/lines.js';

const cache = new WeakMap<GtfsStore, LineTier[]>();

/** The tier of every route, by route index; see `shared/lines.ts`. */
export function lineTiers(store: GtfsStore): LineTier[] {
  const cached = cache.get(store);
  if (cached) return cached;
  const tiers = store.routes.map((route) => lineTier(route));
  cache.set(store, tiers);
  return tiers;
}
