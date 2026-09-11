import { DEFAULT_AGENCY_ID, getAgency, registerAgency, type AgencyDefinition } from './agencies/index.js';
import { log } from './log.js';

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

/**
 * Reads an agency definition straight out of the environment.
 *
 * This is the escape hatch that makes "any city" real without a code change:
 * point AGENCY_GTFS_URL at any published GTFS zip, optionally add realtime feed
 * URLs, and the server serves that system.
 */
function agencyFromEnv(env: NodeJS.ProcessEnv): AgencyDefinition | null {
  if (!env.AGENCY_GTFS_URL) return null;
  const bbox = (env.AGENCY_BBOX ?? '').split(',').map(Number);
  const center = (env.AGENCY_CENTER ?? '').split(',').map(Number);
  const valid = bbox.length === 4 && bbox.every(Number.isFinite);

  const agency: AgencyDefinition = {
    id: env.AGENCY_ID?.trim() || 'custom',
    name: env.AGENCY_NAME?.trim() || 'Custom agency',
    timezone: env.AGENCY_TIMEZONE?.trim() || 'UTC',
    gtfsUrl: env.AGENCY_GTFS_URL.trim(),
    realtime: {
      vehiclePositions: env.AGENCY_RT_VEHICLES?.trim() || undefined,
      tripUpdates: env.AGENCY_RT_TRIP_UPDATES?.trim() || undefined,
      alerts: env.AGENCY_RT_ALERTS?.trim() || undefined,
    },
    // Without an explicit bbox the client derives one from the loaded stops.
    bbox: valid ? (bbox as [number, number, number, number]) : [-180, -85, 180, 85],
    center:
      center.length === 2 && center.every(Number.isFinite)
        ? (center as [number, number])
        : [0, 0],
    attribution: env.AGENCY_ATTRIBUTION?.trim() || 'Schedule and realtime data from the operating agency',
  };
  registerAgency(agency);
  log.info(`config: registered agency "${agency.id}" from environment`);
  return agency;
}

export interface ServerConfig {
  agency: AgencyDefinition;
  port: number;
  host: string;
  /** Serve the synthetic demo feed instead of fetching real data. */
  mock: boolean;
  /** Seconds between GTFS-Realtime polls. */
  realtimePollSeconds: number;
  /** Hours before the cached static GTFS archive is re-downloaded. */
  gtfsMaxAgeHours: number;
  /** Serve the built web client from the API server. */
  serveStatic: boolean;
  planner: {
    maxWalkMeters: number;
    walkSpeed: number;
    maxTransfers: number;
    /** Cap on footpaths generated per stop, to bound transfer-graph size. */
    maxTransfersPerStop: number;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const fromEnv = agencyFromEnv(env);
  const agencyId = env.AGENCY_ID?.trim() || DEFAULT_AGENCY_ID;
  const agency = fromEnv ?? getAgency(agencyId);
  if (!agency) throw new Error(`Unknown agency "${agencyId}". Set AGENCY_GTFS_URL to define one.`);

  return {
    agency,
    port: num(env.PORT, 8080),
    host: env.HOST?.trim() || '0.0.0.0',
    mock: bool(env.LIVETRAINS_MOCK),
    realtimePollSeconds: num(env.REALTIME_POLL_SECONDS, 15),
    gtfsMaxAgeHours: num(env.GTFS_MAX_AGE_HOURS, 24),
    serveStatic: bool(env.SERVE_STATIC, process.env.NODE_ENV === 'production'),
    planner: {
      maxWalkMeters: num(env.PLANNER_MAX_WALK_METERS, 1200),
      walkSpeed: num(env.PLANNER_WALK_SPEED, 1.33),
      maxTransfers: num(env.PLANNER_MAX_TRANSFERS, 3),
      maxTransfersPerStop: num(env.PLANNER_MAX_TRANSFERS_PER_STOP, 12),
    },
  };
}
