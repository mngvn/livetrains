/// <reference types="vite/client" />

/** Build-time configuration read through `import.meta.env`. */
interface ImportMetaEnv {
  /** API server to talk to in server mode. Empty means same origin. */
  readonly VITE_API_URL?: string;
  /** 'browser' runs the transit engine in a worker; anything else uses the API. */
  readonly VITE_DATA_MODE?: string;
  /** Which registered agency the browser engine should load. */
  readonly VITE_AGENCY_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Optional agency override, mirroring the server's AGENCY_* variables. */
interface ImportMetaEnv {
  readonly VITE_AGENCY_NAME?: string;
  readonly VITE_AGENCY_TIMEZONE?: string;
  readonly VITE_AGENCY_GTFS_URL?: string;
  readonly VITE_AGENCY_RT_VEHICLES?: string;
  readonly VITE_AGENCY_RT_TRIP_UPDATES?: string;
  readonly VITE_AGENCY_RT_ALERTS?: string;
  readonly VITE_AGENCY_BBOX?: string;
  readonly VITE_AGENCY_CENTER?: string;
  readonly VITE_AGENCY_ATTRIBUTION?: string;
  readonly VITE_BASE?: string;
}
