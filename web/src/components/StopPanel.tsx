import { useEffect, useState } from 'react';
import { api, type Departure, type RouteSummary, type StopDetail } from '../lib/api.ts';
import { clockTime, countdown, delayText, modeLabel } from '../lib/format.ts';
import { RouteBadge } from './RouteBadge.tsx';

/**
 * The departure board for a stop.
 *
 * Refreshes on its own timer rather than waiting for the vehicle stream:
 * predictions change even when no vehicle has moved far enough to be worth
 * re-broadcasting, and a stale countdown is worse than no countdown.
 */
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

export function StopPanel({
  stopId,
  now,
  onPlanFromHere,
  onPlanToHere,
  onClose,
}: {
  stopId: string;
  now: number;
  onPlanFromHere: (detail: StopDetail) => void;
  onPlanToHere: (detail: StopDetail) => void;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<StopDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const load = () => {
      api
        .stop(stopId, 12, controller.signal)
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
    load();
    const timer = window.setInterval(load, 20_000);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [stopId]);

  if (loading && !detail) return <div className="panel-loading">Loading departures…</div>;
  if (error && !detail) return <div className="panel-error">{error}</div>;
  if (!detail) return null;

  return (
    <div className="stop-panel">
      <header className="panel-header">
        <div>
          <h2 className="panel-title">{detail.stop.name}</h2>
          <p className="panel-subtitle">
            Stop {detail.stop.code}
            {detail.groupedStopIds.length > 1 && ` · ${detail.groupedStopIds.length} platforms`}
          </p>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>

      <div className="panel-actions">
        <button type="button" className="chip" onClick={() => onPlanFromHere(detail)}>
          Start here
        </button>
        <button type="button" className="chip chip--primary" onClick={() => onPlanToHere(detail)}>
          Go here
        </button>
      </div>

      {detail.alerts.length > 0 && (
        <div className="alerts">
          {detail.alerts.map((alert) => (
            <details key={alert.id} className="alert">
              <summary>{alert.header}</summary>
              <p>{alert.description}</p>
            </details>
          ))}
        </div>
      )}

      {detail.departures.length === 0 ? (
        <p className="panel-empty">
          No departures in the next few hours. Service may have finished for the night.
        </p>
      ) : (
        <ul className="departures">
          {detail.departures.map((departure) => {
            const delay = delayText(departure.delaySeconds);
            return (
              <li key={`${departure.tripId}-${departure.scheduledTime}`} className="departure">
                <RouteBadge route={routeOf(departure)} />
                <div className="departure__text">
                  <span className="departure__headsign">{departure.headsign}</span>
                  <span className="departure__meta">
                    {modeLabel(departure.mode)} · {clockTime(departure.scheduledTime)}
                    {departure.isRealtime && (
                      <span className={`delay-tag delay-tag--${delay.tone}`}>{delay.label}</span>
                    )}
                  </span>
                </div>
                <div className={`departure__countdown${departure.isRealtime ? ' is-live' : ''}`}>
                  {countdown(departure.expectedTime, now)}
                  {departure.isRealtime && <span className="live-dot" title="Live prediction" />}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
