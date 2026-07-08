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

export function runMmgInWorker(
  op: "remesh" | "levelset",
  model: MdpaModel,
  params: RemeshParams | LevelsetParams,
  opts?: MmgRunOptions
): Promise<RemeshResult> {
  return new Promise<RemeshResult>((resolve, reject) => {
    if (opts?.signal?.aborted) {
      reject(new Error(MMG_CANCELLED));
      return;
    }
    const worker = new Worker(path.join(__dirname, "mmgWorker.js"));
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      settle();
      void worker.terminate();
    };
    opts?.signal?.addEventListener("abort", () => finish(() => reject(new Error(MMG_CANCELLED))), {
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
    const request: MmgWorkRequest = { op, model, params };
    worker.postMessage(request);
  });
}
