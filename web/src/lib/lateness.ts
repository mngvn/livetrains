import type { ServiceAlert, Vehicle, VehicleTrip } from './api.ts';
import { effectMeta, isAccessibilityAlert, isActive } from './alerts.ts';
import { projectOntoLine } from './geometry.ts';

/**
 * "Why is it late?", answered from what the app can actually see.
 *
 * Four kinds of evidence, in the order a rider would find them convincing:
 * the agency saying so (a detour, works on the line); the bus having caught
 * up with the one in front, which is the commonest cause of a bus running
 * late and the one nobody explains; how its delay has moved over the last
 * few minutes; and whether it was already late when it set out. When none
 * of them applies, it says so rather than inventing a reason.
 */

/** Late enough to be worth explaining. */
export const LATE_ENOUGH_SECONDS = 3 * 60;

/** Two vehicles of the same route closer than this, along the line, are bunched. */
const BUNCHED_METERS = 700;

/** A position older than this is not evidence of where a vehicle is now. */
const LIVE_SECONDS = 180;

export type ReasonKind = 'alert' | 'bunching' | 'trend' | 'start' | 'unknown';

export interface DelayReason {
  kind: ReasonKind;
  title: string;
  detail: string;
}

export interface DelayExplanation {
  /** Minutes late, rounded. */
  minutes: number;
  reasons: DelayReason[];
}

const RAIL = new Set(['rail', 'tram', 'metro', 'funicular', 'cable']);

function noun(vehicle: Pick<Vehicle, 'mode'>): string {
  return RAIL.has(vehicle.mode) ? 'train' : 'bus';
}

function metersBetween(a: [number, number], b: [number, number]): number {
  const lat = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const dx = (b[0] - a[0]) * 111_320 * Math.cos(lat);
  const dy = (b[1] - a[1]) * 111_320;
  return Math.hypot(dx, dy);
}

/** How far along a line a point sits, in metres from its start. */
export function distanceAlong(line: [number, number][], point: [number, number]): number | null {
  const projection = projectOntoLine(line, point);
  if (!projection) return null;
  let total = 0;
  for (let i = 0; i < projection.segment; i++) total += metersBetween(line[i], line[i + 1]);
  return total + metersBetween(line[projection.segment], projection.point);
}

export function explainDelay(input: {
  vehicle: Vehicle;
  trip: VehicleTrip | null;
  /** Every vehicle the app knows of, for spotting bunching. */
  others: Vehicle[];
  /** This vehicle's delay over the last few minutes, oldest first. */
  history: { t: number; delay: number }[];
  now: number;
}): DelayExplanation | null {
  const { vehicle, trip, others, history, now } = input;
  const delay = vehicle.delaySeconds;
  if (delay === undefined || delay < LATE_ENOUGH_SECONDS) return null;
  const reasons: DelayReason[] = [];
  const kind = noun(vehicle);

  // 1. The agency's own word.
  const alerts: ServiceAlert[] = (trip?.alerts ?? []).filter(
    (alert) => isActive(alert, now) && effectMeta(alert).tone !== 'info' && !isAccessibilityAlert(alert),
  );
  for (const alert of alerts.slice(0, 2)) {
    reasons.push({ kind: 'alert', title: effectMeta(alert).label, detail: alert.header });
  }

  // 2. Bunching: another vehicle of the same route, going the same way,
  // just ahead along the line.
  if (trip && trip.geometry.length >= 2) {
    const here = distanceAlong(trip.geometry, [vehicle.lon, vehicle.lat]);
    if (here !== null) {
      let ahead: number | null = null;
      let behind: number | null = null;
      for (const other of others) {
        if (other.id === vehicle.id || other.routeId !== vehicle.routeId) continue;
        if (vehicle.directionId !== undefined && other.directionId !== vehicle.directionId) continue;
        if (now - other.timestamp > LIVE_SECONDS) continue;
        const along = distanceAlong(trip.geometry, [other.lon, other.lat]);
        if (along === null) continue;
        // Off the line altogether: some other branch or the far side of a loop.
        const off = projectOntoLine(trip.geometry, [other.lon, other.lat]);
        if (!off || metersBetween(off.point, [other.lon, other.lat]) > 120) continue;
        const gap = along - here;
        if (gap > 0 && gap <= BUNCHED_METERS) ahead = ahead === null ? gap : Math.min(ahead, gap);
        if (gap < 0 && -gap <= BUNCHED_METERS) behind = behind === null ? -gap : Math.min(behind, -gap);
      }
      if (ahead !== null) {
        reasons.push({
          kind: 'bunching',
          title: `Bunched with the ${kind} ahead`,
          detail:
            `Another ${vehicle.routeShortName ?? ''} is ${Math.round(ahead / 10) * 10} m in front. ` +
            `Running this close, the one in front picks up most of the riders at every stop and both slow down.`,
        });
      } else if (behind !== null) {
        reasons.push({
          kind: 'bunching',
          title: `Another ${kind} is right behind`,
          detail:
            `A second ${vehicle.routeShortName ?? ''} is ${Math.round(behind / 10) * 10} m back. ` +
            `This one is doing the work of two: there is a gap in service ahead of it.`,
        });
      }
    }
  }

  // 3. How the delay has moved recently.
  const recent = history.filter((h) => h.t >= now - 15 * 60);
  if (recent.length >= 2) {
    const first = recent[0];
    const last = recent[recent.length - 1];
    const minutes = Math.max(1, Math.round((last.t - first.t) / 60));
    const change = last.delay - first.delay;
    if (change >= 90) {
      reasons.push({
        kind: 'trend',
        title: 'Losing time',
        detail: `${Math.round(change / 60)} min later than it was ${minutes} min ago: something on this stretch is holding it up.`,
      });
    } else if (change <= -90) {
      reasons.push({
        kind: 'trend',
        title: 'Catching up',
        detail: `${Math.round(-change / 60)} min less late than ${minutes} min ago.`,
      });
    } else if (last.t - first.t >= 6 * 60) {
      reasons.push({
        kind: 'trend',
        title: 'Steady, not getting worse',
        detail: `About the same delay for the last ${minutes} min: it fell behind earlier in its trip.`,
      });
    }
  }

  // 4. Late from the start.
  if (trip && trip.stops.length > 0 && trip.nextStopIndex <= 2) {
    const started = trip.stops[0].scheduledTime;
    if (now - started >= 0 && now - started <= 20 * 60) {
      reasons.push({
        kind: 'start',
        title: 'Late from the start',
        detail: `It left its first stop behind time, usually a knock-on from the trip this ${kind} ran before.`,
      });
    }
  }

  if (reasons.length === 0) {
    reasons.push({
      kind: 'unknown',
      title: 'Nothing reported explains it',
      detail:
        `No alert covers this ${kind} and none is bunched with it. ` +
        (kind === 'train'
          ? 'Signals, street crossings or heavy boarding on the way are the likeliest causes.'
          : 'Traffic or heavy boarding on the way are the likeliest causes.'),
    });
  }

  return { minutes: Math.round(delay / 60), reasons };
}
