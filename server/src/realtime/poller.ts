import type { AgencyDefinition } from '../agencies/types.js';
import type { GtfsStore } from '../gtfs/store.js';
import { log } from '../log.js';
import { decodeAlerts, decodeTripUpdates, decodeVehiclePositions } from './decode.js';
import { RealtimeState } from './state.js';

/**
 * Polls an agency's GTFS-Realtime feeds on a fixed interval.
 *
 * GTFS-Realtime is a polling protocol: producers publish a full snapshot at a
 * stable URL and consumers re-fetch it. Metro Transit refreshes roughly every
 * 15 seconds, so polling faster costs bandwidth without gaining freshness.
 */
export class RealtimePoller {
  readonly state = new RealtimeState();

  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private consecutiveFailures = 0;
  /** Listeners notified after each successful vehicle refresh. */
  private readonly vehicleListeners = new Set<() => void>();

  constructor(
    private readonly agency: AgencyDefinition,
    private readonly intervalSeconds: number,
    private readonly getStore: () => GtfsStore | null,
  ) {}

  onVehiclesUpdated(listener: () => void): () => void {
    this.vehicleListeners.add(listener);
    return () => this.vehicleListeners.delete(listener);
  }

  start(): void {
    if (this.timer) return;
    const { vehiclePositions, tripUpdates, alerts } = this.agency.realtime;
    if (!vehiclePositions && !tripUpdates && !alerts) {
      log.warn(`realtime: ${this.agency.id} publishes no realtime feeds; serving schedule only`);
      return;
    }
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalSeconds * 1000);
    // Don't hold the process open just for polling.
    this.timer.unref?.();
    log.info(`realtime: polling every ${this.intervalSeconds}s`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async fetchFeed(url: string): Promise<Uint8Array> {
    const response = await fetch(url, {
      headers: { 'user-agent': 'livetrains/0.1', ...this.agency.realtime.headers },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * Fetches every configured feed once.
   *
   * Feeds are fetched concurrently and each is applied independently: a failing
   * alerts feed must not cost us live vehicle positions, which are the feature
   * riders actually notice.
   */
  private async poll(): Promise<void> {
    if (this.inFlight) return; // a slow poll must not stack up behind itself
    this.inFlight = true;

    const { vehiclePositions, tripUpdates, alerts } = this.agency.realtime;
    const store = this.getStore();
    const errors: string[] = [];

    const tasks: Promise<void>[] = [];

    if (vehiclePositions) {
      tasks.push(
        this.fetchFeed(vehiclePositions)
          .then((buf) => {
            this.state.setVehicles(decodeVehiclePositions(buf, store));
            for (const listener of this.vehicleListeners) listener();
          })
          .catch((err: unknown) => {
            errors.push(`vehicles (${describe(err)})`);
          }),
      );
    }

    if (tripUpdates) {
      tasks.push(
        this.fetchFeed(tripUpdates)
          .then((buf) => this.state.setTripUpdates(decodeTripUpdates(buf)))
          .catch((err: unknown) => {
            errors.push(`trip updates (${describe(err)})`);
          }),
      );
    }

    if (alerts) {
      tasks.push(
        this.fetchFeed(alerts)
          .then((buf) => this.state.setAlerts(decodeAlerts(buf)))
          .catch((err: unknown) => {
            errors.push(`alerts (${describe(err)})`);
          }),
      );
    }

    await Promise.all(tasks);
    this.inFlight = false;

    if (errors.length === 0) {
      if (this.consecutiveFailures > 0) {
        log.info(`realtime: feeds recovered after ${this.consecutiveFailures} failed polls`);
      }
      this.consecutiveFailures = 0;
      this.state.lastError = null;
      return;
    }

    this.state.lastError = errors.join('; ');
    this.consecutiveFailures++;
    // Log the first few failures, then back off to once a minute so a long
    // outage does not bury everything else in the log.
    const quiet = this.consecutiveFailures > 3 && this.consecutiveFailures % 4 !== 0;
    if (!quiet) {
      log.warn(`realtime: poll failed [${this.consecutiveFailures}x]: ${this.state.lastError}`);
    }
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    // Node wraps connection problems in an opaque "fetch failed"; the cause
    // carries the code that actually tells you what went wrong.
    const cause = (err as { cause?: { code?: string } }).cause;
    if (cause?.code) return `${err.message}: ${cause.code}`;
    return err.message;
  }
  return String(err);
}
