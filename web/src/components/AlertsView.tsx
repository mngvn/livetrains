import { useEffect, useMemo, useState } from 'react';
import type { RouteSummary, ServiceAlert } from '../lib/api.ts';
import { effectMeta, isAccessibilityAlert, isActive, sortAlerts } from '../lib/alerts.ts';
import { AlertCard } from './AlertCard.tsx';

type Filter = 'all' | 'disruptions' | 'access' | 'changes';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'disruptions', label: 'Closures & detours' },
  { id: 'access', label: 'Accessibility' },
  { id: 'changes', label: 'Service changes' },
];

function matches(alert: ServiceAlert, filter: Filter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'access':
      return isAccessibilityAlert(alert);
    case 'disruptions':
      return !isAccessibilityAlert(alert) && effectMeta(alert).tone !== 'info';
    case 'changes':
      return !isAccessibilityAlert(alert) && effectMeta(alert).tone === 'info';
  }
}

/**
 * Every alert the agency is publishing, in one place.
 *
 * A metro feed carries a lot of these — over a hundred for Metro Transit on an
 * ordinary day, most of them single stops closed for construction — so the
 * view is built around narrowing: by kind, and by route number, which is how
 * a rider actually asks ("is anything wrong with the 21?").
 */
export function AlertsView({
  alerts,
  now,
  routes,
  onShowRoute,
  onShownChange,
}: {
  alerts: ServiceAlert[];
  now: number;
  routes: Map<string, RouteSummary>;
  onShowRoute: (routeId: string) => void;
  /** The alerts left after filtering, so the map can draw the same ones. */
  onShownChange?: (shown: ServiceAlert[]) => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [routeQuery, setRouteQuery] = useState('');

  const { agencyWide, listed } = useMemo(() => {
    const query = routeQuery.trim().toLowerCase();
    const wantedRoutes = query
      ? new Set(
          [...routes.values()]
            .filter((r) => r.shortName.toLowerCase() === query || r.longName.toLowerCase().includes(query))
            .map((r) => r.id),
        )
      : null;

    const agencyWide: ServiceAlert[] = [];
    const listed: ServiceAlert[] = [];
    for (const alert of sortAlerts(alerts, now)) {
      if (!matches(alert, filter)) continue;
      const wide = alert.routeIds.length === 0 && alert.stopIds.length === 0;
      if (wantedRoutes && !alert.routeIds.some((id) => wantedRoutes.has(id))) continue;
      (wide ? agencyWide : listed).push(alert);
    }
    return { agencyWide, listed };
  }, [alerts, now, filter, routeQuery, routes]);

  useEffect(() => {
    onShownChange?.([...agencyWide, ...listed]);
  }, [agencyWide, listed, onShownChange]);
  // Closing the view forgets its filters, so the map should too: reopened, it
  // starts from every alert rather than flashing the last filtered few.
  useEffect(() => () => onShownChange?.([]), [onShownChange]);

  const activeCount = alerts.filter((a) => isActive(a, now)).length;

  return (
    <div className="alerts-view">
      <p className="alerts-view__summary">
        {alerts.length === 0
          ? 'No service alerts right now.'
          : `${activeCount} in effect${alerts.length > activeCount ? `, ${alerts.length - activeCount} coming up` : ''}.`}
      </p>

      <div className="alerts-view__filters" role="group" aria-label="Show">
        {FILTERS.map((option) => (
          <button
            key={option.id}
            type="button"
            className="chip"
            aria-pressed={filter === option.id}
            onClick={() => setFilter(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <label className="alerts-view__search">
        <span className="visually-hidden">Filter by route</span>
        <input
          type="search"
          placeholder="Route number or name, e.g. 21 or Blue"
          value={routeQuery}
          onChange={(event) => setRouteQuery(event.target.value)}
        />
      </label>

      {agencyWide.length > 0 && (
        <section className="panel-section">
          <h3 className="panel-section__title">Across the system</h3>
          <div className="alerts">
            {agencyWide.map((alert) => (
              <AlertCard key={alert.id} alert={alert} now={now} routes={routes} onShowRoute={onShowRoute} />
            ))}
          </div>
        </section>
      )}

      {listed.length > 0 && (
        <section className="panel-section">
          {agencyWide.length > 0 && <h3 className="panel-section__title">Routes and stops</h3>}
          <div className="alerts">
            {listed.map((alert) => (
              <AlertCard key={alert.id} alert={alert} now={now} routes={routes} onShowRoute={onShowRoute} />
            ))}
          </div>
        </section>
      )}

      {alerts.length > 0 && agencyWide.length + listed.length === 0 && (
        <p className="panel-empty">Nothing matches that.</p>
      )}
    </div>
  );
}
