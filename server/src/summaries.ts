import type { Agency, GtfsStore, Route, Stop } from './gtfs/store.js';
import type { Accessibility, Operator, RouteSummary, StopSummary } from './shared/api.js';

/**
 * Store records, projected onto the wire shapes the client reads.
 *
 * Kept in one place because both the HTTP API and the in-browser engine
 * answer the same questions, and a field added on one side and not the other
 * is a bug that only shows up in whichever mode nobody was testing.
 */

/** GTFS's 0/1/2 accessibility code, with "unknown" left out rather than guessed. */
export function accessibility(value: number): Accessibility | undefined {
  if (value === 1) return 'accessible';
  if (value === 2) return 'not-accessible';
  return undefined;
}

export function stopSummary(stop: Stop): StopSummary {
  const summary: StopSummary = { id: stop.id, code: stop.code, name: stop.name, lat: stop.lat, lon: stop.lon };
  const wheelchair = accessibility(stop.wheelchair);
  if (wheelchair) summary.wheelchair = wheelchair;
  if (stop.platformCode) summary.platformCode = stop.platformCode;
  // Only when it says something the name does not.
  if (stop.description && stop.description !== stop.name) summary.description = stop.description;
  return summary;
}

const operators = new WeakMap<Agency, Operator>();

/** An agency as the client sees it, built once per agency rather than per call. */
export function operator(agency: Agency): Operator {
  let out = operators.get(agency);
  if (!out) {
    out = { id: agency.id, name: agency.name };
    if (agency.url) out.url = agency.url;
    if (agency.phone) out.phone = agency.phone;
    operators.set(agency, out);
  }
  return out;
}

/** A route with its operator, for anywhere the route is the subject. */
export function routeSummary(store: GtfsStore, route: Route): RouteSummary {
  const summary = leanRouteSummary(route);
  if (route.description) summary.description = route.description;
  const agency = store.agencyOf(route);
  if (agency) summary.operator = operator(agency);
  return summary;
}

/**
 * A route as a badge: enough to draw it, nothing more.
 *
 * Stop lists carry a badge for every route at every stop — a viewport can be
 * hundreds of stops — so they leave out the operator and description that a
 * route detail view needs.
 */
export function leanRouteSummary(route: Route): RouteSummary {
  return {
    id: route.id,
    shortName: route.shortName,
    longName: route.longName,
    mode: route.mode,
    color: route.color,
    textColor: route.textColor,
  };
}
