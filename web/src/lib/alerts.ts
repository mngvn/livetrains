import type { ServiceAlert } from './api.ts';

/**
 * Service alerts, as a rider needs to read them.
 *
 * The feed labels each alert with an effect from a fixed GTFS-Realtime list.
 * Those names are written for machines ("SIGNIFICANT_DELAYS"), and the
 * difference between them matters a great deal to a person: a stop that is
 * closed is not the same kind of news as a timetable change next month. So
 * each effect gets a plain label and a tone, and alerts are ordered by how
 * much they could ruin a trip.
 */

export type AlertTone = 'severe' | 'warning' | 'info';

interface EffectMeta {
  label: string;
  tone: AlertTone;
  /** Lower sorts first. */
  rank: number;
}

const EFFECTS: Record<string, EffectMeta> = {
  NO_SERVICE: { label: 'No service', tone: 'severe', rank: 0 },
  STOP_MOVED: { label: 'Stop moved', tone: 'severe', rank: 1 },
  SIGNIFICANT_DELAYS: { label: 'Delays', tone: 'severe', rank: 2 },
  DETOUR: { label: 'Detour', tone: 'warning', rank: 3 },
  REDUCED_SERVICE: { label: 'Reduced service', tone: 'warning', rank: 4 },
  ACCESSIBILITY_ISSUE: { label: 'Accessibility', tone: 'warning', rank: 5 },
  MODIFIED_SERVICE: { label: 'Service change', tone: 'info', rank: 6 },
  ADDITIONAL_SERVICE: { label: 'Extra service', tone: 'info', rank: 7 },
  OTHER_EFFECT: { label: 'Notice', tone: 'info', rank: 8 },
  NO_EFFECT: { label: 'Notice', tone: 'info', rank: 9 },
  UNKNOWN_EFFECT: { label: 'Notice', tone: 'info', rank: 9 },
};

const FALLBACK: EffectMeta = { label: 'Notice', tone: 'info', rank: 9 };

export function effectMeta(alert: ServiceAlert): EffectMeta {
  const meta = (alert.effect && EFFECTS[alert.effect]) || FALLBACK;
  // An elevator outage filed as a generic notice is still, for someone who
  // cannot use stairs, the difference between a station and no station.
  if (meta.tone === 'info' && isAccessibilityAlert(alert)) return EFFECTS.ACCESSIBILITY_ISSUE;
  return meta;
}

/**
 * An alert about particular trips — "Route 30 trip departing Westgate at
 * 1:04 PM and seven other trips canceled today" — rather than the line.
 *
 * Metro Transit files these under NO_SERVICE, which is true of those buses
 * and false of the route: the rest of its trips are running. Read as a
 * line-wide effect, every route with one cancelled trip would show as
 * suspended.
 */
export function isTripNotice(alert: ServiceAlert): boolean {
  if (alert.informed.some((entity) => entity.tripId)) return true;
  return /\btrips?\b[^.]*\bcancell?ed\b/i.test(alert.header);
}

/** True for alerts about lifts, ramps and step-free access. */
export function isAccessibilityAlert(alert: ServiceAlert): boolean {
  if (alert.effect === 'ACCESSIBILITY_ISSUE') return true;
  // Plenty of producers file an elevator outage under a generic effect.
  return /\b(elevators?|lifts?|ramps?)\b/i.test(alert.header);
}

/**
 * Whether an alert is in force at an instant.
 *
 * An alert with no periods is in force until the feed drops it. One with
 * periods is in force during any of them — a nightly closure is not news at
 * noon, and should not be shown as though it were.
 */
export function isActive(alert: ServiceAlert, now: number): boolean {
  if (alert.periods.length === 0) return true;
  return alert.periods.some((p) => (p.start === undefined || p.start <= now) && (p.end === undefined || now < p.end));
}

/** The next time an inactive alert comes into force, if it ever does. */
export function nextStart(alert: ServiceAlert, now: number): number | null {
  const upcoming = alert.periods
    .map((p) => p.start)
    .filter((start): start is number => start !== undefined && start > now);
  return upcoming.length > 0 ? Math.min(...upcoming) : null;
}

/** Active before upcoming, then by severity, then by the most specific. */
export function sortAlerts(alerts: ServiceAlert[], now: number): ServiceAlert[] {
  return [...alerts].sort((a, b) => {
    const active = Number(isActive(b, now)) - Number(isActive(a, now));
    if (active !== 0) return active;
    const rank = effectMeta(a).rank - effectMeta(b).rank;
    if (rank !== 0) return rank;
    return a.header.localeCompare(b.header);
  });
}
