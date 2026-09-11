import type { Vehicle } from '../../../server/src/shared/api.js';
import type { LoadProgress } from './gtfsSource.js';
import type { AgencyDefinition } from '../../../server/src/agencies/types.js';
import type { EngineMethod, FromWorker, ToWorker } from './protocol.js';

/**
 * Main-thread handle on the transit worker.
 *
 * Presents the same request/response shape the HTTP client does, so the rest of
 * the app does not care whether it is talking to a server or to a worker a few
 * milliseconds away.
 */

export interface EngineStatus {
  state: 'loading' | 'ready' | 'failed';
  progress: LoadProgress | null;
  error: string | null;
}

type StatusListener = (status: EngineStatus) => void;
type VehicleListener = (payload: { vehicles: Vehicle[]; timestamp: number | null; error: string | null }) => void;

export class TransitEngine {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly statusListeners = new Set<StatusListener>();
  private readonly vehicleListeners = new Set<VehicleListener>();
  /** Requests made before the feed finished loading, replayed once ready. */
  private readonly queued: (() => void)[] = [];

  private status: EngineStatus = { state: 'loading', progress: null, error: null };

  constructor(
    private readonly agency: AgencyDefinition,
    private readonly pollSeconds = 15,
  ) {}

  start(): void {
    if (this.worker) return;

    // `new URL(..., import.meta.url)` is the form Vite recognises to bundle a
    // worker as its own chunk, which is what keeps it working on a static host.
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.addEventListener('message', (event: MessageEvent<FromWorker>) => this.receive(event.data));
    this.worker.addEventListener('error', (event) => {
      this.setStatus({ state: 'failed', error: event.message || 'The transit engine crashed' });
    });

    this.send({ type: 'init', agency: this.agency, pollSeconds: this.pollSeconds });
  }

  stop(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const { reject } of this.pending.values()) reject(new Error('Engine stopped'));
    this.pending.clear();
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  onVehicles(listener: VehicleListener): () => void {
    this.vehicleListeners.add(listener);
    return () => this.vehicleListeners.delete(listener);
  }

  setRouteFilter(routeId?: string): void {
    this.send({ type: 'setFilter', routeId });
  }

  /** Reloads the timetable; `hard` also discards the cached archive. */
  refresh(hard = false): void {
    this.setStatus({ state: 'loading', progress: null, error: null });
    this.send({ type: 'refresh', hard });
  }

  /**
   * Sends a query, holding it until the feed is ready.
   *
   * The UI starts asking for data as soon as it mounts, which is long before a
   * 19MB timetable has finished parsing. Queueing rather than rejecting means
   * the first screen fills in by itself once loading completes.
   */
  request<T>(method: EngineMethod, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const dispatch = () => {
        if (!this.worker) {
          reject(new Error('The transit engine is not running'));
          return;
        }
        const id = this.nextId++;
        this.pending.set(id, {
          resolve: resolve as (value: unknown) => void,
          reject,
        });
        this.send({ type: 'request', id, method, params });
      };

      if (this.status.state === 'ready') dispatch();
      else if (this.status.state === 'failed') reject(new Error(this.status.error ?? 'The timetable failed to load'));
      else this.queued.push(dispatch);
    });
  }

  private send(message: ToWorker): void {
    this.worker?.postMessage(message);
  }

  private setStatus(next: Partial<EngineStatus>): void {
    this.status = { ...this.status, ...next };
    for (const listener of this.statusListeners) listener(this.status);
  }

  private receive(message: FromWorker): void {
    switch (message.type) {
      case 'progress':
        this.setStatus({ progress: message.progress });
        return;

      case 'ready': {
        this.setStatus({ state: 'ready', error: null });
        const queued = this.queued.splice(0, this.queued.length);
        for (const run of queued) run();
        return;
      }

      case 'failed': {
        this.setStatus({ state: 'failed', error: message.error });
        const queued = this.queued.splice(0, this.queued.length);
        // Queued callers are waiting on a promise; fail them rather than
        // leaving the UI spinning forever.
        for (const run of queued) run();
        return;
      }

      case 'vehicles':
        for (const listener of this.vehicleListeners) listener(message);
        return;

      case 'response': {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.ok) entry.resolve(message.data);
        else entry.reject(new Error(message.error ?? 'Request failed'));
        return;
      }
    }
  }
}
