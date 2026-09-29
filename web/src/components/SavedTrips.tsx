import type { ReliabilitySummary } from '../lib/reliability.ts';
import { describe, watchKey } from '../lib/reliability.ts';
import type { SavedTrip } from '../lib/savedTrips.ts';
import { RouteBadge } from './RouteBadge.tsx';

/**
 * The rider's usual trips, one tap from a fresh plan, each with a line on how
 * its buses and trains have actually been running.
 */
export function SavedTrips({
  trips,
  summaries,
  onOpen,
  onRemove,
}: {
  trips: SavedTrip[];
  summaries: Map<string, ReliabilitySummary>;
  onOpen: (trip: SavedTrip) => void;
  onRemove: (id: string) => void;
}) {
  if (trips.length === 0) return null;
  return (
    <section className="panel-section saved-trips" aria-label="Saved trips">
      <h3 className="panel-section__title">Saved trips</h3>
      <ul className="saved-trips__list">
        {trips.map((trip) => (
          <li key={trip.id} className="saved-trip">
            <button type="button" className="saved-trip__open" onClick={() => onOpen(trip)}>
              <span className="saved-trip__ends">
                {trip.from.kind === 'current-location' ? 'From where you are' : trip.from.name}
                <span aria-hidden="true"> → </span>
                <span className="visually-hidden"> to </span>
                {trip.to.name}
              </span>
              {trip.boardings.map((boarding) => {
                const summary = summaries.get(watchKey(boarding));
                return (
                  <span key={watchKey(boarding)} className="saved-trip__boarding">
                    <RouteBadge route={{ ...boarding.route }} size="small" />
                    <span className="saved-trip__stop">from {boarding.stopName}</span>
                    <span
                      className={`saved-trip__reliability${reliabilityTone(summary)}`}
                      title="Recorded on this device while livetrains is open"
                    >
                      {summary ? describe(summary) : 'No departures seen yet'}
                    </span>
                  </span>
                );
              })}
            </button>
            <button
              type="button"
              className="icon-button saved-trip__remove"
              onClick={() => onRemove(trip.id)}
              aria-label={`Forget the trip to ${trip.to.name}`}
              title="Forget this trip"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <p className="saved-trips__note">
        On-time means no more than a minute early or five late, as seen by this device while livetrains is open.
      </p>
    </section>
  );
}

function reliabilityTone(summary: ReliabilitySummary | undefined): string {
  if (!summary || summary.onTimeShare === null) return '';
  if (summary.onTimeShare >= 0.85) return ' is-good';
  if (summary.onTimeShare < 0.6) return ' is-poor';
  return ' is-fair';
}
