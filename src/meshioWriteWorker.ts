/**
 * Worker-thread entry point for meshio++ mesh WRITES (roadmap item 2). A
 * export is `modelToMeshio` plus one synchronous wasm `writeMesh` call and a
 * MEMFS harvest; on the extension host a large mesh froze every panel for its
 * duration and a save could not be cancelled. The model is structured-cloned
 * in, written here, and the bytes (and companions, and the diagnostics the
 * conversion produced) are cloned back; the `fs` writes and the export report
 * stay on the host. One request per worker; cancellation terminates the thread
 * (src/meshioWriteWorkerClient.ts), which also releases the WASM heap.
 *
 * Bundled by esbuild as its own entry (dist/meshioWriteWorker.js, beside the
 * wasm loader's `dist/meshio/`). No vscode imports.
 */

import { parentPort } from "node:worker_threads";
import { writeMeshioInProcess } from "./parser/writers/meshWriter";
import type { MeshioWriteJob, MeshioWriteOutcome } from "./parser/writers/meshWriter";
import type { MdpaModel } from "./parser/types";

export interface MeshioWriteWorkRequest {
  model: MdpaModel;
  ext: string;
  /** The job minus its AbortSignal, which cannot cross a thread. */
  job: Omit<MeshioWriteJob, "signal">;
}

export type MeshioWriteWorkResponse =
  | { type: "done"; outcome: MeshioWriteOutcome }
  | { type: "error"; message: string };

if (parentPort) {
  const port = parentPort;
  port.on("message", (req: MeshioWriteWorkRequest) => {
    void (async () => {
      try {
        const outcome = await writeMeshioInProcess(req.model, req.ext, req.job);
        port.postMessage({ type: "done", outcome } satisfies MeshioWriteWorkResponse);
      } catch (err) {
        port.postMessage({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        } satisfies MeshioWriteWorkResponse);
      }
    })();
  });
}
