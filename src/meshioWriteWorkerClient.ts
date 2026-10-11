/**
 * Host-side client for the meshio++ write worker (src/meshioWriteWorker.ts):
 * one worker thread per write, cancellation by terminating it. Registered with
 * `configureMeshioWriteRunner` at activation (and by the MCP server). No
 * vscode imports.
 */

import { Worker } from "node:worker_threads";
import * as path from "node:path";
import type { MdpaModel } from "./parser/types";
import type { MeshioWriteJob, MeshioWriteOutcome, MeshioWriteRunner } from "./parser/writers/meshWriter";
import type { MeshioWriteWorkRequest, MeshioWriteWorkResponse } from "./meshioWriteWorker";

/** Rejection message of a write cancelled from the progress UI or a closed request. */
export const MESHIO_WRITE_CANCELLED = "cancelled";

export interface MeshioWriteWorkerOptions {
  /** Drain the worker's stdout/stderr to our stderr (the MCP server's stdout is JSON-RPC). */
  captureStdio?: boolean;
}

export function createMeshioWriteWorkerRunner(options: MeshioWriteWorkerOptions = {}): MeshioWriteRunner {
  return (model: MdpaModel, ext: string, job: MeshioWriteJob) =>
    new Promise<MeshioWriteOutcome>((resolve, reject) => {
      const { signal, ...plain } = job;
      if (signal?.aborted) {
        reject(new Error(MESHIO_WRITE_CANCELLED));
        return;
      }
      const capture = options.captureStdio === true;
      const worker = new Worker(path.join(__dirname, "meshioWriteWorker.js"), { stdout: capture, stderr: capture });
      if (capture) {
        worker.stdout.on("data", (d: Buffer) => process.stderr.write(d));
        worker.stderr.on("data", (d: Buffer) => process.stderr.write(d));
      }
      let settled = false;
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        settle();
        void worker.terminate();
      };
      const onAbort = (): void => finish(() => reject(new Error(MESHIO_WRITE_CANCELLED)));
      signal?.addEventListener("abort", onAbort, { once: true });
      worker.on("message", (msg: MeshioWriteWorkResponse) => {
        if (msg.type === "done") finish(() => resolve(msg.outcome));
        else finish(() => reject(new Error(msg.message)));
      });
      worker.on("error", (err) => finish(() => reject(err)));
      worker.on("exit", (code) => {
        if (!settled && code !== 0) finish(() => reject(new Error(`meshio++ write worker exited with code ${code}`)));
      });
      try {
        // Structured clone: the live document arrays are never transferred/detached.
        worker.postMessage({ model, ext, job: plain } satisfies MeshioWriteWorkRequest);
      } catch (err) {
        finish(() => reject(err as Error));
      }
    });
}

/** The extension's runner (no stdio capture needed). */
export const runMeshioWriteInWorker = createMeshioWriteWorkerRunner();
