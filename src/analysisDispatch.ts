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
  runIntegrateInWorker,
  runLodInWorker,
  runProbeInWorker,
  runWatertightInWorker,
} from "./analysisWorkerClient";
import type { MdpaModel } from "./parser/types";

export type WorkerRunners = Pick<
  NonNullable<Parameters<typeof runMeshAnalysis>[2]>,
  "probeRunner" | "watertightRunner" | "integrateRunner" | "lodRunner"
>;

const WORKER_RUNNERS: WorkerRunners = {
  probeRunner: runProbeInWorker,
  watertightRunner: runWatertightInWorker,
  integrateRunner: runIntegrateInWorker,
  lodRunner: runLodInWorker,
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
