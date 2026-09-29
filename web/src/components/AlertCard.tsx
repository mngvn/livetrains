import type { RouteSummary, ServiceAlert } from '../lib/api.ts';
import { effectMeta, isActive, nextStart } from '../lib/alerts.ts';
import { clockTime } from '../lib/format.ts';
import { RouteBadge } from './RouteBadge.tsx';

/**
 * One service alert.
 *
 * The header is always visible and the description is a tap away: most
 * alerts are fully stated in their header ("Stop #53316 is closed for Routes
 * 156 and 578"), and a list of expanded descriptions would push the
 * departures off the screen.
 */
export function AlertCard({
  alert,
  now,
  routes,
  onShowRoute,
}: {
  alert: ServiceAlert;
  now: number;
  /** Known routes, to draw badges for the ones this alert names. */
  routes?: Map<string, RouteSummary>;
  onShowRoute?: (routeId: string) => void;
}) {
  const meta = effectMeta(alert);
  const active = isActive(alert, now);
  const starts = active ? null : nextStart(alert, now);
  const named = routes ? alert.routeIds.map((id) => routes.get(id)).filter((r) => r !== undefined) : [];

  return (
    <details className={`alert-card alert-card--${meta.tone}${active ? '' : ' is-upcoming'}`}>
      <summary className="alert-card__summary">
        <span className="alert-card__effect">{meta.label}</span>
        <span className="alert-card__header">{alert.header}</span>
        {starts !== null && <span className="alert-card__when">From {formatWhen(starts, now)}</span>}
      </summary>
      <div className="alert-card__body">
        {alert.description && <p className="alert-card__description">{alert.description}</p>}
        {named.length > 0 && (
          <div className="alert-card__routes">
            {named.slice(0, 12).map((route) =>
              onShowRoute ? (
                <button
                  key={route.id}
                  type="button"
                  className="alert-card__route"
                  onClick={() => onShowRoute(route.id)}
                  aria-label={`Show route ${route.shortName}`}
                >
                  <RouteBadge route={route} size="small" />
                </button>
              ) : (
                <RouteBadge key={route.id} route={route} size="small" />
              ),
            )}
            {named.length > 12 && <span className="alert-card__more">+{named.length - 12} more</span>}
          </div>
        )}
        {alert.url && (
          <a className="alert-card__link" href={alert.url} target="_blank" rel="noreferrer">
            More from the agency
          </a>
        )}
      </div>
    </details>
  );
}

/** "3:40 PM" today, "Tue 3:40 PM" within a week, a date beyond that. */
function formatWhen(epochSeconds: number, now: number): string {
  const date = new Date(epochSeconds * 1000);
  const days = (epochSeconds - now) / 86_400;
  if (days < 1 && new Date(now * 1000).getDate() === date.getDate()) return clockTime(epochSeconds);
  if (days < 7) return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${clockTime(epochSeconds)}`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
