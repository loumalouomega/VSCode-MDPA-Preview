/**
 * Worker-thread entry point for derived meshes and partition export (roadmap
 * item 2): slice, isosurface, grid / voxelize / SDF volume, decimation, feature
 * edges, and the meshio++ `partition` call (curve or KaHIP). Each awaits a
 * SYNCHRONOUS wasm call, so on the extension host a large input froze every
 * panel and Cancel could only land between stages. One worker per request
 * (src/derivedWorkerClient.ts); cancellation terminates the thread, releasing
 * the WASM heap — which for KaHIP is the ~30 MB full artifact. No vscode imports.
 */

import { parentPort } from "node:worker_threads";
import { runDerivedInProcess } from "./parser/derivedRunner";
import type { DerivedJob, DerivedOutput } from "./parser/derivedRunner";
import type { MdpaDiagnostic } from "./parser/types";

export type DerivedWorkResponse =
  | { type: "progress"; message: string }
  | { type: "done"; output: DerivedOutput; diagnostics: MdpaDiagnostic[] }
  | { type: "error"; message: string };

if (parentPort) {
  const port = parentPort;
  port.on("message", (job: DerivedJob) => {
    void (async () => {
      try {
        port.postMessage({ type: "progress", message: `Running ${job.kind === "derive" ? job.spec.kind : "partition"} in a worker…` } satisfies DerivedWorkResponse);
        const diagnostics: MdpaDiagnostic[] = [];
        const output = await runDerivedInProcess(job, diagnostics, {});
        port.postMessage({ type: "done", output, diagnostics } satisfies DerivedWorkResponse);
      } catch (err) {
        port.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) } satisfies DerivedWorkResponse);
      }
    })();
  });
}
