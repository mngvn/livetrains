import { useMemo } from 'react';
import type { RouteSummary } from '../lib/api.ts';
import {
  houseColor,
  isTrunkLine,
  STATE_LABEL,
  STATE_ORDER,
  type LineHealth,
  type LineState,
  type NetworkHealth,
} from '../lib/networkHealth.ts';
import { RouteBadge } from './RouteBadge.tsx';

/**
 * The whole network on one board, the way a station's status board shows it:
 * a verdict, then the lines in trouble, then everything else.
 *
 * Named lines — rail, and the branded routes — are always listed, because
 * they are what most riders mean by "the network". The ordinary routes are a
 * grid of plates, each marked with its state, so a hundred routes fit on one
 * screen and the odd one out still jumps out.
 */
export function NetworkStatus({
  health,
  routes,
  onShowRoute,
}: {
  health: NetworkHealth;
  routes: RouteSummary[];
  onShowRoute: (routeId: string) => void;
}) {
  const house = useMemo(() => houseColor(routes), [routes]);
  const { lines, counts, running, vehicles, onTimeShare } = health;

  const trouble = lines.filter((line) => line.state !== 'good' && line.state !== 'quiet');
  const trunk = lines.filter((line) => isTrunkLine(line.route, house) && !trouble.includes(line));
  const others = lines.filter((line) => !isTrunkLine(line.route, house) && line.state === 'good');
  const quiet = lines.filter((line) => line.state === 'quiet' && !trunk.includes(line));

  const good = counts.good;
  const verdict =
    running === 0
      ? 'No routes reporting'
      : trouble.length === 0
        ? `Good service on all ${running} routes`
        : `Good service on ${good} of ${running} routes`;

  return (
    <section className="network" aria-label="Network status">
      <header className="network__head">
        <p className="network__verdict">{verdict}</p>
        <p className="network__sub">
          {vehicles.toLocaleString()} vehicles moving
          {onTimeShare !== null && ` · ${Math.round(onTimeShare * 100)}% within 5 min of the timetable`}
        </p>
        {running > 0 && (
          <div className="network__bar" role="img" aria-label={stateSummary(counts)}>
            {STATE_ORDER.filter((state) => state !== 'quiet' && counts[state] > 0).map((state) => (
              <span
                key={state}
                className={`network__bar-part is-${state}`}
                style={{ flexGrow: counts[state] }}
                title={`${STATE_LABEL[state]}: ${counts[state]}`}
              />
            ))}
          </div>
        )}
      </header>

      {trouble.length > 0 && (
        <div className="network__group">
          <h3 className="panel-section__title">Disruptions</h3>
          <ul className="network__rows">
            {trouble.map((line) => (
              <StatusRow key={line.route.id} line={line} onShowRoute={onShowRoute} />
            ))}
          </ul>
        </div>
      )}

      {trunk.length > 0 && (
        <div className="network__group">
          <h3 className="panel-section__title">Lines</h3>
          <ul className="network__rows">
            {trunk.map((line) => (
              <StatusRow key={line.route.id} line={line} onShowRoute={onShowRoute} />
            ))}
          </ul>
        </div>
      )}

      {others.length > 0 && (
        <div className="network__group">
          <h3 className="panel-section__title">
            Good service <span className="network__count">{others.length} routes</span>
          </h3>
          <PlateGrid lines={others} onShowRoute={onShowRoute} />
        </div>
      )}

      {quiet.length > 0 && (
        <details className="network__group network__quiet">
          <summary className="panel-section__title">
            Not running now <span className="network__count">{quiet.length} routes</span>
          </summary>
          <PlateGrid lines={quiet} onShowRoute={onShowRoute} />
        </details>
      )}
    </section>
  );
}

function StatusRow({ line, onShowRoute }: { line: LineHealth; onShowRoute: (routeId: string) => void }) {
  const detail = line.alert ? line.alert.header : line.reason;
  return (
    <li>
      <button type="button" className={`status-row is-${line.state}`} onClick={() => onShowRoute(line.route.id)}>
        <RouteBadge route={line.route} />
        <span className="status-row__text">
          <span className="status-row__name">{line.route.longName || line.route.shortName}</span>
          {detail && <span className="status-row__detail">{detail}</span>}
        </span>
        <span className="status-row__state">{line.label}</span>
      </button>
    </li>
  );
}

function PlateGrid({ lines, onShowRoute }: { lines: LineHealth[]; onShowRoute: (routeId: string) => void }) {
  return (
    <ul className="plate-grid">
      {lines.map((line) => (
        <li key={line.route.id}>
          <button
            type="button"
            className={`plate-grid__item is-${line.state}`}
            onClick={() => onShowRoute(line.route.id)}
            title={`${line.route.shortName} ${line.route.longName}: ${line.label}${line.reason ? ` — ${line.reason}` : ''}`}
          >
            <RouteBadge route={line.route} size="small" />
          </button>
        </li>
      ))}
    </ul>
  );
}

function stateSummary(counts: Record<LineState, number>): string {
  return STATE_ORDER.filter((state) => state !== 'quiet' && counts[state] > 0)
    .map((state) => `${counts[state]} ${STATE_LABEL[state].toLowerCase()}`)
    .join(', ');
}
