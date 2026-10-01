import { Fragment, useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { Departure, RouteSummary } from '../lib/api.ts';
import {
  applyFilter,
  isFiltered,
  kindOf,
  loadFilter,
  NO_FILTER,
  reconcile,
  saveFilter,
  toggle,
  type BoardFilter,
  type VehicleKind,
} from '../lib/boardFilter.ts';
import { clockTime, modeLabel } from '../lib/format.ts';
import { AccessibilityTag } from './AccessibilityTag.tsx';
import { RouteBadge } from './RouteBadge.tsx';
import { ScheduleTime } from './ScheduleTime.tsx';

/** Countdowns up to this far out; clock times beyond, which are easier to plan around. */
const COUNTDOWN_UNTIL_SECONDS = 60 * 60;

const KIND_LABEL: Record<VehicleKind, string> = { train: 'Trains', bus: 'Buses', other: 'Other' };

/**
 * Every departure left today from one stop, in the order they leave.
 *
 * Not grouped by route: at a busy stop the question is "what is next", and
 * the answer is whichever route that happens to be. Hour markers break up a
 * long evening without reordering anything.
 *
 * Live predictions and timetable times look different on purpose. A live
 * row has a filled stop on the spine and a pulsing "Live" mark; a timetable
 * row a hollow one and the word "Timetable". Someone deciding whether to run
 * for the bus needs to know which kind of number they are looking at.
 *
 * The rows hang off a spine, each segment in its route's own colour, the way
 * a line diagram strings stops along a route.
 */

/** Up and down arrows walk the list, one departure at a time. */
function moveThroughRows(event: KeyboardEvent<HTMLOListElement>): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('.board-row__button')];
  if (rows.length === 0) return;
  const current = rows.indexOf(document.activeElement as HTMLElement);
  const next =
    current === -1
      ? event.key === 'ArrowDown'
        ? 0
        : rows.length - 1
      : Math.max(0, Math.min(rows.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)));
  event.preventDefault();
  rows[next].focus();
  rows[next].scrollIntoView({ block: 'nearest' });
}
export function DepartureBoard({
  stopId,
  departures,
  routes,
  now,
  onShowVehicle,
}: {
  stopId: string;
  departures: Departure[];
  /** Every route that calls here, for the filter chips. */
  routes: RouteSummary[];
  now: number;
  onShowVehicle: (vehicleId: string, routeId?: string) => void;
}) {
  const [filter, setFilter] = useState<BoardFilter>(() => loadFilter(stopId));
  useEffect(() => setFilter(loadFilter(stopId)), [stopId]);

  const routeIds = useMemo(() => routes.map((r) => r.id), [routes]);
  // A remembered route that no longer calls here is quietly let go.
  const effective = useMemo(() => reconcile(filter, routeIds), [filter, routeIds]);

  const update = (next: BoardFilter) => {
    setFilter(next);
    saveFilter(stopId, next);
  };

  const kinds = useMemo(() => [...new Set(routes.map((r) => kindOf(r.mode)))].sort(), [routes]);
  const shown = useMemo(() => applyFilter(departures, effective), [departures, effective]);
  const liveCount = shown.filter((d) => d.isRealtime && !d.cancelled).length;

  return (
    <section className="panel-section board" aria-label="Departures">
      <div className="board__head">
        <h3 className="panel-section__title">Departures today</h3>
        <span className="board__count">
          {shown.length === 0
            ? ''
            : `${shown.length} left${liveCount > 0 ? ` · ${liveCount} live` : ''}`}
        </span>
      </div>

      {(routes.length > 1 || kinds.length > 1) && (
        <div className="board__filters" role="group" aria-label="Show departures for">
          <button
            type="button"
            className="chip"
            aria-pressed={!isFiltered(effective)}
            onClick={() => update(NO_FILTER)}
          >
            All
          </button>
          {kinds.length > 1 &&
            kinds.map((kind) => (
              <button
                key={kind}
                type="button"
                className="chip"
                aria-pressed={effective.kinds.includes(kind)}
                onClick={() => update({ ...effective, kinds: toggle(effective.kinds, kind) })}
              >
                {KIND_LABEL[kind]}
              </button>
            ))}
          {routes.length > 1 &&
            routes.map((route) => (
              <button
                key={route.id}
                type="button"
                className="board__route-chip"
                aria-pressed={effective.routes.includes(route.id)}
                aria-label={`Only route ${route.shortName}`}
                title={`Show only ${route.shortName}${effective.routes.length > 0 ? ' (tap again to remove)' : ''}`}
                onClick={() => update({ ...effective, routes: toggle(effective.routes, route.id) })}
              >
                <RouteBadge route={route} size="small" />
              </button>
            ))}
        </div>
      )}

      {shown.length === 0 ? (
        <p className="panel-empty">
          {departures.length === 0
            ? 'No more departures from here today. Service may have finished for the night.'
            : 'Nothing left today for the routes chosen. Tap All to see every route.'}
        </p>
      ) : (
        <ol className="board__list" onKeyDown={moveThroughRows}>
          {shown.map((departure, index) => {
            const previous = index > 0 ? shown[index - 1] : null;
            const hour = hourOf(departure.expectedTime);
            // A marker each time the hour turns, once the list is past the
            // first hour: enough to find "after 9" in a long evening.
            const marker =
              previous && hourOf(previous.expectedTime) !== hour && departure.expectedTime - now > COUNTDOWN_UNTIL_SECONDS / 2
                ? hourLabel(departure.expectedTime)
                : null;
            return (
              <Fragment key={`${departure.tripId}-${departure.scheduledTime}`}>
                {marker && (
                  <li className="board__hour" aria-hidden="true">
                    {marker}
                  </li>
                )}
                <BoardRow departure={departure} now={now} onShowVehicle={onShowVehicle} />
              </Fragment>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function BoardRow({
  departure,
  now,
  onShowVehicle,
}: {
  departure: Departure;
  now: number;
  onShowVehicle: (vehicleId: string, routeId?: string) => void;
}) {
  const { cancelled, atStop, skipped } = departure;
  const live = departure.isRealtime && !cancelled;
  const state = cancelled ? 'is-cancelled' : skipped ? 'is-skipped' : atStop ? 'is-at-stop' : live ? 'is-live' : 'is-timetable';
  const route: RouteSummary = {
    id: departure.routeId,
    shortName: departure.routeShortName,
    longName: departure.headsign,
    mode: departure.mode,
    color: departure.color,
    textColor: departure.textColor,
  };

  const body = (
    <>
      <span className="board-row__spine" aria-hidden="true">
        <span className="board-row__node" />
      </span>
      <span className="board-row__when">
        {cancelled || skipped ? (
          <s>{clockTime(departure.scheduledTime)}</s>
        ) : atStop ? (
          <span className="board-row__at-stop">At stop now</span>
        ) : (
          <When at={departure.expectedTime} now={now} />
        )}
      </span>
      <RouteBadge route={route} />
      <span className="board-row__text">
        <span className="board-row__headsign">{departure.headsign}</span>
        <span className="board-row__meta">
          {cancelled ? (
            <span className="board-row__flag board-row__flag--cancelled">
              <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
                <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
                <path d="M2.8 9.2 9.2 2.8" stroke="currentColor" strokeWidth="1.6" />
              </svg>
              Cancelled
            </span>
          ) : live ? (
            <span className="board-row__flag board-row__flag--live">
              <span className="board-row__pulse" aria-hidden="true" />
              Live
            </span>
          ) : (
            !skipped && <span className="board-row__flag board-row__flag--timetable">Timetable</span>
          )}
          {/* The timetable time is already in the time column; only a live
              row has a second time, or a delay, worth spelling out. */}
          {(live || skipped) && (
            <ScheduleTime
              scheduled={departure.scheduledTime}
              predicted={departure.expectedTime}
              delaySeconds={departure.delaySeconds}
              isRealtime={departure.isRealtime}
              skipped={skipped}
            />
          )}
          {cancelled && <span>{modeLabel(departure.mode)} · not running</span>}
          {departure.wheelchair === 'not-accessible' && !cancelled && (
            <AccessibilityTag value="not-accessible" subject="trip" compact />
          )}
        </span>
      </span>
    </>
  );

  // A live row with a vehicle opens that vehicle, in the same panel.
  return (
    <li className={`board-row ${state}`} style={{ '--route-color': `#${departure.color}` } as CSSProperties}>
      {departure.vehicleId && !cancelled ? (
        <button
          type="button"
          className="board-row__button"
          onClick={() => onShowVehicle(departure.vehicleId!, departure.routeId)}
          title="Show this vehicle"
        >
          {body}
        </button>
      ) : (
        // Not a link anywhere, but still a stop on the arrow keys' walk.
        <div className="board-row__button" tabIndex={-1}>
          {body}
        </div>
      )}
    </li>
  );
}

/** "Due", "4 min", or a clock time once it is more than an hour off. */
function When({ at, now }: { at: number; now: number }) {
  const seconds = at - now;
  if (seconds >= COUNTDOWN_UNTIL_SECONDS) return <span className="board-row__clock">{clockTime(at)}</span>;
  return (
    <>
      <span className="board-row__countdown">{seconds < 30 ? 'Due' : `${Math.round(seconds / 60)} min`}</span>
      <span className="board-row__clock board-row__clock--small">{clockTime(at)}</span>
    </>
  );
}

function hourOf(epochSeconds: number): number {
  return new Date(epochSeconds * 1000).getHours();
}

function hourLabel(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString(undefined, { hour: 'numeric' });
}
