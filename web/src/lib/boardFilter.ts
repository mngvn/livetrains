import type { Departure, Mode } from './api.ts';

/**
 * Narrowing a stop's departure board to what the rider is actually waiting
 * for: particular routes ("just the 3"), a kind of vehicle ("trains only"),
 * or both.
 *
 * Remembered per stop. Someone who only ever takes the 3 from their corner
 * wants the board pinned to the 3 every time they open that corner, and a
 * choice made at one stop means nothing at another.
 */

export type VehicleKind = 'train' | 'bus' | 'other';

export interface BoardFilter {
  /** Route ids to show; empty means every route. */
  routes: string[];
  /** Kinds of vehicle to show; empty means every kind. */
  kinds: VehicleKind[];
}

export const NO_FILTER: BoardFilter = { routes: [], kinds: [] };

export function kindOf(mode: Mode): VehicleKind {
  switch (mode) {
    case 'rail':
    case 'tram':
    case 'metro':
    case 'funicular':
    case 'cable':
      return 'train';
    case 'bus':
      return 'bus';
    default:
      return 'other';
  }
}

export function isFiltered(filter: BoardFilter): boolean {
  return filter.routes.length > 0 || filter.kinds.length > 0;
}

export function applyFilter(departures: Departure[], filter: BoardFilter): Departure[] {
  if (!isFiltered(filter)) return departures;
  const routes = new Set(filter.routes);
  const kinds = new Set(filter.kinds);
  return departures.filter(
    (d) => (routes.size === 0 || routes.has(d.routeId)) && (kinds.size === 0 || kinds.has(kindOf(d.mode))),
  );
}

/** Adds or removes one value, keeping the list sorted so filters compare equal. */
export function toggle<T extends string>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value].sort();
}

const KEY_PREFIX = 'livetrains.boardFilter.';

export function loadFilter(stopId: string): BoardFilter {
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + stopId);
    if (!raw) return NO_FILTER;
    const parsed = JSON.parse(raw) as Partial<BoardFilter>;
    return {
      routes: Array.isArray(parsed.routes) ? parsed.routes.filter((r) => typeof r === 'string') : [],
      kinds: Array.isArray(parsed.kinds)
        ? parsed.kinds.filter((k): k is VehicleKind => k === 'train' || k === 'bus' || k === 'other')
        : [],
    };
  } catch {
    return NO_FILTER;
  }
}

export function saveFilter(stopId: string, filter: BoardFilter): void {
  try {
    if (isFiltered(filter)) window.localStorage.setItem(KEY_PREFIX + stopId, JSON.stringify(filter));
    else window.localStorage.removeItem(KEY_PREFIX + stopId);
  } catch {
    // A filter that cannot be remembered still applies for this visit.
  }
}

/**
 * Drops routes from a remembered filter that no longer call at the stop, so
 * a timetable change cannot leave the board pinned to nothing.
 */
export function reconcile(filter: BoardFilter, routesHere: string[]): BoardFilter {
  const here = new Set(routesHere);
  const routes = filter.routes.filter((r) => here.has(r));
  return routes.length === filter.routes.length ? filter : { ...filter, routes };
}
