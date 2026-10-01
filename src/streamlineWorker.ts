/**
 * Worker-thread entry point for streamline tracing (roadmap item 9).
 *
 * `traceStreamlines` yields to the event loop between seeds but is otherwise
 * synchronous arithmetic — on the extension host a large seed set would freeze
 * every panel until it finishes. The providers run it here instead (one worker
 * per trace, spawned by src/streamlineWorkerClient.ts). Cancellation arrives
 * as a `cancel` message and aborts the run's own controller, so the trace
 * resolves its partial result (`cancelled: true`) rather than rejecting —
 * the same honest-partial contract `flowBalanceSeries` keeps. A `cancel`
 * arriving before its trace arms a pending flag, so a pre-aborted request
 * still validates its parameters and then stops at the first seed.
 *
 * Bundled by esbuild as its own entry (dist/streamlineWorker.js). No vscode,
 * no wasm imports — the core is pure JS.
 */

import { parentPort } from "node:worker_threads";
import { traceStreamlines, StreamlineParams, StreamlineResult } from "./parser/streamlines";
import type { MdpaModel } from "./parser/types";

export type StreamlineWorkRequest =
  | { type: "trace"; model: MdpaModel; params: StreamlineParams }
  | { type: "cancel" };

export type StreamlineWorkResponse =
  | { type: "progress"; done: number; total: number }
  | { type: "done"; result: StreamlineResult }
  | { type: "error"; message: string };

if (parentPort) {
  const port = parentPort;
  const post = (msg: StreamlineWorkResponse) => port.postMessage(msg);
  let abort: AbortController | undefined;
  let cancelPending = false;
  port.on("message", (req: StreamlineWorkRequest) => {
    if (req.type === "cancel") {
      if (abort) abort.abort();
      else cancelPending = true;
      return;
    }
    void (async () => {
      abort = new AbortController();
      if (cancelPending) {
        cancelPending = false;
        abort.abort();
      }
      try {
        const signal = abort.signal;
        const result = await traceStreamlines(req.model, req.params, {
          signal,
          onProgress: (done, total) => post({ type: "progress", done, total }),
        });
        post({ type: "done", result });
      } catch (err) {
        post({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        abort = undefined;
      }
    })();
  });
}
