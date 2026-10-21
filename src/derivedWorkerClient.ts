/**
 * Host-side client for the derived-mesh / partition worker (src/derivedWorker.ts):
 * one worker thread per request, cancellation by terminating it. Installed with
 * `configureDerivedRunner` at activation and by the MCP server. No vscode imports.
 */

import { Worker } from "node:worker_threads";
import * as path from "node:path";
import { trackEngine } from "./engineActivity";
import type { DerivedJob, DerivedOutput, DerivedRunner } from "./parser/derivedRunner";
import type { DerivedWorkResponse } from "./derivedWorker";

export const DERIVED_CANCELLED = "cancelled";

export interface DerivedWorkerOptions {
  /** Drain the worker's stdout/stderr to the parent's stderr (the MCP server's stdout is JSON-RPC). */
  captureStdio?: boolean;
}

export function createDerivedWorkerRunner(options: DerivedWorkerOptions = {}): DerivedRunner {
  return (job, diagnostics, opts) =>
    trackEngine(
      "meshio",
      () =>
        new Promise<DerivedOutput>((resolve, reject) => {
          if (opts.signal?.aborted) {
            reject(new Error(DERIVED_CANCELLED));
            return;
          }
          const capture = options.captureStdio === true;
          const worker = new Worker(path.join(__dirname, "derivedWorker.js"), { stdout: capture, stderr: capture });
          if (capture) {
            worker.stdout.on("data", (d: Buffer) => process.stderr.write(d));
            worker.stderr.on("data", (d: Buffer) => process.stderr.write(d));
          }
          let settled = false;
          const finish = (settle: () => void) => {
            if (settled) return;
            settled = true;
            opts.signal?.removeEventListener("abort", onAbort);
            settle();
            void worker.terminate();
          };
          const onAbort = (): void => finish(() => reject(new Error(DERIVED_CANCELLED)));
          opts.signal?.addEventListener("abort", onAbort, { once: true });
          worker.on("message", (msg: DerivedWorkResponse) => {
            if (msg.type === "progress") opts.onProgress?.(msg.message);
            else if (msg.type === "done") {
              diagnostics.push(...msg.diagnostics);
              finish(() => resolve(msg.output));
            } else finish(() => reject(new Error(msg.message)));
          });
          worker.on("error", (err) => finish(() => reject(err)));
          worker.on("exit", (code) => {
            if (!settled && code !== 0) finish(() => reject(new Error(`Derived-mesh worker exited with code ${code}`)));
          });
          try {
            opts.onProgress?.("Sending to a worker…");
            // Structured clone: the live document arrays are never transferred/detached.
            worker.postMessage(job satisfies DerivedJob);
          } catch (err) {
            finish(() => reject(err as Error));
          }
        })
    );
}

/** The extension's runner (no stdio capture needed). */
export const runDerivedInWorker = createDerivedWorkerRunner();
