import type { LeaveState } from '../lib/leaveReminder.ts';
import { REMIND_BEFORE_SECONDS } from '../lib/leaveReminder.ts';
import { clockTime } from '../lib/format.ts';

/**
 * "Leave in 6 min", kept honest by the live prediction, with an optional
 * reminder.
 *
 * The reminder only works while livetrains is open in a tab — there is no
 * server to wake a closed one — and says so, rather than letting someone
 * pocket their phone and trust it.
 */
export function LeaveNudge({ state, now }: { state: LeaveState; now: number }) {
  const { leaveAt, leg, live, armed } = state;
  if (leaveAt === null || !leg) return null;

  const seconds = leaveAt - now;
  const minutes = Math.round(seconds / 60);
  // Missed it by more than the buffer: the plan needs redoing, not a nudge.
  if (seconds < -120) {
    return (
      <p className="leave-nudge is-missed" role="status">
        This one has probably gone — the {leg.route.shortName} leaves {leg.from.name} at{' '}
        {clockTime(leg.departureTime)}. Pick a later option above.
      </p>
    );
  }

  const headline = seconds <= 30 ? 'Leave now' : `Leave in ${minutes} min`;
  const canRemind = seconds > REMIND_BEFORE_SECONDS + 30;

  return (
    <div className={`leave-nudge${seconds <= 120 ? ' is-urgent' : ''}`}>
      <div className="leave-nudge__text">
        <strong className="leave-nudge__headline">{headline}</strong>
        <span className="leave-nudge__detail">
          by {clockTime(leaveAt)} to catch the {leg.route.shortName} at {leg.from.name}
          {live ? ' · live' : ' · scheduled'}
        </span>
      </div>
      {canRemind && (
        <button
          type="button"
          className={`chip${armed ? ' chip--primary' : ''}`}
          aria-pressed={armed}
          onClick={() => (armed ? state.disarm() : void state.arm())}
          title="Reminds you two minutes before, while livetrains stays open in a tab"
        >
          {armed ? 'Reminder on' : 'Remind me'}
        </button>
      )}
    </div>
  );
}

/** The reminder going off, over the map, wherever the rider has wandered. */
export function LeaveBanner({ state, onShowTrip }: { state: LeaveState; onShowTrip: () => void }) {
  if (!state.fired || !state.leg) return null;
  return (
    <div className="leave-banner" role="alert">
      <span className="leave-banner__text">
        <strong>Time to go</strong> — the {state.leg.route.shortName} to {state.leg.headsign} from {state.leg.from.name}
      </span>
      <button type="button" className="chip chip--primary" onClick={onShowTrip}>
        Show trip
      </button>
      <button type="button" className="icon-button" onClick={state.dismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
