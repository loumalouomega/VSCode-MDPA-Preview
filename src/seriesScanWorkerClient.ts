/**
 * Host-side client for the series-scan worker (src/seriesScanWorker.ts): one
 * worker thread per scan, per-step progress forwarded, cancellation by message
 * (the worker stops between steps and resolves the PARTIAL series). Modelled on
 * streamlineWorkerClient.ts. No vscode imports.
 */

import { Worker } from "node:worker_threads";
import * as path from "node:path";
import type { SeriesScan, SeriesScanOptions, SeriesScanResult, SeriesScanSource } from "./seriesScanJob";
import type { SeriesScanRequest, SeriesScanResponse } from "./seriesScanWorker";

/** Rejection message of a scan hard-stopped by `kill` (its panel went away). */
export const SERIES_SCAN_KILLED = "cancelled";

export function runSeriesScanInWorker(
  source: SeriesScanSource,
  scan: SeriesScan,
  opts: SeriesScanOptions = {}
): Promise<SeriesScanResult> {
  return new Promise<SeriesScanResult>((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "seriesScanWorker.js"));
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener("abort", onAbort);
      opts.kill?.removeEventListener("abort", onKill);
      settle();
      void worker.terminate();
    };
    // The worker resolves the partial series; a thread that never answers ends
    // through the `exit`/`error` handlers below, never a hang.
    const onAbort = (): void => worker.postMessage({ type: "cancel" } satisfies SeriesScanRequest);
    const onKill = (): void => finish(() => reject(new Error(SERIES_SCAN_KILLED)));
    if (opts.kill?.aborted) {
      onKill();
      return;
    }
    opts.kill?.addEventListener("abort", onKill, { once: true });
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
    worker.on("message", (msg: SeriesScanResponse) => {
      if (msg.type === "progress") opts.onProgress?.(msg.done, msg.total, msg.label);
      else if (msg.type === "done") finish(() => resolve(msg.result));
      else finish(() => reject(new Error(msg.message)));
    });
    worker.on("error", (err) => finish(() => reject(err)));
    worker.on("exit", (code) => {
      if (!settled) finish(() => reject(new Error(`Series-scan worker exited with code ${code}`)));
    });
    worker.postMessage({ type: "scan", source, scan } satisfies SeriesScanRequest);
  });
}
