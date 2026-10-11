/**
 * Host-side client for the analysis worker (src/analysisWorker.ts): one worker
 * thread per request, cancellation by terminating it. Each typed wrapper is a
 * drop-in for the in-process core with an extra `{ signal }`, so
 * `runMeshAnalysis` takes them as its `*Runner` seams and tests keep the
 * in-process defaults. No vscode imports.
 */

import { Worker } from "node:worker_threads";
import * as path from "node:path";
import type { MdpaModel } from "./parser/types";
import type { ProbeParams, ProbeResult } from "./parser/pathProbe";
import type { WatertightReport } from "./parser/watertight";
import type { FieldIntegral } from "./parser/fieldIntegrate";
import type { LodSurface } from "./parser/lodSurface";
import type { AnalysisKind, AnalysisParams, AnalysisWorkRequest, AnalysisWorkResponse } from "./analysisWorker";

/** The rejection message of an analysis that was cancelled (superseded, closed or disposed). */
export const ANALYSIS_CANCELLED = "cancelled";
/** Historical name of the same constant (the probe was the first analysis moved here). */
export const PROBE_CANCELLED = ANALYSIS_CANCELLED;

type RunOpts = { signal?: AbortSignal };

export function runInAnalysisWorker<K extends AnalysisKind>(
  kind: K,
  model: MdpaModel,
  params: AnalysisParams[K],
  opts?: RunOpts
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    if (opts?.signal?.aborted) {
      reject(new Error(ANALYSIS_CANCELLED));
      return;
    }
    const worker = new Worker(path.join(__dirname, "analysisWorker.js"));
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      opts?.signal?.removeEventListener("abort", onAbort);
      settle();
      void worker.terminate();
    };
    const onAbort = (): void => finish(() => reject(new Error(ANALYSIS_CANCELLED)));
    opts?.signal?.addEventListener("abort", onAbort, { once: true });
    worker.on("message", (msg: AnalysisWorkResponse) => {
      if (msg.type === "done") finish(() => resolve(msg.result));
      else finish(() => reject(new Error(msg.message)));
    });
    worker.on("error", (err) => finish(() => reject(err)));
    worker.on("exit", (code) => {
      if (!settled && code !== 0) finish(() => reject(new Error(`Analysis worker exited with code ${code}`)));
    });
    // Structured clone: the live document arrays are never transferred/detached.
    try {
      worker.postMessage({ type: kind, model, params } as AnalysisWorkRequest);
    } catch (err) {
      finish(() => reject(err as Error));
    }
  });
}

export const runProbeInWorker = (model: MdpaModel, params: ProbeParams, opts?: RunOpts): Promise<ProbeResult> =>
  runInAnalysisWorker("probe", model, params, opts) as Promise<ProbeResult>;

export const runWatertightInWorker = (model: MdpaModel, opts?: RunOpts): Promise<WatertightReport | undefined> =>
  runInAnalysisWorker("watertight", model, undefined, opts) as Promise<WatertightReport | undefined>;

export const runIntegrateInWorker = (model: MdpaModel, variables: string[], opts?: RunOpts): Promise<FieldIntegral[]> =>
  runInAnalysisWorker("integrate", model, { variables }, opts) as Promise<FieldIntegral[]>;

export const runLodInWorker = (model: MdpaModel, ratio?: number, opts?: RunOpts): Promise<LodSurface> =>
  runInAnalysisWorker("lod", model, { ratio }, opts) as Promise<LodSurface>;
