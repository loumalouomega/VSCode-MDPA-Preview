/**
 * Worker-thread entry point for the webview's wasm-backed analyses (roadmap item 2).
 *
 * The line probe, the watertight check, the field integrals, the preview
 * level of detail, the quality gate, Hausdorff distance, periodic matching,
 * feature edges and the flow balance each await a SYNCHRONOUS meshio++ wasm call: `await` does not
 * free the thread it runs on, so on the extension host a large mesh froze every
 * panel. The providers run them here instead (one worker per request, spawned
 * by src/analysisWorkerClient.ts). There is no cooperative cancel — a wasm call
 * cannot be interrupted — so a superseded or abandoned request is cancelled by
 * terminating the thread, which also releases the grown WASM heap.
 *
 * Bundled by esbuild as its own entry (dist/analysisWorker.js, beside the wasm
 * loader's `dist/meshio/`). No vscode imports.
 */

import { parentPort } from "node:worker_threads";
import { probeAlongPath, ProbeParams } from "./parser/pathProbe";
import { watertightReport } from "./parser/watertight";
import { integrateFields } from "./parser/fieldIntegrate";
import { lodSurface } from "./parser/lodSurface";
import { featureEdges, hausdorff, periodicNodes, qualityGate } from "./parser/analysisOps";
import type { FeatureEdgeOptions, PeriodicOptions } from "./parser/analysisOps";
import { flowBalance } from "./parser/flowBalance";
import type { FlowBalanceSpec } from "./parser/flowBalance";
import type { MdpaModel } from "./parser/types";

/** The analyses that run here, with the (structured-cloned) parameters each takes. */
export interface AnalysisParams {
  probe: ProbeParams;
  watertight: undefined;
  integrate: { variables: string[] };
  lod: { ratio?: number };
  qualityGate: { require?: string; maxInverted?: number; maxDegenerate?: number };
  /** `other` is read on the host (file I/O) and structured-cloned in. */
  hausdorff: { other: MdpaModel; faceSamples?: number };
  periodicNodes: PeriodicOptions;
  featureEdges: FeatureEdgeOptions;
  flowBalance: { spec: FlowBalanceSpec };
}
export type AnalysisKind = keyof AnalysisParams;

export type AnalysisWorkRequest = {
  [K in AnalysisKind]: { type: K; model: MdpaModel; params: AnalysisParams[K] };
}[AnalysisKind];

export type AnalysisWorkResponse =
  | { type: "done"; result: unknown }
  | { type: "error"; message: string };

async function execute(req: AnalysisWorkRequest): Promise<unknown> {
  switch (req.type) {
    case "probe": return probeAlongPath(req.model, req.params);
    case "watertight": return watertightReport(req.model);
    case "integrate": return integrateFields(req.model, req.params.variables);
    case "lod": return lodSurface(req.model, req.params.ratio);
    case "qualityGate": return qualityGate(req.model, req.params.require, req.params.maxInverted, req.params.maxDegenerate);
    case "hausdorff": return hausdorff(req.model, req.params.other, req.params.faceSamples);
    case "periodicNodes": return periodicNodes(req.model, req.params);
    case "featureEdges": return featureEdges(req.model, req.params);
    case "flowBalance": return flowBalance(req.model, req.params.spec);
    default: throw new Error(`Unknown analysis "${(req as { type: string }).type}".`);
  }
}

if (parentPort) {
  const port = parentPort;
  port.on("message", (req: AnalysisWorkRequest) => {
    void (async () => {
      try {
        const result = await execute(req);
        port.postMessage({ type: "done", result } satisfies AnalysisWorkResponse);
      } catch (err) {
        port.postMessage({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        } satisfies AnalysisWorkResponse);
      }
    })();
  });
}
