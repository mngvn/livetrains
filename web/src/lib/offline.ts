import { useEffect, useState } from 'react';
import type { Vehicle } from './api.ts';
import { kvGet, kvSet } from './idb.ts';

/**
 * Staying useful without a connection.
 *
 * The timetable is already kept by the engine, so stops, departures (as
 * scheduled) and trip planning all work offline once the app has loaded. This
 * adds the rest: a service worker so the app itself loads with no network,
 * the last vehicle positions seen, and an honest signal that what is on the
 * map is not live.
 */

/** Registers the service worker, in production builds only. */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .then(async () => {
        const registration = await navigator.serviceWorker.ready;
        // Give the page time to fetch its engine worker and any lazy chunks,
        // then tell the service worker exactly which files this build uses.
        window.setTimeout(() => {
          const urls = performance
            .getEntriesByType('resource')
            .map((entry) => entry.name)
            .filter((name) => name.startsWith(window.location.origin));
          registration.active?.postMessage({ type: 'cache-assets', urls });
        }, 8_000);
      })
      .catch(() => undefined);
  });
}

/** Whether the browser believes it has a connection. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}

const LAST_VEHICLES = 'lastVehicles';

export interface LastVehicles {
  vehicles: Vehicle[];
  /** Unix seconds of the feed snapshot they came from. */
  asOf: number;
}

export function saveLastVehicles(vehicles: Vehicle[], asOf: number): Promise<void> {
  return kvSet(LAST_VEHICLES, { vehicles, asOf } satisfies LastVehicles).catch(() => undefined);
}

/**
 * The last positions saved, if they are recent enough to be worth drawing.
 *
 * Beyond a few hours the fleet has turned over — buses back at the garage,
 * a different set on the road — and old dots would be clutter, not context.
 */
export async function loadLastVehicles(maxAgeSeconds = 3 * 3600): Promise<LastVehicles | null> {
  const saved = await kvGet<LastVehicles>(LAST_VEHICLES).catch(() => undefined);
  if (!saved || !Array.isArray(saved.vehicles)) return null;
  if (Date.now() / 1000 - saved.asOf > maxAgeSeconds) return null;
  return saved;
}
