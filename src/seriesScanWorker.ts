/**
 * Worker-thread entry point for the multi-file series scans (roadmap item 2):
 * Inspect ▸ Plot over time and the Flow-balance panel's All steps.
 *
 * Each step is a file parse (possibly a synchronous meshio++ wasm call) plus
 * synchronous sampling or flux arithmetic; on the extension host a long series
 * froze every panel. The providers run the scan here instead (one worker per
 * scan, spawned by src/seriesScanWorkerClient.ts).
 *
 * Cancellation is COOPERATIVE and arrives as a `cancel` message: it aborts the
 * scan's own controller, the scan stops between steps and resolves the partial
 * series (`cancelled: true`) rather than rejecting — half a hundred-step scan is
 * still worth plotting. A `cancel` arriving before the job arms a pending flag.
 * A wedged thread is the client's backstop (`terminate()`).
 *
 * Bundled by esbuild as its own entry (dist/seriesScanWorker.js, beside the
 * wasm loader's `dist/meshio/`). No vscode imports.
 */

import { parentPort } from "node:worker_threads";
import { runSeriesScan, stepsForSource } from "./seriesScanJob";
import type { SeriesScan, SeriesScanResult, SeriesScanSource } from "./seriesScanJob";

export type SeriesScanRequest =
  | { type: "scan"; source: SeriesScanSource; scan: SeriesScan }
  | { type: "cancel" };

export type SeriesScanResponse =
  | { type: "progress"; done: number; total: number; label: string }
  | { type: "done"; result: SeriesScanResult }
  | { type: "error"; message: string };

if (parentPort) {
  const port = parentPort;
  const post = (msg: SeriesScanResponse) => port.postMessage(msg);
  let abort: AbortController | undefined;
  let cancelPending = false;
  port.on("message", (req: SeriesScanRequest) => {
    if (req.type === "cancel") {
      if (abort) abort.abort();
      else cancelPending = true;
      return;
    }
    void (async () => {
      abort = new AbortController();
      if (cancelPending) {
        cancelPending = false;
        abort.abort();
      }
      try {
        const result = await runSeriesScan(stepsForSource(req.source), req.scan, {
          signal: abort.signal,
          onProgress: (done, total, label) => post({ type: "progress", done, total, label }),
        });
        post({ type: "done", result });
      } catch (err) {
        post({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        abort = undefined;
      }
    })();
  });
}
