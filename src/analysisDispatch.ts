/**
 * Per-kind "latest request wins" dispatch for the worker-backed `meshAnalysis`
 * kinds (roadmap item 2; no vscode imports). Each kind owns one superseding
 * runner, so a new probe cancels the previous probe but never an in-flight
 * integral; `run` resolves `undefined` for a superseded or cancelled request,
 * and the caller posts only a defined reply — a late success or failure can
 * therefore never overwrite a newer one.
 */

import { createSupersedingRunner, SupersedingRunner } from "./analysisSupersede";
import { MeshAnalysisMessage, runMeshAnalysis, WORKER_KINDS } from "./meshAnalysis";
import {
  runFeatureEdgesInWorker,
  runFlowBalanceInWorker,
  runHausdorffInWorker,
  runIntegrateInWorker,
  runLodInWorker,
  runPeriodicNodesInWorker,
  runProbeInWorker,
  runQualityGateInWorker,
  runWatertightInWorker,
} from "./analysisWorkerClient";
import { runStreamlinesInWorker } from "./streamlineWorkerClient";
import type { MdpaModel } from "./parser/types";

export type WorkerRunners = Pick<
  NonNullable<Parameters<typeof runMeshAnalysis>[2]>,
  | "probeRunner" | "watertightRunner" | "integrateRunner" | "lodRunner"
  | "qualityGateRunner" | "hausdorffRunner" | "periodicRunner" | "featureEdgesRunner" | "flowBalanceRunner"
>;

const WORKER_RUNNERS: WorkerRunners = {
  probeRunner: runProbeInWorker,
  watertightRunner: runWatertightInWorker,
  integrateRunner: runIntegrateInWorker,
  lodRunner: runLodInWorker,
  qualityGateRunner: runQualityGateInWorker,
  hausdorffRunner: runHausdorffInWorker,
  periodicRunner: runPeriodicNodesInWorker,
  featureEdgesRunner: runFeatureEdgesInWorker,
  flowBalanceRunner: runFlowBalanceInWorker,
};

export interface AnalysisDispatcher {
  /** True when `kind` is handled here (otherwise the provider's own path applies). */
  handles(kind: string | undefined): boolean;
  run(msg: MeshAnalysisMessage, model: MdpaModel | undefined): Promise<Record<string, unknown> | undefined>;
  /** Cancel one kind (the probe panel closing) or, without an argument, all of them (disposal). */
  cancel(kind?: string): void;
}

export function createAnalysisDispatcher(runners: WorkerRunners = WORKER_RUNNERS): AnalysisDispatcher {
  const byKind = new Map<string, SupersedingRunner>();
  const runnerFor = (kind: string): SupersedingRunner => {
    let r = byKind.get(kind);
    if (!r) byKind.set(kind, (r = createSupersedingRunner()));
    return r;
  };
  return {
    handles: (kind) => !!kind && WORKER_KINDS.has(kind),
    run: (msg, model) =>
      runnerFor(msg.kind ?? "").run((signal) => runMeshAnalysis(msg, model, { signal, ...runners })),
    cancel(kind) {
      if (kind) byKind.get(kind)?.cancel();
      else for (const r of byKind.values()) r.cancel();
    },
  };
}

/**
 * The streamline trace's own controller, shared by the three providers (it was
 * a byte-identical closure in each). It is NOT a `SupersedingRunner` kind, on
 * purpose: a superseded or cancelled superseding run resolves `undefined`, but
 * an explicit Cancel here must still post the PARTIAL result under the current
 * tag so the panel draws what completed — the trace worker resolves it with
 * `cancelled: true` rather than rejecting. A newer request still replaces the
 * in-flight one (its partial reply is dropped by the webview's sequence tag),
 * and disposal aborts.
 */
export interface StreamlineController {
  run(
    msg: MeshAnalysisMessage,
    model: MdpaModel | undefined,
    post: (message: Record<string, unknown>) => void
  ): Promise<void>;
  cancel(): void;
}

export function createStreamlineController(
  traceRunner: NonNullable<Parameters<typeof runMeshAnalysis>[2]>["traceRunner"] = runStreamlinesInWorker
): StreamlineController {
  let current: AbortController | undefined;
  return {
    async run(msg, model, post) {
      current?.abort();
      const abort = new AbortController();
      current = abort;
      try {
        const reply = await runMeshAnalysis(msg, model, {
          signal: abort.signal,
          onProgress: (done, total) => post({ type: "streamlineProgress", done, total, seq: msg.seq }),
          traceRunner,
        });
        post(reply);
      } finally {
        if (current === abort) current = undefined;
      }
    },
    cancel() {
      current?.abort();
    },
  };
}
