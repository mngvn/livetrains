import type { AlertPlace, ServiceAlert } from './api.ts';
import { effectMeta, isActive, isTripNotice, type AlertTone } from './alerts.ts';

/**
 * The alerts view, drawn on the map.
 *
 * One marker per alerted stop, however many alerts name it, coloured by the
 * worst of them: a stop closed for construction and carrying an elevator
 * notice is a closed stop. Alerts that are not yet in force still appear,
 * but quieter, so the map reads as "what is wrong now" first.
 *
 * Route-wide alerts — a detour, a line running reduced — have no single
 * place. Those are shown by bringing their lines forward instead.
 */

/** Lower is worse; the map's cluster discs keep the minimum. */
export const TONE_RANK: Record<AlertTone, number> = { severe: 0, warning: 1, info: 2 };

export function alertMarkers(
  alerts: ServiceAlert[],
  places: AlertPlace[],
  now: number,
): GeoJSON.FeatureCollection<GeoJSON.Point> {
  const byId = new Map(places.map((place) => [place.stopId, place]));
  const stops = new Map<string, { place: AlertPlace; rank: number; count: number; active: boolean }>();

  for (const alert of alerts) {
    if (alert.stopIds.length === 0) continue;
    const rank = TONE_RANK[effectMeta(alert).tone];
    const active = isActive(alert, now);
    for (const stopId of new Set(alert.stopIds)) {
      const place = byId.get(stopId);
      if (!place) continue;
      const entry = stops.get(stopId);
      if (!entry) {
        stops.set(stopId, { place, rank, count: 1, active });
        continue;
      }
      entry.count += 1;
      // An alert in force outranks one that is only coming.
      if (active && !entry.active) entry.rank = rank;
      else if (active === entry.active) entry.rank = Math.min(entry.rank, rank);
      entry.active ||= active;
    }
  }

  return {
    type: 'FeatureCollection',
    features: [...stops.values()].map(({ place, rank, count, active }) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [place.lon, place.lat] },
      properties: { id: place.stopId, name: place.name, rank, count, active },
    })),
  };
}

/**
 * Routes with an alert about the whole line, not one stop or one trip — the
 * lines worth bringing forward while the alerts are on the map.
 */
export function alertedRouteIds(alerts: ServiceAlert[], now: number): string[] {
  const routes = new Set<string>();
  for (const alert of alerts) {
    if (!isActive(alert, now) || isTripNotice(alert)) continue;
    for (const entity of alert.informed) {
      if (entity.routeId && !entity.stopId) routes.add(entity.routeId);
    }
  }
  return [...routes];
}
