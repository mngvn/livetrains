import { getAgency, type AgencyDefinition } from '../../../server/src/agencies/index.js';

/**
 * Resolves which agency the browser engine should serve.
 *
 * Mirrors the server's `AGENCY_*` environment support so the same escape hatch
 * exists on both sides: point `VITE_AGENCY_GTFS_URL` at any published GTFS feed
 * and the static build serves that system, with no code change and no server.
 *
 * The feed must send permissive CORS headers to be reachable from a browser.
 * Metro Transit does; not every agency will.
 */
export function resolveAgency(): AgencyDefinition {
  const env = import.meta.env;
  const id = env.VITE_AGENCY_ID?.trim() || 'metro-transit';

  if (env.VITE_AGENCY_GTFS_URL?.trim()) {
    const bbox = (env.VITE_AGENCY_BBOX ?? '').split(',').map(Number);
    const center = (env.VITE_AGENCY_CENTER ?? '').split(',').map(Number);
    return {
      id,
      name: env.VITE_AGENCY_NAME?.trim() || 'Custom agency',
      timezone: env.VITE_AGENCY_TIMEZONE?.trim() || 'UTC',
      gtfsUrl: env.VITE_AGENCY_GTFS_URL.trim(),
      realtime: {
        vehiclePositions: env.VITE_AGENCY_RT_VEHICLES?.trim() || undefined,
        tripUpdates: env.VITE_AGENCY_RT_TRIP_UPDATES?.trim() || undefined,
        alerts: env.VITE_AGENCY_RT_ALERTS?.trim() || undefined,
      },
      bbox:
        bbox.length === 4 && bbox.every(Number.isFinite)
          ? (bbox as [number, number, number, number])
          : [-180, -85, 180, 85],
      center:
        center.length === 2 && center.every(Number.isFinite)
          ? (center as [number, number])
          : [0, 0],
      attribution:
        env.VITE_AGENCY_ATTRIBUTION?.trim() || 'Schedule and realtime data from the operating agency',
    };
  }

  const registered = getAgency(id);
  if (!registered) throw new Error(`Unknown agency "${id}"`);
  return registered;
}
