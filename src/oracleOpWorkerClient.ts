/**
 * Host-side client for the oracle-op worker (src/oracleOpWorker.ts): one worker
 * thread per operation, cancellation by terminating it. Registered with
 * `configureOracleRunner` at activation (and by the MCP server) so these ops
 * never block the host; the in-process default stays for plain Node (tests).
 * No vscode imports.
 */

import { Worker } from "node:worker_threads";
import * as path from "node:path";
import type { MdpaModel } from "./parser/types";
import type { MmgRunOptions, OpOutcome, OpRecord } from "./parser/operations";
import type { OracleWorkRequest, OracleWorkResponse } from "./oracleOpWorker";

/** Rejection message of a run cancelled from the progress UI or a closed request. */
export const ORACLE_CANCELLED = "cancelled";

export interface OracleWorkerOptions {
  /**
   * Capture the worker's stdout/stderr and drain it to the parent's stderr.
   * A worker's stdout is otherwise piped to the parent's, which for the MCP
   * server is the JSON-RPC transport.
   */
  captureStdio?: boolean;
}

export function createOracleWorkerRunner(
  options: OracleWorkerOptions = {}
): (model: MdpaModel, rec: OpRecord, opts?: MmgRunOptions) => Promise<OpOutcome> {
  return (model, rec, opts) =>
    new Promise<OpOutcome>((resolve, reject) => {
      if (opts?.signal?.aborted) {
        reject(new Error(ORACLE_CANCELLED));
        return;
      }
      const capture = options.captureStdio === true;
      const worker = new Worker(path.join(__dirname, "oracleOpWorker.js"), {
        stdout: capture,
        stderr: capture,
      });
      if (capture) {
        worker.stdout.on("data", (d: Buffer) => process.stderr.write(d));
        worker.stderr.on("data", (d: Buffer) => process.stderr.write(d));
      }
      let settled = false;
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        opts?.signal?.removeEventListener("abort", onAbort);
        settle();
        void worker.terminate();
      };
      const onAbort = (): void => finish(() => reject(new Error(ORACLE_CANCELLED)));
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      worker.on("message", (msg: OracleWorkResponse) => {
        if (msg.type === "progress") opts?.onProgress?.(msg.message);
        else if (msg.type === "done") {
          // A no-op (or unchanged model) keeps the caller's own object: replay
          // code and the providers compare model identity.
          const { model: out, ...rest } = msg.outcome;
          finish(() => resolve({ ...rest, model: out ?? model }));
        } else finish(() => reject(new Error(msg.message)));
      });
      worker.on("error", (err) => finish(() => reject(err)));
      worker.on("exit", (code) => {
        if (!settled && code !== 0) finish(() => reject(new Error(`Oracle worker exited with code ${code}`)));
      });
      try {
        // Structured clone: the live document arrays are never transferred/detached.
        opts?.onProgress?.(`Sending ${rec.op} to a worker…`);
        worker.postMessage({ model, rec } satisfies OracleWorkRequest);
      } catch (err) {
        finish(() => reject(err as Error));
      }
    });
}

/** The extension's runner: no stdio capture needed (the host has no JSON-RPC stdout). */
export const runOracleInWorker = createOracleWorkerRunner();
