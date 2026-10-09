import { useMemo } from 'react';
import type { RouteDetail, RouteSummary, Vehicle } from '../lib/api.ts';
import { sortAlerts } from '../lib/alerts.ts';
import { delayText, modeLabel } from '../lib/format.ts';
import { AlertCard } from './AlertCard.tsx';
import { RouteBadge } from './RouteBadge.tsx';
import { ShareButton } from './ShareButton.tsx';
import { shareUrl } from '../lib/shareLink.ts';
import { linkHost, safeWebUrl } from '../lib/safeUrl.ts';

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
  vehicles,
  onShowVehicle,
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
  /** The vehicles out on the active route now. */
  vehicles: Vehicle[];
  onShowVehicle: (vehicleId: string) => void;
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
  // Both from the feed's agency.txt: a website that is not a web address is
  // left out (and no longer takes the page down with it, as an unparseable
  // one did), and a phone number keeps only what a dialler dials.
  const operatorUrl = safeWebUrl(operator?.url);
  const operatorPhone = operator?.phone?.replace(/[^0-9+*#,;]/g, '') ?? '';
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

          {operator && (operatorPhone || operatorUrl) && (
            <p className="route-card__contact">
              {operatorPhone && <a href={`tel:${operatorPhone}`}>{operator.phone}</a>}
              {operatorPhone && operatorUrl && ' · '}
              {operatorUrl && (
                <a href={operatorUrl} target="_blank" rel="noopener noreferrer">
                  {linkHost(operatorUrl)}
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

          {activeDetail && (
            <section className="route-card__vehicles" aria-label="On this route now">
              <h3 className="panel-section__title">
                {vehicles.length === 0
                  ? 'Nothing running on this route right now'
                  : `${vehicles.length} running on this route now`}
              </h3>
              {vehicles.length > 0 && (
                <ul className="route-vehicles">
                  {[...vehicles]
                    .sort((a, b) => (a.headsign ?? '').localeCompare(b.headsign ?? '') || a.id.localeCompare(b.id))
                    .map((vehicle) => {
                      const delay = delayText(vehicle.delaySeconds);
                      return (
                        <li key={vehicle.id}>
                          <button type="button" className="route-vehicles__item" onClick={() => onShowVehicle(vehicle.id)}>
                            <span className="route-vehicles__dot" style={{ background: `#${vehicle.color}` }} aria-hidden="true" />
                            <span className="route-vehicles__name">
                              {vehicle.headsign ? `To ${vehicle.headsign}` : `${modeLabel(vehicle.mode)} ${vehicle.id}`}
                            </span>
                            {vehicle.delaySeconds !== undefined && (
                              <span className={`delay-tag delay-tag--${delay.tone}`}>{delay.label}</span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                </ul>
              )}
            </section>
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
              Show all routes
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
