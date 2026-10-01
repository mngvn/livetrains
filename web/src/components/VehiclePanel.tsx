import { useState, type CSSProperties } from 'react';
import type { RouteSummary, TripStop, Vehicle, VehicleTrip } from '../lib/api.ts';
import { sortAlerts } from '../lib/alerts.ts';
import { countdown, delayText, modeLabel, occupancyLabel, relativeAge } from '../lib/format.ts';
import { AccessibilityTag } from './AccessibilityTag.tsx';
import { AlertCard } from './AlertCard.tsx';
import { RouteBadge } from './RouteBadge.tsx';
import { ScheduleTime } from './ScheduleTime.tsx';

/** How many stops ahead to show before "show all". */
const STOPS_AHEAD = 8;

/**
 * The selected vehicle: who runs it, how late it is, and where it goes next.
 *
 * The position alone says little — a dot, a colour, a heading. The trip is
 * what makes it useful: the stops ahead with their scheduled and predicted
 * times, so a rider watching a bus crawl toward them can see when it will
 * actually arrive at *their* stop, not just that it is late somewhere.
 */
export function VehiclePanel({
  vehicle,
  trip,
  tripLoading,
  now,
  routes,
  onShowStop,
  onShowRoute,
  ride,
  onRide,
}: {
  vehicle: Vehicle;
  trip: VehicleTrip | null;
  tripLoading: boolean;
  now: number;
  routes: Map<string, RouteSummary>;
  onShowStop: (stopId: string) => void;
  onShowRoute: (routeId: string) => void;
  /** Whether you are riding this vehicle, and where you are getting off. */
  ride: { stopId: string | null } | null;
  /** Start riding, change your stop, or (with null) stop riding. */
  onRide: (alightStopId: string | null | false) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const delay = delayText(vehicle.delaySeconds);
  const occupancy = occupancyLabel(vehicle.occupancy);
  const route: RouteSummary = trip?.route ?? {
    id: vehicle.routeId ?? '',
    shortName: vehicle.routeShortName ?? '—',
    longName: '',
    mode: vehicle.mode,
    color: vehicle.color,
    textColor: 'FFFFFF',
  };

  const next = trip ? trip.stops[trip.nextStopIndex] : undefined;
  const ahead = trip ? trip.stops.slice(trip.nextStopIndex) : [];
  const shown = showAll ? ahead : ahead.slice(0, STOPS_AHEAD);
  const alerts = trip ? sortAlerts(trip.alerts, now) : [];

  return (
    <div className="vehicle-panel">
      <header className="panel-header">
        <div className="vehicle-panel__title">
          <RouteBadge route={route} />
          <div>
            <h2 className="panel-title">{trip?.headsign ?? vehicle.headsign ?? modeLabel(vehicle.mode)}</h2>
            <p className="panel-subtitle">
              {modeLabel(vehicle.mode)} {vehicle.id}
              {route.operator && <> · Operated by {route.operator.name}</>}
            </p>
          </div>
        </div>
      </header>

      {next && <p className="vehicle-panel__where">{whereNow(vehicle, next)}</p>}

      <div className="vehicle-panel__tags">
        {vehicle.delaySeconds !== undefined && (
          <span className={`delay-tag delay-tag--${delay.tone}`}>{delay.label}</span>
        )}
        <AccessibilityTag value={vehicle.wheelchair} subject="trip" />
        {occupancy && <span className="fact-tag">{occupancy}</span>}
        {vehicle.speed !== undefined && vehicle.speed > 0.5 && (
          <span className="fact-tag">{Math.round(vehicle.speed * 2.237)} mph</span>
        )}
        <span className="fact-tag fact-tag--muted">Position {relativeAge(vehicle.timestamp)}</span>
      </div>

      <div className="panel-actions">
        {trip && (
          <button
            type="button"
            className={`chip${ride ? '' : ' chip--primary'}`}
            aria-pressed={Boolean(ride)}
            onClick={() => onRide(ride ? false : null)}
          >
            {ride ? 'Stop riding' : `Ride this ${modeLabel(vehicle.mode).toLowerCase()}`}
          </button>
        )}
        {route.id && (
          <button type="button" className="chip" onClick={() => onShowRoute(route.id)}>
            Whole route {route.shortName}
          </button>
        )}
      </div>
      {ride && !ride.stopId && trip && (
        <p className="vehicle-panel__ride-hint">Where are you getting off? Choose a stop below.</p>
      )}

      {alerts.length > 0 && (
        <section className="panel-section" aria-label="Alerts for this route">
          <div className="alerts">
            {alerts.slice(0, 3).map((alert) => (
              <AlertCard key={alert.id} alert={alert} now={now} routes={routes} onShowRoute={onShowRoute} />
            ))}
          </div>
          {alerts.length > 3 && (
            <button type="button" className="text-button" onClick={() => onShowRoute(route.id)}>
              {alerts.length - 3} more alerts on this route
            </button>
          )}
        </section>
      )}

      <section className="panel-section">
        <h3 className="panel-section__title">Stops ahead</h3>
        {!trip && tripLoading && <p className="panel-loading">Loading its stops…</p>}
        {!trip && !tripLoading && (
          <p className="panel-empty">This vehicle is not reporting a trip, so its stops are not known.</p>
        )}
        {trip && (
          <ol className="trip-stops" style={{ '--route-color': `#${vehicle.color}` } as CSSProperties}>
            {shown.map((stop, index) => (
              <TripStopRow
                key={`${stop.stop.id}-${stop.scheduledTime}`}
                stop={stop}
                isNext={index === 0}
                now={now}
                onShow={() => onShowStop(stop.stop.id)}
                riding={Boolean(ride)}
                mine={ride?.stopId === stop.stop.id}
                onChoose={() => onRide(stop.stop.id)}
              />
            ))}
          </ol>
        )}
        {trip && ahead.length > STOPS_AHEAD && (
          <button type="button" className="text-button" onClick={() => setShowAll((value) => !value)}>
            {showAll ? 'Show fewer stops' : `Show all ${ahead.length} stops ahead`}
          </button>
        )}
      </section>
    </div>
  );
}

function TripStopRow({
  stop,
  isNext,
  now,
  onShow,
  riding,
  mine,
  onChoose,
}: {
  stop: TripStop;
  isNext: boolean;
  now: number;
  onShow: () => void;
  /** While riding, every stop offers itself as the one to get off at. */
  riding: boolean;
  mine: boolean;
  onChoose: () => void;
}) {
  const at = stop.predictedTime ?? stop.scheduledTime;
  return (
    <li className={`trip-stop${isNext ? ' is-next' : ''}${stop.skipped ? ' is-skipped' : ''}${mine ? ' is-mine' : ''}`}>
      <button type="button" className="trip-stop__button" onClick={onShow}>
        <span className="trip-stop__dot" aria-hidden="true" />
        <span className="trip-stop__text">
          <span className="trip-stop__name">{stop.stop.name}</span>
          <ScheduleTime
            scheduled={stop.scheduledTime}
            predicted={at}
            delaySeconds={stop.delaySeconds}
            isRealtime={stop.predictedTime !== null}
            skipped={stop.skipped}
          />
        </span>
        {!stop.skipped && <span className="trip-stop__countdown">{countdown(at, now)}</span>}
      </button>
      {riding && !stop.skipped && (
        <button
          type="button"
          className="trip-stop__choose"
          aria-pressed={mine}
          onClick={onChoose}
          title={mine ? 'Your stop' : 'Get off here'}
        >
          {mine ? 'Your stop' : 'Get off here'}
        </button>
      )}
    </li>
  );
}

/** "Stopped at Lake St", "Arriving at Lake St", "Next stop Lake St". */
function whereNow(vehicle: Vehicle, next: TripStop): string {
  const reported = vehicle.stopId === next.stop.id;
  if (reported && vehicle.currentStatus === 'stopped') return `Stopped at ${next.stop.name}`;
  if (reported && vehicle.currentStatus === 'incoming') return `Arriving at ${next.stop.name}`;
  return `Next stop: ${next.stop.name}`;
}
