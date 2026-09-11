import { join } from 'node:path';
import type { AgencyInfo, FeedStatus } from './shared/api.js';
import type { ServerConfig } from './config.js';
import { downloadGtfs, GTFS_CACHE_DIR, readZipEntries } from './gtfs/archive.js';
import { GtfsStore, GTFS_FILES } from './gtfs/store.js';
import { Geocoder } from './geocode.js';
import { log } from './log.js';
import { createMockStore, MockSimulator } from './mock/index.js';
import { PatternSet } from './planner/patterns.js';
import { Planner } from './planner/index.js';
import { RealtimePoller } from './realtime/poller.js';
import { RealtimeState } from './realtime/state.js';

/**
 * Owns the loaded feed and everything derived from it.
 *
 * Loading GTFS and building the routing indexes takes real time on a
 * metro-sized feed, so it happens once at startup and the results are shared by
 * every request. The service is the single place that knows whether we are
 * serving live data or the synthetic demo feed.
 */
export class TransitService {
  store: GtfsStore | null = null;
  patterns: PatternSet | null = null;
  planner: Planner | null = null;
  geocoder: Geocoder | null = null;

  readonly realtime: RealtimeState;
  private readonly poller: RealtimePoller | null;
  private simulator: MockSimulator | null = null;
  private mockTimer: NodeJS.Timeout | null = null;
  /** Why the static feed could not be loaded, if it could not. */
  loadError: string | null = null;

  constructor(readonly config: ServerConfig) {
    if (config.mock) {
      this.realtime = new RealtimeState();
      this.poller = null;
    } else {
      this.poller = new RealtimePoller(
        config.agency,
        config.realtimePollSeconds,
        () => this.store,
      );
      this.realtime = this.poller.state;
    }
  }

  get ready(): boolean {
    return this.store !== null && this.planner !== null;
  }

  /** Loads the feed and builds every derived index. */
  async start(): Promise<void> {
    let store: GtfsStore;
    try {
      store = this.config.mock ? await this.loadMock() : await this.loadLive();
      this.loadError = null;
    } catch (err) {
      // Remember why, so the API can say "the feed failed to load, and here is
      // the reason" rather than leaving clients to guess at a bare 503.
      this.loadError = err instanceof Error ? err.message : String(err);
      throw err;
    }
    this.store = store;

    const started = Date.now();
    this.planner = new Planner(store, this.realtime, this.config.planner);
    // The planner builds the pattern set it routes on; reuse it for departures
    // rather than paying to derive the same structure a second time.
    this.patterns = this.planner.patterns;
    this.geocoder = new Geocoder(store, this.config.agency.id, process.env.NOMINATIM_URL?.trim() || undefined);
    log.info(`service: routing indexes ready in ${((Date.now() - started) / 1000).toFixed(1)}s`);

    if (this.config.mock) this.startSimulation();
    else this.poller?.start();
  }

  stop(): void {
    this.poller?.stop();
    if (this.mockTimer) clearInterval(this.mockTimer);
    this.mockTimer = null;
  }

  onVehiclesUpdated(listener: () => void): () => void {
    if (this.poller) return this.poller.onVehiclesUpdated(listener);
    this.mockListeners.add(listener);
    return () => this.mockListeners.delete(listener);
  }

  private readonly mockListeners = new Set<() => void>();

  private async loadMock(): Promise<GtfsStore> {
    log.info('service: starting in mock mode — serving a synthetic demo feed, no network required');
    return createMockStore(this.config.agency.timezone);
  }

  private async loadLive(): Promise<GtfsStore> {
    const { agency, gtfsMaxAgeHours } = this.config;
    const destination = join(GTFS_CACHE_DIR, `${agency.id}.zip`);
    const { path } = await downloadGtfs(agency.gtfsUrl, destination, gtfsMaxAgeHours * 3600 * 1000);
    const files = await readZipEntries(path, GTFS_FILES);
    if (files.size === 0) throw new Error('GTFS archive contained none of the expected files');
    return GtfsStore.load(files);
  }

  /** Drives the simulated feed on the same cadence as a real poller. */
  private startSimulation(): void {
    if (!this.store) return;
    this.simulator = new MockSimulator(this.store);

    const tick = () => {
      if (!this.simulator) return;
      this.realtime.setVehicles(this.simulator.vehicles());
      this.realtime.setTripUpdates(this.simulator.tripUpdates());
      for (const listener of this.mockListeners) listener();
    };

    this.realtime.setAlerts(this.simulator.alerts());
    tick();
    // Faster than a real feed: simulated vehicles move continuously, so a
    // shorter tick makes the demo look alive without costing anything.
    this.mockTimer = setInterval(tick, 5_000);
    this.mockTimer.unref?.();
    log.info('service: simulated vehicles running');
  }

  agencyInfo(): AgencyInfo {
    const { agency } = this.config;
    return {
      id: agency.id,
      name: this.config.mock ? `${agency.name} (demo data)` : agency.name,
      timezone: this.store?.timezone ?? agency.timezone,
      bbox: agency.bbox,
      center: agency.center,
      hasVehicles: this.config.mock || Boolean(agency.realtime.vehiclePositions),
    };
  }

  status(): FeedStatus {
    return {
      agency: this.agencyInfo(),
      mock: this.config.mock,
      gtfs: {
        loaded: this.store !== null,
        loadedAt: this.store?.loadedAt ?? null,
        stops: this.store?.stops.length ?? 0,
        routes: this.store?.routes.length ?? 0,
        trips: this.store?.tripIds.length ?? 0,
        stopTimes: this.store?.stopTimeCount ?? 0,
        version: this.store?.feedVersion,
        error: this.loadError ?? undefined,
      },
      realtime: {
        vehicles: this.realtime.vehicles.size,
        tripUpdates: this.realtime.tripUpdates.size,
        alerts: this.realtime.alerts.length,
        lastVehicleUpdate: this.realtime.lastVehicleUpdate,
        lastTripUpdate: this.realtime.lastTripUpdate,
        lastError: this.realtime.lastError,
      },
    };
  }
}
