/**
 * Host-side client for the meshio++ read worker (src/meshioReadWorker.ts): one
 * worker thread per read, cancellation by terminating it. Registered with
 * `configureMeshioReadRunner` at activation (and by the MCP server). No vscode
 * imports.
 */

import { Worker } from "node:worker_threads";
import * as path from "node:path";
import type { MeshioInputFile, MeshioReadJob, MeshioReadResults, MeshioReadRunner } from "./parser/meshio";
import type { MeshioReadWorkRequest, MeshioReadWorkResponse } from "./meshioReadWorker";

/** Rejection message of a read cancelled by a newer request, a closed panel or a cancelled tool call. */
export const MESHIO_READ_CANCELLED = "cancelled";

export interface MeshioReadWorkerOptions {
  /** Drain the worker's stdout/stderr to our stderr (the MCP server's stdout is JSON-RPC). */
  captureStdio?: boolean;
}

/**
 * Structured clone copies a typed array's WHOLE underlying buffer, and a Node
 * `Buffer` from a small `readFile` can be a window onto a pooled slab; a view
 * that does not own its buffer is copied down to its own bytes first.
 */
function ownBytes(files: MeshioInputFile[]): MeshioInputFile[] {
  return files.map((f) =>
    f.data.byteLength === f.data.buffer.byteLength ? f : { name: f.name, data: f.data.slice() }
  );
}

export function createMeshioReadWorkerRunner(options: MeshioReadWorkerOptions = {}): MeshioReadRunner {
  return <K extends keyof MeshioReadResults>(job: MeshioReadJob<K>, signal?: AbortSignal) =>
    new Promise<MeshioReadResults[K]>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error(MESHIO_READ_CANCELLED));
        return;
      }
      const capture = options.captureStdio === true;
      const worker = new Worker(path.join(__dirname, "meshioReadWorker.js"), { stdout: capture, stderr: capture });
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
      const onAbort = (): void => finish(() => reject(new Error(MESHIO_READ_CANCELLED)));
      signal?.addEventListener("abort", onAbort, { once: true });
      worker.on("message", (msg: MeshioReadWorkResponse) => {
        if (msg.type === "done") finish(() => resolve(msg.result as MeshioReadResults[K]));
        else finish(() => reject(new Error(msg.message)));
      });
      worker.on("error", (err) => finish(() => reject(err)));
      worker.on("exit", (code) => {
        if (!settled && code !== 0) finish(() => reject(new Error(`meshio++ read worker exited with code ${code}`)));
      });
      try {
        // Structured clone: the caller's buffers are never transferred/detached.
        worker.postMessage({ job: { ...job, files: ownBytes(job.files) } } satisfies MeshioReadWorkRequest);
      } catch (err) {
        finish(() => reject(err as Error));
      }
    });
}

/** The extension's runner (no stdio capture needed). */
export const runMeshioReadInWorker: MeshioReadRunner = createMeshioReadWorkerRunner();
