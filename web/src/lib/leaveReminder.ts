import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Itinerary, StopDetail, TransitLeg } from './api.ts';

/**
 * When to walk out of the door.
 *
 * An itinerary's departure time is fixed at the moment it was planned. The
 * bus it depends on is not: it drifts later, or occasionally earlier, as it
 * works its way up the route. So the leave-by time is re-derived from the
 * live prediction for that exact trip at the boarding stop, minus the walk
 * to get there.
 */

/** A little slack for finding the stop and the doors not waiting. */
export const BOARDING_BUFFER_SECONDS = 60;
/** How far ahead of leave-by the reminder goes off. */
export const REMIND_BEFORE_SECONDS = 120;
const REFRESH_MS = 30_000;

export function firstTransitLeg(itinerary: Itinerary): TransitLeg | null {
  return (itinerary.legs.find((leg) => leg.type === 'transit') as TransitLeg | undefined) ?? null;
}

/** Walking time before the first boarding. */
export function walkBeforeBoarding(itinerary: Itinerary): number {
  let seconds = 0;
  for (const leg of itinerary.legs) {
    if (leg.type === 'transit') break;
    seconds += leg.durationSeconds;
  }
  return seconds;
}

/**
 * Unix seconds to leave by: the vehicle's (predicted) departure, less the
 * walk, less a minute of slack. A walk-only trip leaves when it was planned
 * to.
 */
export function leaveBy(itinerary: Itinerary, predictedDeparture?: number): number {
  const leg = firstTransitLeg(itinerary);
  if (!leg) return itinerary.departureTime;
  const departs = predictedDeparture ?? leg.departureTime;
  return departs - walkBeforeBoarding(itinerary) - BOARDING_BUFFER_SECONDS;
}

export interface LeaveState {
  /** Unix seconds; null for an itinerary that has no transit at all. */
  leaveAt: number | null;
  /** The boarding it hangs on, for the reminder's wording. */
  leg: TransitLeg | null;
  /** Whether the time comes from a live prediction. */
  live: boolean;
  /** The feed has cancelled the trip this depends on. */
  cancelled: boolean;
  armed: boolean;
  arm: () => Promise<void>;
  disarm: () => void;
  /** Set once the reminder has gone off, until dismissed. */
  fired: boolean;
  dismiss: () => void;
}

export function useLeaveReminder(
  itinerary: Itinerary | null,
  load: (stopId: string, limit?: number, signal?: AbortSignal) => Promise<StopDetail>,
  now: number,
): LeaveState {
  const leg = useMemo(() => (itinerary ? firstTransitLeg(itinerary) : null), [itinerary]);
  const [predicted, setPredicted] = useState<{ tripId: string; time: number } | null>(null);
  const [cancelledTrip, setCancelledTrip] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [fired, setFired] = useState(false);
  const firedFor = useRef<string | null>(null);

  // A different trip is a different reminder.
  const tripKey = leg ? `${leg.tripId}|${leg.from.id}` : null;
  useEffect(() => {
    setArmed(false);
    setFired(false);
    setPredicted(null);
    setCancelledTrip(null);
    firedFor.current = null;
  }, [tripKey]);

  // Follow the live prediction for this trip at its boarding stop.
  useEffect(() => {
    if (!leg) return;
    const controller = new AbortController();
    const refresh = () => {
      load(leg.from.id, 20, controller.signal)
        .then((detail) => {
          const match = detail.departures.find((d) => d.tripId === leg.tripId);
          setCancelledTrip(match?.cancelled ? leg.tripId : null);
          if (match && match.isRealtime && !match.cancelled) setPredicted({ tripId: leg.tripId, time: match.expectedTime });
        })
        .catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [leg, load]);

  const live = Boolean(leg && predicted && predicted.tripId === leg.tripId);
  const cancelled = Boolean(leg && cancelledTrip === leg.tripId);
  const leaveAt = itinerary && leg ? leaveBy(itinerary, live ? predicted!.time : undefined) : null;

  // Go off once, a couple of minutes before leave-by.
  useEffect(() => {
    if (!armed || leaveAt === null || !leg || !tripKey || cancelledTrip === leg.tripId) return;
    if (now < leaveAt - REMIND_BEFORE_SECONDS || firedFor.current === tripKey) return;
    firedFor.current = tripKey;
    setFired(true);
    setArmed(false);
    void notify(leg, leaveAt, now);
  }, [armed, leaveAt, now, leg, tripKey, cancelledTrip]);

  const arm = useCallback(async () => {
    // Asked for at the moment the rider taps, which is when browsers allow
    // it and when the reason is obvious. A refusal still leaves the in-app
    // banner, so the reminder is armed either way.
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try {
        await Notification.requestPermission();
      } catch {
        // Older Safari takes a callback instead; the banner still works.
      }
    }
    setArmed(true);
  }, []);

  const disarm = useCallback(() => setArmed(false), []);
  const dismiss = useCallback(() => setFired(false), []);

  return { leaveAt, leg, live, cancelled, armed, arm, disarm, fired, dismiss };
}

/** The system notification, where the browser allows one. */
async function notify(leg: TransitLeg, leaveAt: number, now: number): Promise<void> {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const minutes = Math.max(0, Math.round((leaveAt - now) / 60));
  const title = minutes <= 0 ? 'Time to leave' : `Leave in ${minutes} min`;
  const body = `For the ${leg.route.shortName} to ${leg.headsign}, from ${leg.from.name}.`;
  const options: NotificationOptions = { body, tag: 'livetrains-leave' };
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
    // The in-app banner has it covered.
  }
}
