import { useEffect, useMemo, useState, type Ref } from 'react';
import type { RouteSummary, ServiceAlert } from '../lib/api.ts';
import { modeLabel } from '../lib/format.ts';
import { routeHealth } from '../lib/networkHealth.ts';
import type { RouteHover } from '../lib/routeHover.ts';
import type { VehicleTracker } from '../lib/vehicleTracker.ts';
import { RouteBadge } from './RouteBadge.tsx';

/** How many other routes on the same stretch are named before "+N". */
const OTHERS_SHOWN = 6;

/** Vehicles come and go and fall behind while the pointer rests: re-read this often. */
const REFRESH_MS = 2_000;

/**
 * What a route is and how it is doing, beside the pointer resting on its
 * line: the same verdict the status board gives, its vehicles out now, the
 * alert behind any disruption, and what else runs down that street.
 *
 * Placed by the map, which knows where the pointer is; this only says what
 * to show, and shows nothing until the route is known.
 */
export function RouteTooltip({
  hover,
  routes,
  alerts,
  tracker,
  ref,
}: {
  hover: RouteHover | null;
  routes: ReadonlyMap<string, RouteSummary>;
  alerts: ServiceAlert[];
  tracker: VehicleTracker;
  ref?: Ref<HTMLDivElement>;
}) {
  const [tick, setTick] = useState(0);
  const routeId = hover?.routeId ?? null;
  useEffect(() => {
    if (!routeId) return;
    const timer = window.setInterval(() => setTick((n) => n + 1), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [routeId]);

  const route = routeId ? routes.get(routeId) : undefined;
  const health = useMemo(
    () => (route ? routeHealth(route, tracker.snapshot(), alerts, Date.now() / 1000) : null),
    // `tick` stands in for the fleet moving on: the tracker itself never changes.
    [route, alerts, tracker, tick],
  );
  const others = (hover?.others ?? []).flatMap((id) => routes.get(id) ?? []);

  return (
    <div ref={ref} className={`route-tip${health ? '' : ' is-hidden'}`} role="tooltip" aria-hidden={!health}>
      {route && health && (
        <>
          <div className="route-tip__head">
            <RouteBadge route={route} />
            <span className="route-tip__name">{route.longName || `Route ${route.shortName}`}</span>
          </div>
          <p className="route-tip__meta">
            {modeLabel(route.mode)}
            {route.operator && ` · ${route.operator.name}`}
          </p>
          <p className={`route-tip__state is-${health.state}`}>
            <span className="route-tip__dot" aria-hidden="true" />
            {health.label}
          </p>
          {health.reason && <p className="route-tip__detail">{health.reason}</p>}
          {health.alert && <p className="route-tip__alert">{health.alert.header}</p>}
          {others.length > 0 && (
            <div className="route-tip__others">
              <span className="route-tip__others-label">Also here</span>
              {others.slice(0, OTHERS_SHOWN).map((other) => (
                <RouteBadge key={other.id} route={other} size="small" />
              ))}
              {others.length > OTHERS_SHOWN && (
                <span className="route-tip__more">+{others.length - OTHERS_SHOWN}</span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
