import type { Place } from './api.ts';

/**
 * What a link can carry: a trip's two ends, a stop, or a route.
 *
 * Kept deliberately small and readable — `?from=44.9784,-93.2699&fromName=…` —
 * so a link pasted into a chat still says roughly where it goes, and one
 * typed by hand still works.
 *
 * "My location" is never written into a link. It would publish where the
 * sender is standing to whoever receives it, and it would be the wrong
 * start for them anyway: the recipient plans from wherever *they* are.
 */
export interface SharedState {
  from?: Place;
  to?: Place;
  stop?: string;
  route?: string;
}

/** ~1 m of precision; more is noise, and less moves a pin across the street. */
const COORD_DIGITS = 5;

export function readSharedState(search: string): SharedState {
  const params = new URLSearchParams(search);
  const state: SharedState = {};
  const from = readPlace(params, 'from');
  const to = readPlace(params, 'to');
  if (from) state.from = from;
  if (to) state.to = to;
  const stop = params.get('stop')?.trim();
  if (stop) state.stop = stop;
  const route = params.get('route')?.trim();
  if (route) state.route = route;
  return state;
}

export function hasSharedState(state: SharedState): boolean {
  return Boolean(state.from || state.to || state.stop || state.route);
}

/**
 * The query string for a state, with every param this app does not own left
 * exactly as it was (someone else's tracking or feature flags, say).
 */
export function writeSharedState(state: SharedState, currentSearch = ''): string {
  const params = new URLSearchParams(currentSearch);
  for (const key of ['from', 'fromName', 'to', 'toName', 'stop', 'route']) params.delete(key);
  writePlace(params, 'from', state.from);
  writePlace(params, 'to', state.to);
  if (state.stop) params.set('stop', state.stop);
  if (state.route) params.set('route', state.route);
  // Commas are legal in a query string; leaving them unescaped keeps
  // "from=44.97841,-93.26993" readable in a chat message.
  const query = params.toString().replace(/%2C/gi, ',');
  return query ? `?${query}` : '';
}

/** A full, shareable URL for a state, based on the page's own address. */
export function shareUrl(state: SharedState, location: Pick<Location, 'origin' | 'pathname'> = window.location): string {
  return `${location.origin}${location.pathname}${writeSharedState(state)}`;
}

/** Whether a place can go in a link at all. */
export function isShareable(place: Place | null | undefined): place is Place {
  return Boolean(place && place.kind !== 'current-location');
}

function readPlace(params: URLSearchParams, key: 'from' | 'to'): Place | undefined {
  const raw = params.get(key);
  if (!raw) return undefined;
  const [latText, lonText] = raw.split(',');
  const lat = Number(latText);
  const lon = Number(lonText);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
  const name = params.get(`${key}Name`)?.trim().slice(0, 120) || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  return { id: `shared:${lat},${lon}`, name, lat, lon, kind: 'coordinate' };
}

function writePlace(params: URLSearchParams, key: 'from' | 'to', place: Place | undefined): void {
  if (!isShareable(place)) return;
  params.set(key, `${place.lat.toFixed(COORD_DIGITS)},${place.lon.toFixed(COORD_DIGITS)}`);
  params.set(`${key}Name`, place.name);
}
