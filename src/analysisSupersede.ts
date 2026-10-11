/**
 * "Latest request wins" for an abortable async analysis (no vscode imports).
 *
 * `run(fn)` aborts whatever run is in flight and starts `fn` with a fresh
 * signal. The returned promise resolves with `fn`'s value only while that run
 * is still the current one; a run that was superseded or cancelled resolves
 * `undefined` (and swallows its own rejection, since the caller asked for it
 * to stop), so a late reply — success or failure — can never be posted over a
 * newer one. `cancel()` aborts the current run (panel closed, document
 * disposed).
 */
export interface SupersedingRunner {
  run<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T | undefined>;
  cancel(): void;
}

export function createSupersedingRunner(): SupersedingRunner {
  let current: AbortController | undefined;
  return {
    async run<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
      current?.abort();
      const abort = new AbortController();
      current = abort;
      try {
        const value = await fn(abort.signal);
        return abort.signal.aborted ? undefined : value;
      } catch (err) {
        if (abort.signal.aborted) return undefined;
        throw err;
      } finally {
        if (current === abort) current = undefined;
      }
    },
    cancel(): void {
      current?.abort();
    },
  };
}
