/**
 * Host half of the multi-file series scans (Plot over time, Flow balance ▸ All
 * steps; roadmap item 2). No vscode imports, so it is Node-testable: a provider
 * hands in `post`, the edit-history depth and a source resolver.
 *
 * It replaces three near-identical copies in the VTK, MDPA and empty-preview
 * providers. The rules each copy kept are kept here once: the request is raw
 * webview input and is validated, the source is SNAPSHOT before the first
 * `await` (a watcher-driven `discover()` reassigns the group on a 500 ms
 * debounce), one scan per panel, abort on dispose, a partial series on cancel,
 * and a `historyNote` because the scan reads files as they are on disk and does
 * not replay applied edits per step.
 *
 * The scan runs in a worker thread (src/seriesScanWorker.ts). A source that
 * carries closures — a resampled timeline — cannot cross a thread and runs
 * in-process instead, the previous behaviour for that one source.
 */

import type { SeriesStep } from "./parser/fieldSeries";
import { runSeriesScan } from "./seriesScanJob";
import type { SeriesScan, SeriesScanOptions, SeriesScanResult, SeriesScanSource } from "./seriesScanJob";
import { runSeriesScanInWorker } from "./seriesScanWorkerClient";
import type { FlowBalanceSpec } from "./parser/flowBalance";

/** What to scan: plain data for the worker, or already-built steps for the in-process fallback. */
export type SeriesScanInput = { source: SeriesScanSource } | { steps: SeriesStep[] };

export interface SeriesScanHostDeps {
  /** Posts to the webview; the controller never posts after `dispose()`. */
  post(message: Record<string, unknown>): void;
  /** Applied edit operations, for the `historyNote`. */
  appliedCount(): number;
  /** Test seam; defaults to the real worker client. */
  runInWorker?: (source: SeriesScanSource, scan: SeriesScan, opts?: SeriesScanOptions) => Promise<SeriesScanResult>;
}

export interface SeriesScanController {
  /** `fieldSeries` request. `resolve` is called synchronously, before any await. */
  field(msg: Record<string, unknown>, resolve: () => SeriesScanInput | undefined): Promise<void>;
  /** `flowSeries` request. */
  flow(msg: Record<string, unknown>, resolve: () => SeriesScanInput | undefined): Promise<void>;
  cancelField(): void;
  cancelFlow(): void;
  /** Aborts both scans (their workers are terminated) and silences further posts. */
  dispose(): void;
}

const FIELD_KINDS = ["Nodal", "Elemental", "Conditional"];

export function createSeriesScanController(deps: SeriesScanHostDeps): SeriesScanController {
  const inWorker = deps.runInWorker ?? runSeriesScanInWorker;
  let disposed = false;
  const aborts: { field?: AbortController; flow?: AbortController } = {};
  const killer = new AbortController();

  const run = async (
    which: "field" | "flow",
    scan: SeriesScan,
    input: SeriesScanInput,
    labels: { progress: string; result: string }
  ): Promise<void> => {
    const post = (m: Record<string, unknown>): void => {
      if (!disposed) deps.post(m);
    };
    const abort = new AbortController();
    aborts[which] = abort;
    const opts: SeriesScanOptions = {
      signal: abort.signal,
      kill: killer.signal,
      onProgress: (done, total, label) => post({ type: labels.progress, done, total, label }),
    };
    try {
      const series = "source" in input
        ? await inWorker(input.source, scan, opts)
        : await runSeriesScan(input.steps, scan, opts);
      const applied = deps.appliedCount();
      post({
        type: labels.result,
        series,
        historyNote: applied > 0 ? `${applied} edit operation(s) are not applied to these values.` : undefined,
      });
    } catch (err) {
      post({ type: labels.result, message: err instanceof Error ? err.message : String(err) });
    } finally {
      aborts[which] = undefined;
    }
  };

  return {
    async field(msg, resolve) {
      const refuse = (message: string): void => {
        if (!disposed) deps.post({ type: "fieldSeriesResult", message });
      };
      if (aborts.field) return refuse("A time-series scan is already running.");
      // Same trust boundary as applyOp: the message is raw webview input.
      const kind = String(msg.kind ?? "");
      const variable = String(msg.variable ?? "");
      const entityId = Number(msg.entityId);
      if (!FIELD_KINDS.includes(kind) || !variable || !Number.isFinite(entityId)) {
        return refuse("Invalid time-series request.");
      }
      const input = resolve();
      if (!input) return refuse("This file has no time series to plot.");
      if ("steps" in input && input.steps.length === 0) return refuse("This file has no time series to plot.");
      await run(
        "field",
        { kind: "field", spec: { kind: kind as "Nodal" | "Elemental" | "Conditional", variable, entityId } },
        input,
        { progress: "fieldSeriesProgress", result: "fieldSeriesResult" }
      );
    },
    async flow(msg, resolve) {
      const refuse = (message: string): void => {
        if (!disposed) deps.post({ type: "flowSeriesResult", message });
      };
      if (aborts.flow) return refuse("A flow-balance scan is already running.");
      const flow = msg.flow as FlowBalanceSpec | undefined;
      if (!flow || !Array.isArray(flow.sections)) return refuse("Choose the sections to balance first.");
      const input = resolve();
      if (!input) return refuse("This file has no time series to balance.");
      if ("steps" in input && input.steps.length === 0) return refuse("This file has no time series to balance.");
      await run("flow", { kind: "flow", spec: flow }, input, {
        progress: "flowSeriesProgress",
        result: "flowSeriesResult",
      });
    },
    cancelField: () => aborts.field?.abort(),
    cancelFlow: () => aborts.flow?.abort(),
    dispose() {
      disposed = true;
      killer.abort();
      aborts.field?.abort();
      aborts.flow?.abort();
    },
  };
}
