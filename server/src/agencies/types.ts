/**
 * An agency definition.
 *
 * Everything the server needs to serve a transit system lives in one of these.
 * Because GTFS and GTFS-Realtime are open standards used by thousands of
 * agencies worldwide, supporting a new city means adding an entry here — not
 * writing new ingest code. That is the whole point of the indirection.
 */
export interface AgencyDefinition {
  /** URL-safe identifier used in API paths, e.g. "metro-transit". */
  id: string;
  name: string;
  /** IANA timezone. Overridden by agency.txt when the feed declares one. */
  timezone: string;
  /** Static GTFS archive (a .zip). */
  gtfsUrl: string;
  realtime: {
    /** GTFS-Realtime VehiclePosition feed (.pb). Omit if unpublished. */
    vehiclePositions?: string;
    /** GTFS-Realtime TripUpdate feed (.pb). Omit if unpublished. */
    tripUpdates?: string;
    /** GTFS-Realtime Alert feed (.pb). Omit if unpublished. */
    alerts?: string;
    /** Extra headers, for agencies that require an API key. */
    headers?: Record<string, string>;
  };
  /** Initial map viewport: [west, south, east, north]. */
  bbox: [number, number, number, number];
  center: [number, number];
  /** Attribution line shown in the map corner. */
  attribution: string;
}

export const DEFAULT_AGENCY_ID = 'metro-transit';
