import type { Itinerary, Leg } from '../lib/api.ts';
import { clockTime, countdown, delayText, distance, duration, modeLabel } from '../lib/format.ts';
import { RouteBadge } from './RouteBadge.tsx';

/**
 * Renders one planned trip.
 *
 * The summary line answers "when do I leave and when do I arrive"; the expanded
 * view answers "what exactly do I do". Realtime is surfaced per leg rather than
 * once for the trip, because a rider needs to know *which* vehicle is late.
 */

interface SummaryProps {
  itinerary: Itinerary;
  selected: boolean;
  now: number;
  onSelect: () => void;
}

export function ItinerarySummary({ itinerary, selected, now, onSelect }: SummaryProps) {
  const transitLegs = itinerary.legs.filter((leg) => leg.type === 'transit');
  const walkOnly = transitLegs.length === 0;

  return (
    <button
      type="button"
      className={`itinerary-summary${selected ? ' is-selected' : ''}`}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <div className="itinerary-summary__top">
        <span className="itinerary-summary__leave">
          {walkOnly ? 'Walk' : `Leave ${clockTime(itinerary.departureTime)}`}
        </span>
        <span className="itinerary-summary__duration">{duration(itinerary.durationSeconds)}</span>
      </div>

      <div className="itinerary-summary__legs">
        {walkOnly ? (
          <span className="leg-chip leg-chip--walk">
            Walk {distance(itinerary.walkDistanceMeters)}
          </span>
        ) : (
          transitLegs.map((leg, index) => (
            <span key={`${leg.type}-${index}`} className="itinerary-summary__leg">
              {index > 0 && <span className="itinerary-summary__arrow" aria-hidden="true">›</span>}
              {leg.type === 'transit' && <RouteBadge route={leg.route} />}
            </span>
          ))
        )}
      </div>

      <div className="itinerary-summary__bottom">
        <span>
          Arrive {clockTime(itinerary.arrivalTime)}
          {!walkOnly && ` · ${itinerary.transfers} transfer${itinerary.transfers === 1 ? '' : 's'}`}
        </span>
        <span className="itinerary-summary__walk">
          {distance(itinerary.walkDistanceMeters)} walk
          {itinerary.hasRealtime && <span className="live-dot" title="Includes live data" />}
        </span>
      </div>

      {!walkOnly && (
        <div className="itinerary-summary__countdown">
          Departs in {countdown(itinerary.departureTime, now)}
        </div>
      )}
    </button>
  );
}

interface DetailProps {
  itinerary: Itinerary;
  now: number;
  onShowVehicle: (vehicleId: string) => void;
  onShowStop: (stopId: string) => void;
}

export function ItineraryDetail({ itinerary, now, onShowVehicle, onShowStop }: DetailProps) {
  return (
    <ol className="itinerary-detail">
      {itinerary.legs.map((leg, index) => (
        <LegRow
          key={`${leg.type}-${index}`}
          leg={leg}
          now={now}
          onShowVehicle={onShowVehicle}
          onShowStop={onShowStop}
        />
      ))}
      <li className="leg leg--end">
        <div className="leg__rail">
          <span className="leg__dot leg__dot--end" />
        </div>
        <div className="leg__body">
          <div className="leg__time">{clockTime(itinerary.arrivalTime)}</div>
          <div className="leg__title">Arrive at your destination</div>
        </div>
      </li>
    </ol>
  );
}

function LegRow({
  leg,
  now,
  onShowVehicle,
  onShowStop,
}: {
  leg: Leg;
  now: number;
  onShowVehicle: (vehicleId: string) => void;
  onShowStop: (stopId: string) => void;
}) {
  if (leg.type === 'walk') {
    return (
      <li className="leg leg--walk">
        <div className="leg__rail">
          <span className="leg__dot" />
          <span className="leg__line leg__line--dashed" />
        </div>
        <div className="leg__body">
          <div className="leg__time">{clockTime(leg.departureTime)}</div>
          <div className="leg__title">
            Walk {distance(leg.distanceMeters)} · {duration(leg.durationSeconds)}
          </div>
          <div className="leg__detail">to {leg.to.name}</div>
        </div>
      </li>
    );
  }

  const delay = delayText(leg.delaySeconds);
  const departsIn = countdown(leg.departureTime, now);

  return (
    <li className="leg leg--transit">
      <div className="leg__rail">
        <span className="leg__dot leg__dot--board" style={{ borderColor: `#${leg.route.color}` }} />
        <span className="leg__line" style={{ background: `#${leg.route.color}` }} />
      </div>
      <div className="leg__body">
        <div className="leg__time">
          {clockTime(leg.departureTime)}
          {leg.isRealtime && <span className={`delay-tag delay-tag--${delay.tone}`}>{delay.label}</span>}
        </div>

        <div className="leg__title">
          <RouteBadge route={leg.route} />
          <span className="leg__headsign">{leg.headsign}</span>
        </div>

        <button type="button" className="leg__stop-link" onClick={() => onShowStop(leg.from.id)}>
          Board at {leg.from.name}
        </button>

        <div className="leg__detail">
          {modeLabel(leg.route.mode)} · {leg.numStops} stop{leg.numStops === 1 ? '' : 's'} ·{' '}
          {duration(leg.arrivalTime - leg.departureTime)}
          {leg.isRealtime && <> · departs in {departsIn}</>}
        </div>

        {leg.vehicleId && (
          <button type="button" className="leg__vehicle-link" onClick={() => onShowVehicle(leg.vehicleId!)}>
            Track this vehicle on the map
          </button>
        )}

        <button type="button" className="leg__stop-link" onClick={() => onShowStop(leg.to.id)}>
          Get off at {leg.to.name} · {clockTime(leg.arrivalTime)}
        </button>
      </div>
    </li>
  );
}
