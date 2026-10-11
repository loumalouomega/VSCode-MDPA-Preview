/**
 * Host-side client for the probe worker (src/probeWorker.ts): one worker thread
 * per request, cancellation by terminating it. A drop-in for `probeAlongPath`
 * with an extra `{ signal }`, so `runMeshAnalysis` takes it as its
 * `probeRunner` and tests keep the in-process default. No vscode imports.
 */

import { Worker } from "node:worker_threads";
import * as path from "node:path";
import type { MdpaModel } from "./parser/types";
import type { ProbeParams, ProbeResult } from "./parser/pathProbe";
import type { ProbeWorkRequest, ProbeWorkResponse } from "./probeWorker";

/** The rejection message of a probe that was cancelled (superseded, closed or disposed). */
export const PROBE_CANCELLED = "cancelled";

export function runProbeInWorker(
  model: MdpaModel,
  params: ProbeParams,
  opts?: { signal?: AbortSignal }
): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve, reject) => {
    if (opts?.signal?.aborted) {
      reject(new Error(PROBE_CANCELLED));
      return;
    }
    const worker = new Worker(path.join(__dirname, "probeWorker.js"));
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      opts?.signal?.removeEventListener("abort", onAbort);
      settle();
      void worker.terminate();
    };
    const onAbort = (): void => finish(() => reject(new Error(PROBE_CANCELLED)));
    opts?.signal?.addEventListener("abort", onAbort, { once: true });
    worker.on("message", (msg: ProbeWorkResponse) => {
      if (msg.type === "done") finish(() => resolve(msg.result));
      else finish(() => reject(new Error(msg.message)));
    });
    worker.on("error", (err) => finish(() => reject(err)));
    worker.on("exit", (code) => {
      if (!settled && code !== 0) finish(() => reject(new Error(`Probe worker exited with code ${code}`)));
    });
    // Structured clone: the live document arrays are never transferred/detached.
    try {
      worker.postMessage({ type: "probe", model, params } satisfies ProbeWorkRequest);
    } catch (err) {
      finish(() => reject(err as Error));
    }
  });
}
