/**
 * Host-side client for the streamline worker (src/streamlineWorker.ts): one
 * worker thread per trace, progress forwarded per seed, cancellation by
 * message (the worker aborts its own controller and resolves the partial
 * result with `cancelled: true`). A drop-in for `traceStreamlines` — same
 * `(model, params, opts)` shape — so `runMeshAnalysis` takes it as its
 * `traceRunner` and tests keep the in-process default. No vscode imports.
 */

import { Worker } from "node:worker_threads";
import * as path from "node:path";
import type { MdpaModel } from "./parser/types";
import type { StreamlineOptions, StreamlineParams, StreamlineResult } from "./parser/streamlines";
import type { StreamlineWorkRequest, StreamlineWorkResponse } from "./streamlineWorker";

export function runStreamlinesInWorker(
  model: MdpaModel,
  params: StreamlineParams,
  opts?: StreamlineOptions
): Promise<StreamlineResult> {
  return new Promise<StreamlineResult>((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "streamlineWorker.js"));
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      settle();
      void worker.terminate();
    };
    const onAbort = (): void => {
      // The worker resolves the partial result; without a reply (a wedged
      // thread) the exit handler below is the backstop, never a hang.
      worker.postMessage({ type: "cancel" } satisfies StreamlineWorkRequest);
    };
    if (opts?.signal?.aborted) {
      // Delivered first so it is already queued when the trace starts: a
      // pre-aborted run still validates, then stops at the first seed.
      worker.postMessage({ type: "cancel" } satisfies StreamlineWorkRequest);
    } else {
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
    }
    worker.on("message", (msg: StreamlineWorkResponse) => {
      if (msg.type === "progress") opts?.onProgress?.(msg.done, msg.total);
      else if (msg.type === "done") finish(() => resolve(msg.result));
      else finish(() => reject(new Error(msg.message)));
    });
    worker.on("error", (err) => finish(() => reject(err)));
    worker.on("exit", (code) => {
      if (!settled && code !== 0) {
        finish(() => reject(new Error(`Streamline worker exited with code ${code}`)));
      }
    });
    worker.postMessage({ type: "trace", model, params } satisfies StreamlineWorkRequest);
  });
}
