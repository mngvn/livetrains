import { useMemo } from 'react';
import type { RouteDetail, RouteSummary } from '../lib/api.ts';
import { sortAlerts } from '../lib/alerts.ts';
import { modeLabel } from '../lib/format.ts';
import { AlertCard } from './AlertCard.tsx';
import { RouteBadge } from './RouteBadge.tsx';
import { ShareButton } from './ShareButton.tsx';
import { shareUrl } from '../lib/shareLink.ts';

/**
 * Every route, and the one being looked at.
 *
 * Grouped by operator when the feed has more than one. A regional feed mixes
 * agencies whose passes, fares and customer lines differ, and "which routes
 * does SouthWest Transit run" is a real question with no answer in a flat,
 * number-sorted list.
 */
export function RoutesTab({
  routes,
  activeRouteId,
  activeDetail,
  alertCounts,
  now,
  routesById,
  onSelect,
  onClear,
  onShowRoute,
}: {
  routes: RouteSummary[];
  activeRouteId: string | null;
  activeDetail: RouteDetail | null;
  /** Route-wide alerts per route, for the warning mark in the list. */
  alertCounts: Map<string, number>;
  now: number;
  routesById: Map<string, RouteSummary>;
  onSelect: (route: RouteSummary) => void;
  onClear: () => void;
  onShowRoute: (routeId: string) => void;
}) {
  const groups = useMemo(() => {
    const byOperator = new Map<string, RouteSummary[]>();
    for (const route of routes) {
      const name = route.operator?.name ?? '';
      const list = byOperator.get(name) ?? [];
      list.push(route);
      byOperator.set(name, list);
    }
    // Largest operator first: in a regional feed that is the one most riders use.
    return [...byOperator].sort((a, b) => b[1].length - a[1].length);
  }, [routes]);

  const active = activeDetail?.route ?? (activeRouteId ? routesById.get(activeRouteId) : undefined);
  const operator = active?.operator;
  const alerts = activeDetail ? sortAlerts(activeDetail.alerts, now) : [];

  return (
    <div className="routes-tab">
      {active && (
        <section className="route-card">
          <header className="route-card__header">
            <RouteBadge route={active} />
            <div>
              <h2 className="panel-title">{active.longName || active.shortName}</h2>
              <p className="panel-subtitle">
                {modeLabel(active.mode)}
                {operator && <> · Operated by {operator.name}</>}
              </p>
            </div>
          </header>

          {operator && (operator.phone || operator.url) && (
            <p className="route-card__contact">
              {operator.phone && <a href={`tel:${operator.phone}`}>{operator.phone}</a>}
              {operator.phone && operator.url && ' · '}
              {operator.url && (
                <a href={operator.url} target="_blank" rel="noreferrer">
                  {new URL(operator.url).hostname.replace(/^www\./, '')}
                </a>
              )}
            </p>
          )}

          {activeDetail && activeDetail.directions.length > 0 && (
            <p className="route-card__directions">
              {activeDetail.directions
                .map((d) => `To ${d.headsign} · ${d.stops.length} stops`)
                .join('  ·  ')}
            </p>
          )}

          {alerts.length > 0 && (
            <div className="alerts">
              {alerts.map((alert) => (
                <AlertCard key={alert.id} alert={alert} now={now} routes={routesById} onShowRoute={onShowRoute} />
              ))}
            </div>
          )}
          {activeDetail && alerts.length === 0 && <p className="panel-empty">No alerts on this route.</p>}

          <div className="panel-actions">
            <button type="button" className="chip chip--primary" onClick={onClear}>
              Back to the whole network
            </button>
            <ShareButton url={shareUrl({ route: active.id })} title={`Route ${active.shortName} — live vehicles`} />
          </div>
        </section>
      )}

      {groups.map(([name, list]) => (
        <section key={name || 'routes'} className="route-group">
          {groups.length > 1 && (
            <h3 className="panel-section__title">
              {name || 'Other'} <span className="route-group__count">{list.length}</span>
            </h3>
          )}
          <ul className="route-list">
            {list.map((route) => {
              const warnings = alertCounts.get(route.id) ?? 0;
              return (
                <li key={route.id}>
                  <button
                    type="button"
                    className={`route-list__item${activeRouteId === route.id ? ' is-active' : ''}`}
                    onClick={() => onSelect(route)}
                  >
                    <RouteBadge route={route} />
                    <span className="route-list__text">
                      <span className="route-list__name">{route.longName || route.shortName}</span>
                      <span className="route-list__mode">{modeLabel(route.mode)}</span>
                    </span>
                    {warnings > 0 && (
                      <span className="route-list__alert" title={`${warnings} alert${warnings > 1 ? 's' : ''} on this route`}>
                        <span aria-hidden="true">!</span>
                        <span className="visually-hidden">{warnings} alerts</span>
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
