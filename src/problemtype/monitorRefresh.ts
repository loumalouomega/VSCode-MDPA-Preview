/**
 * Pure throttle for refreshing saved monitors while a run is live (roadmap
 * item 26). `request()` is called on every output change; at most one
 * evaluation starts per `intervalMs`, a request inside the window collapses
 * into one trailing evaluation, and nothing starts while one is in flight or
 * after `stop()`. Time and timers are injected so it is Node-testable.
 */
export interface MonitorRefreshDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Runs one evaluation; the throttle waits for it before allowing the next. */
  run(): Promise<void>;
}

export const MONITOR_REFRESH_INTERVAL_MS = 2000;

export class MonitorRefreshThrottle {
  private last = Number.NEGATIVE_INFINITY;
  private inFlight = false;
  private pending = false;
  private timer: unknown;
  private stopped = false;

  constructor(private readonly deps: MonitorRefreshDeps, private readonly intervalMs = MONITOR_REFRESH_INTERVAL_MS) {}

  request(): void {
    if (this.stopped) return;
    if (this.inFlight) {
      this.pending = true;
      return;
    }
    const wait = this.last + this.intervalMs - this.deps.now();
    if (wait <= 0) {
      void this.start();
    } else if (this.timer === undefined) {
      this.timer = this.deps.setTimer(() => {
        this.timer = undefined;
        if (!this.stopped && !this.inFlight) void this.start();
        else if (!this.stopped) this.pending = true;
      }, wait);
    }
  }

  /** Cancels any trailing evaluation; later requests are ignored. */
  stop(): void {
    this.stopped = true;
    this.pending = false;
    if (this.timer !== undefined) this.deps.clearTimer(this.timer);
    this.timer = undefined;
  }

  private async start(): Promise<void> {
    this.inFlight = true;
    this.last = this.deps.now();
    try {
      await this.deps.run();
    } catch {
      // A failed evaluation must not wedge the throttle; the next request retries.
    } finally {
      this.inFlight = false;
      if (this.pending && !this.stopped) {
        this.pending = false;
        this.request();
      }
    }
  }
}
