import { Worker } from "node:worker_threads";
import * as path from "node:path";
import type { PlotWork, PlotWorkReply } from "./plotWorker";
import type { PlotDataset, PlotExecution, PlotTable } from "./parser/plot/types";
import { evaluatePlot } from "./parser/plot/numerics";

/** One owner/request at a time; cancellation terminates synchronous parsers too.
 * Successful requests retain a bounded worker-local extraction cache. */
export class PlotWorkerSession {
  private worker?: Worker;
  private cancel?: () => void;
  run(work: PlotWork, opts: PlotExecution = {}): Promise<PlotDataset | PlotTable> {
    this.cancel?.();
    return new Promise((resolve, reject) => {
      if (opts.signal?.aborted) { reject(new Error("Plot request cancelled.")); return; }
      const worker = this.worker ??= new Worker(path.join(__dirname, "plotWorker.js"));
      let settled = false;
      let partial: PlotDataset | undefined;
      const finish = (fn: () => void, terminate = false) => {
        if (settled) return;
        settled = true;
        opts.signal?.removeEventListener("abort", abort);
        worker.off("message", message); worker.off("error", error); worker.off("exit", exit);
        this.cancel = undefined;
        if (terminate) { this.worker = undefined; void worker.terminate(); }
        fn();
      };
      const abort = () => finish(() => {
        if ("recipe" in work) {
          const result = partial ?? evaluatePlot(work.recipe, {}); result.partial = true;
          result.diagnostics.unshift(partial ? "Cancelled: retained published samples only; result is incomplete." : "Cancelled before a complete dataset was published; unfinished computations are not represented as complete. Refresh to retry.");
          resolve(result);
        } else reject(new Error("Table import cancelled."));
      }, true);
      const message = (msg: PlotWorkReply) => {
        if (msg.type === "progress") opts.progress?.(msg.done, msg.total, msg.label);
        else if (msg.type === "partial") { partial=msg.result;opts.partial?.(partial); }
        else if (msg.type === "done") finish(() => resolve(msg.result));
        else finish(() => reject(new Error(msg.message)));
      };
      const error = (e: Error) => finish(() => reject(e), true);
      const exit = (code: number) => finish(() => reject(new Error(`Plot worker exited without a result (${code}).`)), true);
      this.cancel = abort;
      opts.signal?.addEventListener("abort", abort, { once: true });
      worker.on("message", message); worker.on("error", error); worker.on("exit", exit);
      // Structured clone: live document arrays are NEVER transferred/detached.
      try { worker.postMessage(work); } catch (e) { error(e as Error); }
    });
  }
  dispose(): void { this.cancel?.(); if (this.worker) void this.worker.terminate(); this.worker = undefined; }
}

/** Independent MCP calls do not share cancellation ownership. */
export async function runPlotWorker(work: PlotWork, opts: PlotExecution = {}): Promise<PlotDataset | PlotTable> {
  const session = new PlotWorkerSession();
  try { return await session.run(work, opts); } finally { session.dispose(); }
}
