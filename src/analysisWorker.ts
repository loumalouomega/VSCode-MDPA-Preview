/**
 * Worker-thread entry point for the webview's wasm-backed analyses (roadmap item 2).
 *
 * The line probe, the watertight check, the field integrals and the preview
 * level of detail each await a SYNCHRONOUS meshio++ wasm call: `await` does not
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
import type { MdpaModel } from "./parser/types";

/** The analyses that run here, with the (structured-cloned) parameters each takes. */
export interface AnalysisParams {
  probe: ProbeParams;
  watertight: undefined;
  integrate: { variables: string[] };
  lod: { ratio?: number };
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
