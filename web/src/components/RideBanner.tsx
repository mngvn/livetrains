import { useEffect, useRef } from 'react';
import type { RouteSummary } from '../lib/api.ts';
import { RIDE_VIBRATION, type RideProgress } from '../lib/ride.ts';
import { RouteBadge } from './RouteBadge.tsx';

/**
 * The trip you are on, across the top of the map.
 *
 * Big, plain, and getting louder as your stop comes up: a count of stops
 * while there are several, "get ready" one stop out, "your stop is next",
 * then "get off here" when the doors open. Each step also taps the phone
 * where the browser allows it, and the last two raise a notification, so
 * the phone can stay in a pocket.
 */
export function RideBanner({
  route,
  progress,
  onEnd,
  onShowVehicle,
}: {
  route: RouteSummary | null;
  progress: RideProgress;
  onEnd: () => void;
  onShowVehicle: () => void;
}) {
  useRideSignals(progress);

  const { phase, stop, stopsAway, secondsAway } = progress;
  const minutes = secondsAway === null ? null : Math.max(0, Math.round(secondsAway / 60));
  const eta = minutes === null ? '' : minutes === 0 ? 'now' : `${minutes} min`;

  const headline =
    phase === 'choose'
      ? 'Choose your stop'
      : phase === 'riding'
        ? `${stopsAway + 1} stops to go`
        : phase === 'next'
          ? '2 stops to go · get ready'
          : phase === 'arriving'
            ? 'Your stop is next'
            : phase === 'alight'
              ? 'Get off here'
              : 'You have arrived';

  const detail =
    phase === 'choose'
      ? 'Tap “Get off here” on a stop in the vehicle’s panel.'
      : stop
        ? `${stop.stop.name}${phase === 'arrived' || phase === 'alight' ? '' : eta ? ` · ${eta}` : ''}`
        : '';

  return (
    <div className={`ride-banner is-${phase}`} role="status" aria-live="polite">
      <button type="button" className="ride-banner__main" onClick={onShowVehicle} title="Show the vehicle">
        {route && <RouteBadge route={route} />}
        <span className="ride-banner__text">
          <span className="ride-banner__label">Riding</span>
          <span className="ride-banner__headline">{headline}</span>
          {detail && <span className="ride-banner__detail">{detail}</span>}
        </span>
      </button>
      <button type="button" className="chip ride-banner__end" onClick={onEnd}>
        {phase === 'arrived' ? 'Done' : 'Stop'}
      </button>
    </div>
  );
}

/** A tap for each step closer, and a notification for the last two. */
function useRideSignals({ phase, stop }: RideProgress): void {
  const last = useRef(phase);
  useEffect(() => {
    if (phase === last.current) return;
    last.current = phase;
    const pattern = RIDE_VIBRATION[phase];
    if (pattern && typeof navigator.vibrate === 'function') {
      try {
        navigator.vibrate(pattern);
      } catch {
        // Not every browser lets a page buzz; the banner still says it.
      }
    }
    if ((phase === 'arriving' || phase === 'alight') && stop) {
      void notify(phase === 'alight' ? 'Get off here' : 'Your stop is next', stop.stop.name);
    }
  }, [phase, stop]);
}

async function notify(title: string, body: string): Promise<void> {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const options: NotificationOptions = { body, tag: 'livetrains-ride' };
  try {
    // Phones only show notifications through a service worker.
    const registration = await navigator.serviceWorker?.getRegistration();
    if (registration) {
      await registration.showNotification(title, options);
      return;
    }
  } catch {
    // Fall through to the page-level notification.
  }
  try {
    new Notification(title, options);
  } catch {
    // The banner has it covered.
  }
}

/** Asked for when the rider picks their stop: a tap, and an obvious reason. */
export async function askToNotify(): Promise<void> {
  if (typeof Notification === 'undefined' || Notification.permission !== 'default') return;
  try {
    await Notification.requestPermission();
  } catch {
    // Older Safari takes a callback; the banner works either way.
  }
}
