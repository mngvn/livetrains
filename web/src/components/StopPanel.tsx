import { useCallback, useEffect, useRef, useState } from 'react';
import type { PathwaySummary, RouteSummary, StopDetail } from '../lib/api.ts';
import { isAccessibilityAlert, sortAlerts } from '../lib/alerts.ts';
import { relativeAge } from '../lib/format.ts';
import { AlertCard } from './AlertCard.tsx';
import { RouteBadge } from './RouteBadge.tsx';
import { AccessibilityTag } from './AccessibilityTag.tsx';
import { ShareButton } from './ShareButton.tsx';
import { DepartureBoard } from './DepartureBoard.tsx';
import { shareUrl } from '../lib/shareLink.ts';

/**
 * How often an open board refreshes. Predictions move on the scale of the
 * feed (15–30 s); this is a board someone leaves open while they wait.
 */
const REFRESH_MS = 30_000;

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
 * Loads the full day's board when opened and refreshes it every 30 seconds
 * while it stays open. Choosing another stop updates the panel in place: the
 * previous stop stays on screen, dimmed, until the new one has loaded, rather
 * than the panel blanking and redrawing.
 */
export function StopPanel({
  stopId,
  now,
  load,
  routes,
  onPlanFromHere,
  onPlanToHere,
  onShowRoute,
  onShowVehicle,
  onRoutesLoaded,
  onLoaded,
}: {
  stopId: string;
  now: number;
  /** Supplied by the app so this works against either backend. */
  load: (stopId: string, signal?: AbortSignal) => Promise<StopDetail>;
  /** Every route, for drawing badges on alerts. */
  routes: Map<string, RouteSummary>;
  onPlanFromHere: (detail: StopDetail) => void;
  onPlanToHere: (detail: StopDetail) => void;
  onShowRoute: (routeId: string) => void;
  /** Opens a vehicle in the panel; its route, so the map can be made to show it. */
  onShowVehicle: (vehicleId: string, routeId?: string) => void;
  /** Tells the map which lines to light up; null when the panel closes. */
  onRoutesLoaded: (routeIds: string[] | null) => void;
  /** The stop's own record once known, for the map pin. */
  onLoaded?: (detail: StopDetail) => void;
}) {
  const [detail, setDetail] = useState<StopDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const controller = useRef<AbortController | null>(null);
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  const refresh = useCallback(() => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setRefreshing(true);
    load(stopId, current.signal)
      .then((result) => {
        if (current.signal.aborted) return;
        setDetail(result);
        setError(null);
        setUpdatedAt(Date.now() / 1000);
        onLoadedRef.current?.(result);
      })
      .catch((err: unknown) => {
        if (current.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        setError(err instanceof Error ? err.message : 'Could not load departures');
      })
      .finally(() => {
        if (!current.signal.aborted) setRefreshing(false);
      });
  }, [stopId, load]);

  // On open, and every half minute while open. A new stop restarts both.
  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);
    return () => {
      window.clearInterval(timer);
      controller.current?.abort();
    };
  }, [refresh]);

  // Light up the lines through this stop, and put the map back on close.
  const routeKey = detail?.stop.id === stopId ? detail.routes.map((r) => r.id).join(',') : '';
  useEffect(() => {
    if (routeKey) onRoutesLoaded(routeKey.split(','));
  }, [routeKey, onRoutesLoaded]);
  useEffect(() => () => onRoutesLoaded(null), [onRoutesLoaded]);

  if (!detail) {
    if (error) return <div className="panel-error">{error}</div>;
    return <div className="panel-loading">Loading departures…</div>;
  }

  // Still showing the previous stop while the chosen one loads.
  const stale = detail.stop.id !== stopId && !detail.groupedStopIds.includes(stopId);
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
    <div className={`stop-panel${stale ? ' is-stale' : ''}`} aria-busy={stale || undefined}>
      <header className="panel-header">
        <div className="panel-header__text">
          <h2 className="panel-title">{stop.name}</h2>
          <p className="panel-subtitle">{facts.join(' · ')}</p>
          {station && station.name !== stop.name && <p className="panel-subtitle">In {station.name}</p>}
          {stop.description && <p className="panel-subtitle">{stop.description}</p>}
        </div>
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

      <p className="board__updated" role="status">
        {error ? (
          <span className="board__updated-error">Could not refresh — showing the last board.</span>
        ) : (
          <>Updated {updatedAt ? relativeAge(Math.floor(updatedAt)) : 'just now'} · refreshes every 30 s</>
        )}
        <button
          type="button"
          className={`icon-button board__refresh${refreshing ? ' is-spinning' : ''}`}
          onClick={refresh}
          aria-label="Refresh departures"
          title="Refresh now"
        >
          ↻
        </button>
      </p>

      <DepartureBoard
        // Keyed on the whole group, so a filter set on a station is the same
        // filter whichever of its platforms is opened next time.
        stopId={[...detail.groupedStopIds].sort()[0] ?? detail.stop.id}
        departures={detail.departures}
        routes={detail.routes}
        now={now}
        onShowVehicle={onShowVehicle}
      />

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
