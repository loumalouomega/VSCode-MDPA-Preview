/**
 * Host-side client for the MMG worker (src/mmgWorker.ts): spawns one worker
 * thread per operation, forwards its progress lines, and implements
 * cancellation by terminating the thread. Registered as the MMG runner via
 * `configureMmgRunner` at activation so the op pipeline never blocks the
 * extension host; the in-process default stays in place for plain Node
 * (tests). No vscode imports.
 */

import { Worker } from "node:worker_threads";
import * as path from "node:path";
import { MdpaModel } from "./parser/types";
import type { RemeshParams, LevelsetParams, RemeshResult } from "./parser/remesh";
import type { MmgRunOptions } from "./parser/operations";

export interface MmgWorkRequest {
  op: "remesh" | "levelset";
  model: MdpaModel;
  params: RemeshParams | LevelsetParams;
}

export type MmgWorkResponse =
  | { type: "progress"; message: string }
  | { type: "done"; result: RemeshResult }
  | { type: "error"; message: string };

/** Thrown (as Error message) when the run was cancelled from the progress UI. */
export const MMG_CANCELLED = "cancelled";

export interface MmgWorkerOptions {
  /**
   * Capture the worker's stdout/stderr and drain it to the parent's stderr.
   * A worker's stdout is otherwise piped to the parent's, which for the MCP
   * server is the JSON-RPC transport.
   */
  captureStdio?: boolean;
}

export function createMmgWorkerRunner(
  options: MmgWorkerOptions = {}
): (
  op: "remesh" | "levelset",
  model: MdpaModel,
  params: RemeshParams | LevelsetParams,
  opts?: MmgRunOptions
) => Promise<RemeshResult> {
  return (op, model, params, opts) =>
    new Promise<RemeshResult>((resolve, reject) => {
      if (opts?.signal?.aborted) {
        reject(new Error(MMG_CANCELLED));
        return;
      }
      const capture = options.captureStdio === true;
      const worker = new Worker(path.join(__dirname, "mmgWorker.js"), {
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
      const onAbort = (): void => finish(() => reject(new Error(MMG_CANCELLED)));
      opts?.signal?.addEventListener("abort", onAbort, {
        once: true,
      });
      worker.on("message", (msg: MmgWorkResponse) => {
        if (msg.type === "progress") opts?.onProgress?.(msg.message);
        else if (msg.type === "done") finish(() => resolve(msg.result));
        else finish(() => reject(new Error(msg.message)));
      });
      worker.on("error", (err) => finish(() => reject(err)));
      worker.on("exit", (code) => {
        if (!settled && code !== 0) {
          finish(() => reject(new Error(`MMG worker exited with code ${code}`)));
        }
      });
      try {
        const request: MmgWorkRequest = { op, model, params };
        worker.postMessage(request);
      } catch (err) {
        finish(() => reject(err as Error));
      }
    });
}

/** The extension's runner: no stdio capture needed (the host has no JSON-RPC stdout). */
export const runMmgInWorker = createMmgWorkerRunner();
