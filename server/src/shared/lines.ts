/**
 * How prominently a line belongs on the map, and in the app's lists.
 *
 * A metro network is a handful of lines riders navigate by — light rail, and
 * the rapid bus lines branded as lines of their own — and a large mass of
 * ordinary routes. Drawing all of them at the same weight is what makes a
 * transit map look like spaghetti, so lines are sorted into tiers the way a
 * printed network diagram does it:
 *
 * - `rail`: trains of any kind, always drawn boldest.
 * - `branded`: buses sold as a line — Metro Transit's A–E lines, a "Rapid",
 *   a BRT — named as such in the feed.
 * - `bus`: every other route.
 *
 * Shared by the server and the browser, so the map, the stop markers and the
 * status board all agree on which routes are lines.
 *
 * Decided by name rather than by colour. Metro Transit paints its local
 * routes one purple but gives expresses, suburban operators and the campus
 * circulators colours of their own, so "not the usual colour" would make
 * fifty ordinary routes look like METRO lines.
 */
export type LineTier = 'rail' | 'branded' | 'bus';

export const RAIL_MODES: ReadonlySet<string> = new Set(['rail', 'tram', 'metro', 'funicular', 'cable']);

/** Words a feed uses for a bus sold as a line of its own. */
const LINE_WORDS = /\b(METRO|BRT|Rapid|RapidRide)\b/i;

/** "A Line", "Orange Line": capitalised, as signs write it, so "the 21 line" is not one. */
const LINE_NAME = /\bLine\b/;

/** A bus standing in for a line — "Green Line Bus" — is a bus, not the line. */
const STAND_IN = /\bLine\s+Bus\b|\bShuttle\b/i;

export function lineTier(route: { mode: string; shortName: string; longName?: string }): LineTier {
  if (RAIL_MODES.has(route.mode)) return 'rail';
  const names = `${route.shortName} ${route.longName ?? ''}`;
  if (STAND_IN.test(names)) return 'bus';
  return LINE_WORDS.test(names) || LINE_NAME.test(names) ? 'branded' : 'bus';
}
