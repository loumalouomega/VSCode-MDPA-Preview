/**
 * Worker-thread entry point for meshio++ READS (roadmap item 2, eighth
 * increment). A read is staging into MEMFS, one synchronous wasm `readMesh`
 * (or `readMetadata`) call and the conversion to an `MdpaModel`; on the
 * extension host a large mesh froze every panel for its duration, and a read
 * made stale by a newer timeline request still ran to completion before its
 * result was dropped. The staged bytes are structured-cloned in, read here, and
 * the finished model (or time list, or metadata) is cloned back. One request
 * per worker; cancellation terminates the thread (src/meshioReadWorkerClient.ts),
 * which also releases the WASM heap.
 *
 * Bundled by esbuild as its own entry (dist/meshioReadWorker.js, beside the
 * wasm loader's `dist/meshio/`). No vscode imports.
 */

import { parentPort } from "node:worker_threads";
import { markSingleOperationThread, readMeshioInProcess } from "./parser/meshio";
import type { MeshioReadJob, MeshioReadResults } from "./parser/meshio";

// One read per worker thread, which then ends (see markSingleOperationThread).
markSingleOperationThread();

export interface MeshioReadWorkRequest {
  job: MeshioReadJob;
}

export type MeshioReadWorkResponse =
  | { type: "done"; result: MeshioReadResults[keyof MeshioReadResults] }
  | { type: "error"; message: string };

if (parentPort) {
  const port = parentPort;
  port.on("message", (req: MeshioReadWorkRequest) => {
    void (async () => {
      try {
        const result = await readMeshioInProcess(req.job);
        port.postMessage({ type: "done", result } satisfies MeshioReadWorkResponse);
      } catch (err) {
        port.postMessage({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        } satisfies MeshioReadWorkResponse);
      }
    })();
  });
}
