import { useEffect, useState } from 'react';
import type { VehicleTrip } from './api.ts';

/**
 * The trip a selected vehicle is running, kept fresh while it stays selected.
 *
 * Owned above both the vehicle panel and the map, because both need it: the
 * panel lists the stops ahead, the map outlines the path. Refreshed on a
 * timer because predictions along the trip move even when the vehicle
 * itself has hardly moved.
 */
export function useVehicleTrip(
  load: (vehicleId: string, signal?: AbortSignal) => Promise<VehicleTrip | null>,
  vehicleId: string | null,
): { trip: VehicleTrip | null; loading: boolean } {
  const [trip, setTrip] = useState<VehicleTrip | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setTrip(null);
    if (!vehicleId) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const refresh = () => {
      load(vehicleId, controller.signal)
        .then((result) => {
          if (!cancelled) setTrip(result);
        })
        .catch(() => {
          // A trip that cannot be fetched leaves the panel showing what the
          // position alone says; that is not worth an error message.
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };

    setLoading(true);
    refresh();
    const timer = window.setInterval(refresh, 20_000);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [load, vehicleId]);

  return { trip, loading };
}
