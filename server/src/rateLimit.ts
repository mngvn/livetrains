/**
 * Per-client request budgets, for a server anyone on the internet can reach.
 *
 * Most of the API is cheap lookups, but a trip plan is several full RAPTOR
 * searches and a reachability map is another, and all of them run on the one
 * thread that also serves everyone else. Without a budget a single script
 * looping on `/api/plan` would make the app unusable for every other rider.
 *
 * A fixed window per client is deliberately simple: no timers per client, no
 * dependency, and memory bounded by how many distinct clients were seen in
 * one window — swept as windows close, and capped outright so a flood of
 * spoofed addresses cannot grow it without limit.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Requests left in this window, after this one. */
  remaining: number;
  /** Seconds until the window resets. */
  retryAfterSeconds: number;
}

/** Past this many tracked clients the table is cleared rather than grown. */
const MAX_TRACKED_CLIENTS = 50_000;

export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private readonly sweeper: NodeJS.Timeout | null;

  constructor(
    /** Requests allowed per client per window; 0 or less turns the limit off. */
    readonly limit: number,
    readonly windowMs = 60_000,
  ) {
    this.sweeper = limit > 0 ? setInterval(() => this.sweep(), windowMs) : null;
    // Never the reason the process stays alive.
    this.sweeper?.unref?.();
  }

  get enabled(): boolean {
    return this.limit > 0;
  }

  /** Counts one request from `client` and says whether it may proceed. */
  take(client: string, now = Date.now()): RateLimitDecision {
    if (!this.enabled) return { allowed: true, remaining: Infinity, retryAfterSeconds: 0 };

    let window = this.windows.get(client);
    if (!window || window.resetAt <= now) {
      if (!window && this.windows.size >= MAX_TRACKED_CLIENTS) this.windows.clear();
      window = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(client, window);
    }
    window.count++;
    const retryAfterSeconds = Math.max(1, Math.ceil((window.resetAt - now) / 1000));
    return {
      allowed: window.count <= this.limit,
      remaining: Math.max(0, this.limit - window.count),
      retryAfterSeconds,
    };
  }

  /** Drops every window that has closed. */
  sweep(now = Date.now()): void {
    for (const [client, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(client);
    }
  }

  /** How many clients are being tracked, for tests and diagnostics. */
  get size(): number {
    return this.windows.size;
  }

  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper);
  }
}

/**
 * Counts what each client holds open — live vehicle streams — so one client
 * cannot take every connection the process has.
 */
export class ConnectionCounter {
  private readonly open = new Map<string, number>();
  private total = 0;

  constructor(
    readonly perClient: number,
    readonly overall: number,
  ) {}

  /** Claims a slot, returning a release function, or null when none is free. */
  acquire(client: string): (() => void) | null {
    const mine = this.open.get(client) ?? 0;
    if (mine >= this.perClient || this.total >= this.overall) return null;
    this.open.set(client, mine + 1);
    this.total++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total--;
      const left = (this.open.get(client) ?? 1) - 1;
      if (left <= 0) this.open.delete(client);
      else this.open.set(client, left);
    };
  }

  get count(): number {
    return this.total;
  }
}
