import type { RouteSummary, ServiceAlert, Vehicle } from './api.ts';
import { effectMeta, isActive, isTripNotice } from './alerts.ts';

/**
 * The whole network, line by line: is it running, and is it running well?
 *
 * Built from two things the app already has. Every live vehicle carries its
 * delay against the timetable, so a line's vehicles together say whether it
 * is keeping time. And the agency's alerts say what it knows about — a
 * detour, a suspension. Either can make a line's status; the worse wins.
 *
 * The words are a status board's, not a dashboard's: "Good service",
 * "Minor delays", "Severe delays". A rider wants the verdict, then the
 * reason, and only then the numbers.
 */

export type LineState = 'suspended' | 'severe' | 'disrupted' | 'minor' | 'good' | 'quiet';

/** Worst first. */
export const STATE_ORDER: LineState[] = ['suspended', 'severe', 'disrupted', 'minor', 'good', 'quiet'];

export const STATE_LABEL: Record<LineState, string> = {
  suspended: 'Suspended',
  severe: 'Severe delays',
  disrupted: 'Disrupted',
  minor: 'Minor delays',
  good: 'Good service',
  quiet: 'Not running now',
};

/** A vehicle this far behind is late in the sense a rider means. */
export const LATE_SECONDS = 5 * 60;

/** A position older than this is not evidence of anything happening now. */
const LIVE_SECONDS = 180;

const RAIL_MODES = new Set(['rail', 'tram', 'metro', 'funicular', 'cable']);

export interface LineHealth {
  route: RouteSummary;
  state: LineState;
  /** "Good service", or the alert's own label for a disruption. */
  label: string;
  /** Vehicles reporting live positions right now. */
  vehicles: number;
  /** Of those, how many have a delay figure. */
  measured: number;
  /** How many are more than LATE_SECONDS behind. */
  late: number;
  /** Median delay in seconds among those measured, or null with none. */
  medianDelay: number | null;
  /** The most serious line-wide alert in force, if any. */
  alert: ServiceAlert | null;
  /** One line on why: "4 of 6 trains over 5 min late". */
  reason: string | null;
}

export interface NetworkHealth {
  lines: LineHealth[];
  counts: Record<LineState, number>;
  /** Routes with vehicles out, or with something to report. */
  running: number;
  /** Live vehicles across the network. */
  vehicles: number;
  /** Share of measured vehicles within LATE_SECONDS of the timetable. */
  onTimeShare: number | null;
}

/** How bad an alert is for a whole line: a few cancelled trips rank below a detour. */
function alertRank(alert: ServiceAlert): number {
  return isTripNotice(alert) ? 4.5 : effectMeta(alert).rank;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function noun(route: RouteSummary, count: number): string {
  const rail = RAIL_MODES.has(route.mode);
  return count === 1 ? (rail ? 'train' : 'bus') : rail ? 'trains' : 'buses';
}

/** Alerts that are about a whole line rather than one stop on it. */
function lineAlerts(alerts: ServiceAlert[], now: number): Map<string, ServiceAlert[]> {
  const byRoute = new Map<string, ServiceAlert[]>();
  for (const alert of alerts) {
    if (!isActive(alert, now)) continue;
    const routes = new Set<string>();
    for (const entity of alert.informed) {
      if (entity.routeId && !entity.stopId) routes.add(entity.routeId);
    }
    for (const routeId of routes) {
      const list = byRoute.get(routeId);
      if (list) list.push(alert);
      else byRoute.set(routeId, [alert]);
    }
  }
  return byRoute;
}

export function lineHealth(
  route: RouteSummary,
  vehicles: Vehicle[],
  alerts: ServiceAlert[],
): LineHealth {
  const delays = vehicles.flatMap((v) => (v.delaySeconds === undefined ? [] : [v.delaySeconds]));
  const late = delays.filter((d) => d >= LATE_SECONDS).length;
  const medianDelay = median(delays);
  const measured = delays.length;
  const lateShare = measured > 0 ? late / measured : 0;

  // From the vehicles alone. A real network always has a late bus somewhere,
  // so one straggler does not make a line's verdict: it takes a typical
  // vehicle well behind, or a good share of several.
  let state: LineState = 'quiet';
  if (vehicles.length > 0) {
    if ((medianDelay ?? 0) >= 10 * 60 || (measured >= 3 && lateShare >= 0.6)) state = 'severe';
    else if ((medianDelay ?? 0) >= LATE_SECONDS || (measured >= 3 && lateShare >= 0.34)) state = 'minor';
    else state = 'good';
  }

  // The agency's word can only make it worse.
  const ranked = [...alerts]
    .filter((a) => effectMeta(a).tone !== 'info' && !/ACCESSIBILITY/.test(a.effect ?? ''))
    .sort((a, b) => alertRank(a) - alertRank(b));
  const worst = ranked[0] ?? null;
  let label = STATE_LABEL[state];
  if (worst) {
    const fromAlert: LineState = isTripNotice(worst)
      ? 'disrupted'
      : worst.effect === 'NO_SERVICE'
        ? 'suspended'
        : worst.effect === 'SIGNIFICANT_DELAYS'
          ? 'severe'
          : 'disrupted';
    if (STATE_ORDER.indexOf(fromAlert) < STATE_ORDER.indexOf(state)) {
      state = fromAlert;
      label = isTripNotice(worst) ? 'Trips cancelled' : fromAlert === 'disrupted' ? effectMeta(worst).label : STATE_LABEL[fromAlert];
    }
  }

  let reason: string | null = null;
  if (late > 0) {
    reason = `${late} of ${measured} ${noun(route, measured)} over ${LATE_SECONDS / 60} min late`;
  } else if (vehicles.length > 0) {
    reason = `${vehicles.length} ${noun(route, vehicles.length)} running${measured > 0 ? ', on time' : ''}`;
  }

  return { route, state, label, vehicles: vehicles.length, measured, late, medianDelay, alert: worst, reason };
}

export function networkHealth(
  routes: RouteSummary[],
  vehicles: Vehicle[],
  alerts: ServiceAlert[],
  now: number,
): NetworkHealth {
  const live = vehicles.filter((v) => v.routeId && now - v.timestamp <= LIVE_SECONDS);
  const byRoute = new Map<string, Vehicle[]>();
  for (const vehicle of live) {
    const list = byRoute.get(vehicle.routeId!);
    if (list) list.push(vehicle);
    else byRoute.set(vehicle.routeId!, [vehicle]);
  }
  const alertsByRoute = lineAlerts(alerts, now);

  const lines = routes.map((route) => lineHealth(route, byRoute.get(route.id) ?? [], alertsByRoute.get(route.id) ?? []));
  // Worst first; within a state, the agency's own order.
  const order = new Map(routes.map((route, index) => [route.id, index]));
  lines.sort(
    (a, b) =>
      STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || order.get(a.route.id)! - order.get(b.route.id)!,
  );

  const counts = Object.fromEntries(STATE_ORDER.map((state) => [state, 0])) as Record<LineState, number>;
  for (const line of lines) counts[line.state] += 1;

  const measured = live.filter((v) => v.delaySeconds !== undefined);
  const onTime = measured.filter((v) => v.delaySeconds! < LATE_SECONDS).length;

  return {
    lines,
    counts,
    running: lines.length - counts.quiet,
    vehicles: live.length,
    onTimeShare: measured.length > 0 ? onTime / measured.length : null,
  };
}

/** Whether a route is one of the network's named lines: rail, or a branded route. */
export function isTrunkLine(route: RouteSummary, houseColor: string | null): boolean {
  return RAIL_MODES.has(route.mode) || (houseColor !== null && route.color.toUpperCase() !== houseColor);
}

/**
 * The colour most ordinary buses wear, if the agency has one.
 *
 * Metro Transit paints its local routes one blue and its METRO lines their
 * own colours, so "not the usual blue" is a good test for a named line.
 * Mirrors the server's line tiers.
 */
export function houseColor(routes: RouteSummary[]): string | null {
  const counts = new Map<string, number>();
  for (const route of routes) {
    if (RAIL_MODES.has(route.mode)) continue;
    const color = route.color.toUpperCase();
    counts.set(color, (counts.get(color) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [color, count] of counts) {
    if (count > bestCount) {
      best = color;
      bestCount = count;
    }
  }
  return bestCount >= 4 ? best : null;
}
