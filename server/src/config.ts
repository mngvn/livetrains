import { DEFAULT_AGENCY_ID, getAgency, registerAgency, type AgencyDefinition } from './agencies/index.js';
import { log } from './log.js';
import { DEFAULT_CIRCUITY } from './planner/walk.js';
import { DEFAULT_PLANE_FEEDS } from './planes.js';

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** A whole number that may be zero (zero usually meaning "off"). */
function count(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/**
 * Whose word to take for a client's address: Fastify's `trustProxy`.
 *
 * Off unless set. Trusting `X-Forwarded-For` from anyone would let a client
 * name its own address, and with it its own rate-limit bucket. Behind a
 * reverse proxy, set it to `true`, to the number of proxy hops, or to the
 * proxies' addresses (comma-separated IPs or CIDRs).
 */
function trustProxy(value: string | undefined): boolean | number | string {
  const text = value?.trim() ?? '';
  if (text === '' || /^(false|no|off)$/i.test(text)) return false;
  if (/^(true|yes|on)$/i.test(text)) return true;
  if (/^\d+$/.test(text)) return Number(text);
  return text;
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
  /**
   * Aircraft feed URL templates, tried in order: `{lat}`, `{lon}` and
   * `{radius}` (nautical miles) are filled in. Empty turns planes off.
   */
  planeFeeds: string[];
  /** See `trustProxy` above. */
  trustProxy: boolean | number | string;
  /** Origins allowed to call the API from a browser; null allows any. */
  corsOrigins: string[] | null;
  /** API requests per client per minute; 0 turns the limit off. */
  rateLimitPerMinute: number;
  /** Trip plans and reachability maps per client per minute: the expensive ones. */
  planRateLimitPerMinute: number;
  /** Live vehicle streams one client may hold open at once. */
  maxStreamsPerClient: number;
  planner: {
    maxWalkMeters: number;
    walkSpeed: number;
    maxTransfers: number;
    /** Cap on footpaths generated per stop, to bound transfer-graph size. */
    maxTransfersPerStop: number;
    /** Ratio of real walking distance to straight-line distance. */
    walkCircuity: number;
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
    // Not faster than every five seconds: the feeds are someone else's
    // servers, and they do not refresh faster than that anyway.
    realtimePollSeconds: Math.max(5, num(env.REALTIME_POLL_SECONDS, 15)),
    gtfsMaxAgeHours: num(env.GTFS_MAX_AGE_HOURS, 24),
    serveStatic: bool(env.SERVE_STATIC, process.env.NODE_ENV === 'production'),
    planeFeeds:
      env.PLANES_FEEDS === undefined
        ? DEFAULT_PLANE_FEEDS
        : env.PLANES_FEEDS.split(',').map((url) => url.trim()).filter(Boolean),
    trustProxy: trustProxy(env.TRUST_PROXY),
    corsOrigins: env.CORS_ORIGINS?.trim()
      ? env.CORS_ORIGINS.split(',').map((origin) => origin.trim().replace(/\/$/, '')).filter(Boolean)
      : null,
    rateLimitPerMinute: count(env.RATE_LIMIT_PER_MINUTE, 600),
    planRateLimitPerMinute: count(env.PLAN_RATE_LIMIT_PER_MINUTE, 60),
    maxStreamsPerClient: Math.max(1, count(env.MAX_STREAMS_PER_CLIENT, 8)),
    planner: {
      maxWalkMeters: num(env.PLANNER_MAX_WALK_METERS, 1200),
      walkSpeed: num(env.PLANNER_WALK_SPEED, 1.33),
      maxTransfers: num(env.PLANNER_MAX_TRANSFERS, 3),
      maxTransfersPerStop: num(env.PLANNER_MAX_TRANSFERS_PER_STOP, 12),
      walkCircuity: num(env.PLANNER_WALK_CIRCUITY, DEFAULT_CIRCUITY),
    },
  };
}
