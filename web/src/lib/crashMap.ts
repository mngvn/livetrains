import type { AlertPlace, CrashReport, RouteSummary, ServiceAlert } from './api.ts';
import { isActive } from './alerts.ts';

/**
 * Crashes the agency has reported, for the map and for the line under the
 * status bar.
 *
 * A crash is the one kind of alert drawn whichever tab is open: a closed
 * stop matters to the people who use that stop, a collision on the line
 * matters to everyone about to ride it. Only those in force now are shown —
 * the agency ends the alert when the trip it cancelled would have ended, and
 * a crash from this morning is not news this afternoon.
 */
export interface Crash {
  alert: ServiceAlert;
  /** A stop near where it was reported, when the alert says enough to tell. */
  place?: AlertPlace;
  /** The lines involved, as riders name them: "E Line", "Route 21". */
  lines: string[];
}

/** How a rider says a route's name: "Blue Line", "E Line", "Route 21". */
function lineName(route: RouteSummary): string {
  const short = route.shortName.trim();
  const fromLong = /\b(\S+ Line)\b/.exec(route.longName ?? '')?.[1];
  if (fromLong) return fromLong;
  if (!short) return route.longName;
  return /^\d/.test(short) ? `Route ${short}` : short;
}

/** The crashes in force now, joined to their alerts. */
export function activeCrashes(
  alerts: ServiceAlert[],
  reports: CrashReport[],
  routes: Map<string, RouteSummary>,
  now: number,
): Crash[] {
  const byId = new Map(alerts.map((alert) => [alert.id, alert]));
  const crashes: Crash[] = [];
  for (const report of reports) {
    const alert = byId.get(report.alertId);
    if (!alert || !isActive(alert, now)) continue;
    const lines = alert.routeIds.flatMap((id) => {
      const route = routes.get(id);
      return route ? [lineName(route)] : [];
    });
    crashes.push({ alert, place: report.place, lines });
  }
  return crashes;
}

/** "Crash reported on the E Line near 4th St & 15th Ave Station". */
export function crashSummary(crash: Crash): string {
  const lines = crash.lines.slice(0, 2).join(' and ') + (crash.lines.length > 2 ? ` and ${crash.lines.length - 2} more` : '');
  const on = lines ? ` on ${/ Line\b/.test(lines) ? 'the ' : ''}${lines}` : '';
  const near = crash.place ? ` near ${crash.place.name}` : '';
  return `Crash reported${on}${near}`;
}

/**
 * One marker per place a crash was reported, however many alerts report it:
 * a collision that cancels three trips is one collision.
 */
export function crashMarkers(crashes: Crash[]): GeoJSON.FeatureCollection<GeoJSON.Point> {
  const byStop = new Map<string, { place: AlertPlace; crashes: Crash[] }>();
  for (const crash of crashes) {
    if (!crash.place) continue;
    const entry = byStop.get(crash.place.stopId);
    if (entry) entry.crashes.push(crash);
    else byStop.set(crash.place.stopId, { place: crash.place, crashes: [crash] });
  }
  return {
    type: 'FeatureCollection',
    features: [...byStop.values()].map(({ place, crashes: here }) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [place.lon, place.lat] },
      properties: {
        id: place.stopId,
        name: place.name,
        lines: [...new Set(here.flatMap((crash) => crash.lines))].join(', '),
        // What the agency said, for the tooltip.
        header: here[0].alert.header,
      },
    })),
  };
}
