import type { AgencyDefinition } from './types.js';

/**
 * Twin Cities Metro Transit.
 *
 * Metro Transit publishes GTFS and GTFS-Realtime openly at svc.metrotransit.org
 * with no API key and no registration. The realtime feeds cover the whole
 * system: local and express buses, the Blue and Green light rail lines, the
 * A/B/C/D arterial BRT lines, and Northstar commuter rail.
 */
const METRO_TRANSIT: AgencyDefinition = {
  id: 'metro-transit',
  name: 'Metro Transit (Twin Cities)',
  timezone: 'America/Chicago',
  gtfsUrl: 'https://svc.metrotransit.org/mtgtfs/gtfs.zip',
  realtime: {
    vehiclePositions: 'https://svc.metrotransit.org/mtgtfs/vehiclepositions.pb',
    tripUpdates: 'https://svc.metrotransit.org/mtgtfs/tripupdates.pb',
    alerts: 'https://svc.metrotransit.org/mtgtfs/alerts.pb',
  },
  bbox: [-93.6, 44.72, -92.85, 45.18],
  center: [-93.265, 44.978],
  attribution: 'Schedule and realtime data © Metro Transit',
};

/**
 * A second agency, wired up but off by default, to keep the multi-agency path
 * honest: if adding a city ever needs more than an entry here, the abstraction
 * has broken and should be fixed rather than worked around.
 *
 * Duluth Transit Authority, also Minnesota — the natural next step outward from
 * the Twin Cities toward statewide coverage.
 */
const DULUTH_TRANSIT: AgencyDefinition = {
  id: 'duluth-transit',
  name: 'Duluth Transit Authority',
  timezone: 'America/Chicago',
  gtfsUrl: 'https://duluthtransit.com/gtfs/gtfs.zip',
  realtime: {
    vehiclePositions: 'https://duluthtransit.com/gtfs-rt/vehiclepositions.pb',
    tripUpdates: 'https://duluthtransit.com/gtfs-rt/tripupdates.pb',
  },
  bbox: [-92.3, 46.6, -91.95, 46.87],
  center: [-92.1, 46.787],
  attribution: 'Schedule and realtime data © Duluth Transit Authority',
};

const REGISTRY = new Map<string, AgencyDefinition>(
  [METRO_TRANSIT, DULUTH_TRANSIT].map((a) => [a.id, a]),
);

export function getAgency(id: string): AgencyDefinition | undefined {
  return REGISTRY.get(id);
}

export function listAgencies(): AgencyDefinition[] {
  return [...REGISTRY.values()];
}

/**
 * Registers an agency at runtime.
 *
 * Lets an operator point the server at any GTFS publisher through environment
 * configuration without editing this file — see `config.ts`.
 */
export function registerAgency(agency: AgencyDefinition): void {
  REGISTRY.set(agency.id, agency);
}

export type { AgencyDefinition } from './types.js';
export { DEFAULT_AGENCY_ID } from './types.js';
