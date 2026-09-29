import { useEffect, useState } from 'react';
import type { ServiceAlert } from './api.ts';

/** How often to re-read alerts. They change on the scale of minutes, not seconds. */
const REFRESH_MS = 60_000;

/**
 * How soon to look again while the list is still empty.
 *
 * The engine reports ready once the timetable is loaded, which is usually a
 * moment before the first realtime poll lands. Waiting a full minute after
 * that first empty answer would leave the alerts tab blank for no reason.
 */
const EMPTY_RETRY_MS = 4_000;
const EMPTY_RETRIES = 8;

/**
 * Every service alert the agency is publishing, kept fresh.
 *
 * Held at the top of the app because several places need the same list: the
 * alerts view, the route list's warning marks, and the trip planner, which
 * flags itineraries that run into a closure. Fetching it once and sharing it
 * beats each of those polling separately.
 */
export function useAlerts(
  load: (signal?: AbortSignal) => Promise<{ alerts: ServiceAlert[] }>,
  enabled: boolean,
): ServiceAlert[] {
  const [alerts, setAlerts] = useState<ServiceAlert[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const controller = new AbortController();
    let retries = 0;
    let retryTimer: number | undefined;
    const refresh = () => {
      load(controller.signal)
        .then((result) => {
          if (cancelled) return;
          setAlerts(result.alerts);
          if (result.alerts.length === 0 && retries < EMPTY_RETRIES) {
            retries += 1;
            window.clearTimeout(retryTimer);
            retryTimer = window.setTimeout(refresh, EMPTY_RETRY_MS);
          }
        })
        // Keep showing the last good list; alerts going briefly stale is far
        // better than them vanishing because one request failed.
        .catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
      window.clearTimeout(retryTimer);
    };
  }, [load, enabled]);

  return alerts;
}

/**
 * Route-wide alerts per route: detours, reduced service, delays across a line.
 *
 * Deliberately not counting single-stop closures. Metro Transit publishes
 * well over a hundred of those at any time, and counting them would put a
 * warning on nearly every route in the list, which would teach riders to
 * ignore it. They still appear in full on the route's own page.
 */
export function routeWideAlertCounts(alerts: ServiceAlert[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const alert of alerts) {
    const routes = new Set<string>();
    for (const entity of alert.informed) {
      if (entity.routeId && !entity.stopId) routes.add(entity.routeId);
    }
    for (const route of routes) counts.set(route, (counts.get(route) ?? 0) + 1);
  }
  return counts;
}
