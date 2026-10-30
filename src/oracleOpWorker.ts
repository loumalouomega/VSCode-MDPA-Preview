/**
 * Worker-thread entry point for the meshio++ oracle and adopting operations
 * (roadmap item 2): smooth, reorder, partition, the gradient/Hessian/error
 * oracles, signed distance, field transfer, curvature, shrinkwrap, Sobolev
 * deformation, field comparison, surface repair and the surface/volume
 * (re)meshers. Each is one SYNCHRONOUS wasm call, so on the extension host it
 * froze every panel and its Cancel button could not interrupt it. They run here
 * instead (one worker per op, spawned by src/oracleOpWorkerClient.ts), and
 * cancellation terminates the thread, which also releases the grown WASM heap.
 * A second mesh an op needs (transfer, compare, signed distance to a file) is
 * read inside this thread, so the host never touches that wasm either.
 *
 * Bundled by esbuild as its own entry (dist/oracleOpWorker.js, beside the wasm
 * loader's `dist/meshio/`). No vscode imports.
 */

import { parentPort } from "node:worker_threads";
import { applyOracleOp } from "./parser/operations";
import type { OpRecord } from "./parser/operations";
import type { MdpaModel } from "./parser/types";
import { markSingleOperationThread } from "./parser/meshio";

// One operation per worker thread, which then ends (see markSingleOperationThread).
markSingleOperationThread();

export interface OracleWorkRequest {
  model: MdpaModel;
  rec: OpRecord;
}

/** `noop` outcomes carry no model: the client hands back the caller's own object. */
export type OracleWorkResponse =
  | { type: "progress"; message: string }
  | { type: "done"; outcome: { model?: MdpaModel; noop?: boolean; message?: string; highlightNodes?: number[] } }
  | { type: "error"; message: string };

if (parentPort) {
  const port = parentPort;
  const post = (msg: OracleWorkResponse) => port.postMessage(msg);
  port.on("message", (req: OracleWorkRequest) => {
    void (async () => {
      try {
        post({ type: "progress", message: `Running ${req.rec.op} in a worker…` });
        const out = await applyOracleOp(req.model, req.rec);
        // A no-op returns the input object unchanged; do not clone it back.
        const outcome = out.model === req.model || out.noop ? { ...out, model: undefined } : out;
        post({ type: "done", outcome });
      } catch (err) {
        post({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
    })();
  });
}
