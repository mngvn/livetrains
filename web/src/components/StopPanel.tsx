import { useEffect, useState } from 'react';
import type { Departure, PathwaySummary, RouteSummary, StopDetail } from '../lib/api.ts';
import { isAccessibilityAlert, sortAlerts } from '../lib/alerts.ts';
import { countdown, modeLabel } from '../lib/format.ts';
import { AlertCard } from './AlertCard.tsx';
import { RouteBadge } from './RouteBadge.tsx';
import { ScheduleTime } from './ScheduleTime.tsx';
import { AccessibilityTag } from './AccessibilityTag.tsx';
import { ShareButton } from './ShareButton.tsx';
import { shareUrl } from '../lib/shareLink.ts';

/** A departure carries its route's display fields inline; rebuild the badge's view of it. */
function routeOf(departure: Departure): RouteSummary {
  return {
    id: departure.routeId,
    shortName: departure.routeShortName,
    longName: departure.headsign,
    mode: departure.mode,
    color: departure.color,
    textColor: departure.textColor,
  };
}

const PATHWAY_LABEL: Record<PathwaySummary['mode'], string> = {
  walkway: 'Walkway',
  stairs: 'Stairs',
  'moving-sidewalk': 'Moving walkway',
  escalator: 'Escalator',
  elevator: 'Elevator',
  'fare-gate': 'Fare gate',
  'exit-gate': 'Exit gate',
};

/** Step-free ways first: they are the ones some riders cannot do without. */
const PATHWAY_ORDER: PathwaySummary['mode'][] = [
  'elevator',
  'moving-sidewalk',
  'walkway',
  'escalator',
  'stairs',
  'fare-gate',
  'exit-gate',
];

/**
 * Everything about one stop: what calls here, when, and how to get on.
 *
 * Refreshes on its own timer rather than waiting for the vehicle stream:
 * predictions change even when no vehicle has moved far enough to be worth
 * re-broadcasting, and a stale countdown is worse than no countdown.
 */
export function StopPanel({
  stopId,
  now,
  load,
  routes,
  onPlanFromHere,
  onPlanToHere,
  onShowRoute,
  onRoutesLoaded,
  onClose,
}: {
  stopId: string;
  now: number;
  /** Supplied by the app so this works against either backend. */
  load: (stopId: string, limit?: number, signal?: AbortSignal) => Promise<StopDetail>;
  /** Every route, for drawing badges on alerts. */
  routes: Map<string, RouteSummary>;
  onPlanFromHere: (detail: StopDetail) => void;
  onPlanToHere: (detail: StopDetail) => void;
  onShowRoute: (routeId: string) => void;
  /** Tells the map which lines to light up; null when the panel closes. */
  onRoutesLoaded: (routeIds: string[] | null) => void;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<StopDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const refresh = () => {
      load(stopId, 12, controller.signal)
        .then((result) => {
          if (cancelled) return;
          setDetail(result);
          setError(null);
        })
        .catch((err: unknown) => {
          if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
          setError(err instanceof Error ? err.message : 'Could not load departures');
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };

    setLoading(true);
    setDetail(null);
    refresh();
    const timer = window.setInterval(refresh, 20_000);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [stopId, load]);

  // Light up the lines through this stop, and put the map back on close.
  const routeKey = detail?.routes.map((r) => r.id).join(',') ?? '';
  useEffect(() => {
    if (routeKey) onRoutesLoaded(routeKey.split(','));
  }, [routeKey, onRoutesLoaded]);
  useEffect(() => () => onRoutesLoaded(null), [onRoutesLoaded]);

  if (loading && !detail) return <div className="panel-loading">Loading departures…</div>;
  if (error && !detail) return <div className="panel-error">{error}</div>;
  if (!detail) return null;

  const { stop, station } = detail;
  const alerts = sortAlerts(detail.alerts, now);
  const accessAlerts = alerts.filter(isAccessibilityAlert);
  const facts = [
    stop.code ? `Stop ${stop.code}` : null,
    stop.platformCode ? `Platform ${stop.platformCode}` : null,
    detail.groupedStopIds.length > 1 ? `${detail.groupedStopIds.length} platforms` : null,
  ].filter(Boolean);
  const pathways = [...(station?.pathways ?? [])].sort(
    (a, b) => PATHWAY_ORDER.indexOf(a.mode) - PATHWAY_ORDER.indexOf(b.mode),
  );

  return (
    <div className="stop-panel">
      <header className="panel-header">
        <div className="panel-header__text">
          <h2 className="panel-title">{stop.name}</h2>
          <p className="panel-subtitle">{facts.join(' · ')}</p>
          {station && station.name !== stop.name && <p className="panel-subtitle">In {station.name}</p>}
          {stop.description && <p className="panel-subtitle">{stop.description}</p>}
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>

      <div className="stop-panel__tags">
        <AccessibilityTag value={stop.wheelchair} subject="stop" />
      </div>

      <div className="panel-actions">
        <button type="button" className="chip" onClick={() => onPlanFromHere(detail)}>
          Start here
        </button>
        <button type="button" className="chip chip--primary" onClick={() => onPlanToHere(detail)}>
          Go here
        </button>
        <ShareButton url={shareUrl({ stop: stop.id })} title={`${stop.name} — live departures`} />
      </div>

      {alerts.length > 0 && (
        <section className="panel-section" aria-label="Service alerts">
          <div className="alerts">
            {alerts.map((alert) => (
              <AlertCard key={alert.id} alert={alert} now={now} routes={routes} onShowRoute={onShowRoute} />
            ))}
          </div>
        </section>
      )}

      {detail.routes.length > 0 && (
        <section className="panel-section">
          <h3 className="panel-section__title">Lines here</h3>
          <div className="stop-panel__routes">
            {detail.routes.map((route) => (
              <button
                key={route.id}
                type="button"
                className="stop-panel__route"
                onClick={() => onShowRoute(route.id)}
                title={`${route.longName || route.shortName}${route.operator ? ` · ${route.operator.name}` : ''}`}
              >
                <RouteBadge route={route} />
              </button>
            ))}
          </div>
          <OperatorLine routes={detail.routes} />
        </section>
      )}

      {pathways.length > 0 && (
        <section className="panel-section">
          <h3 className="panel-section__title">Getting to the platform</h3>
          {accessAlerts.length > 0 && (
            <p className="stop-panel__access-warning" role="status">
              Step-free access is affected here — see the alert above.
            </p>
          )}
          <ul className="pathways">
            {pathways.map((pathway, index) => (
              <li key={`${pathway.mode}-${index}`} className={`pathway pathway--${pathway.mode}`}>
                <span className="pathway__mode">{PATHWAY_LABEL[pathway.mode]}</span>
                <span className="pathway__description">
                  {pathway.description}
                  {pathway.stairCount ? ` · ${pathway.stairCount} steps` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel-section">
        <h3 className="panel-section__title">Departures</h3>
        {detail.departures.length === 0 ? (
          <p className="panel-empty">
            No departures in the next few hours. Service may have finished for the night.
          </p>
        ) : (
          <ul className="departures">
            {detail.departures.map((departure) => (
              <li
                key={`${departure.tripId}-${departure.scheduledTime}`}
                className={`departure${departure.skipped ? ' is-skipped' : ''}`}
              >
                <RouteBadge route={routeOf(departure)} />
                <div className="departure__text">
                  <span className="departure__headsign">{departure.headsign}</span>
                  <span className="departure__meta">
                    {modeLabel(departure.mode)}
                    <ScheduleTime
                      scheduled={departure.scheduledTime}
                      predicted={departure.expectedTime}
                      delaySeconds={departure.delaySeconds}
                      isRealtime={departure.isRealtime}
                      skipped={departure.skipped}
                    />
                    {departure.wheelchair === 'not-accessible' && (
                      <AccessibilityTag value="not-accessible" subject="trip" compact />
                    )}
                  </span>
                </div>
                <div className={`departure__countdown${departure.isRealtime ? ' is-live' : ''}`}>
                  {departure.skipped ? '—' : countdown(departure.expectedTime, now)}
                  {departure.isRealtime && !departure.skipped && (
                    <span className="live-dot" title="Live prediction" />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * Who runs the lines here, when that is not one agency.
 *
 * Only said when it is informative: at a stop served by a single operator,
 * "Operated by Metro Transit" is noise; at a park-and-ride shared with
 * SouthWest Transit it tells a rider whose pass works on which bus.
 */
function OperatorLine({ routes }: { routes: RouteSummary[] }) {
  const byOperator = new Map<string, string[]>();
  for (const route of routes) {
    if (!route.operator) continue;
    const list = byOperator.get(route.operator.name) ?? [];
    list.push(route.shortName);
    byOperator.set(route.operator.name, list);
  }
  if (byOperator.size < 2) return null;
  return (
    <p className="stop-panel__operators">
      {[...byOperator].map(([name, lines]) => `${lines.join(', ')}: ${name}`).join(' · ')}
    </p>
  );
}
