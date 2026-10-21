/**
 * The seam between the callers of the two remaining synchronous-wasm families —
 * derived meshes (`deriveMesh`) and partition export (`partitionParts`) — and
 * where they run (roadmap item 2). The default runs in the current thread, so
 * tests and plain Node are unchanged; `extension.ts` and `mcpServer.ts` install
 * a worker client (`src/derivedWorkerClient.ts`) with `configureDerivedRunner`
 * so a large slice / isosurface / grid / decimation / KaHIP partition no longer
 * freezes the host and its Cancel terminates the thread instead of landing
 * "between stages". Pure: no vscode imports.
 */

import { deriveMesh } from "./deriveMesh";
import type { DeriveResult, DeriveSpec } from "./deriveMesh";
import { partitionParts } from "./partitionExport";
import type { PartitionExportParams, PartitionExportResult } from "./partitionExport";
import type { MdpaDiagnostic, MdpaModel } from "./types";

export interface DerivedRunOptions {
  /** Aborting rejects with `Error("cancelled")`; a worker run is terminated. */
  signal?: AbortSignal;
  /** Stage lines ("Sending to a worker…"). */
  onProgress?: (message: string) => void;
}

export type DerivedJob =
  | { kind: "derive"; model: MdpaModel; spec: DeriveSpec }
  | { kind: "partition"; model: MdpaModel; params: PartitionExportParams };

export type DerivedOutput =
  | { kind: "derive"; result: DeriveResult }
  | { kind: "partition"; result: PartitionExportResult };

/** Runs one job. Diagnostics the job produced are appended to `diagnostics`. */
export type DerivedRunner = (job: DerivedJob, diagnostics: MdpaDiagnostic[], opts: DerivedRunOptions) => Promise<DerivedOutput>;

/** Runs the job in the CURRENT thread (also what the worker itself calls). */
export const runDerivedInProcess: DerivedRunner = async (job, diagnostics, opts) => {
  if (job.kind === "derive") {
    return { kind: "derive", result: await deriveMesh(job.model, job.spec, diagnostics, { signal: opts.signal }) };
  }
  return { kind: "partition", result: await partitionParts(job.model, job.params, diagnostics, { signal: opts.signal }) };
};

let runner: DerivedRunner = runDerivedInProcess;

export function configureDerivedRunner(r: DerivedRunner): void {
  runner = r;
}

/**
 * A streamline trace is the one derived kind that does not cross a thread: its
 * per-seed progress is a callback, and it has its own worker for the live
 * overlay. Callers that pass such a callback keep it in-process.
 */
export function deriveMeshOffThread(
  model: MdpaModel,
  spec: DeriveSpec,
  diagnostics: MdpaDiagnostic[] = [],
  opts: DerivedRunOptions & { streamOpts?: Parameters<typeof deriveMesh>[3] } = {}
): Promise<DeriveResult> {
  if (spec.kind === "streamlines") {
    return deriveMesh(model, spec, diagnostics, { ...opts.streamOpts, signal: opts.signal ?? opts.streamOpts?.signal });
  }
  return runner({ kind: "derive", model, spec }, diagnostics, opts).then((o) => o.result as DeriveResult);
}

export function partitionPartsOffThread(
  model: MdpaModel,
  params: PartitionExportParams,
  diagnostics: MdpaDiagnostic[] = [],
  opts: DerivedRunOptions = {}
): Promise<PartitionExportResult> {
  return runner({ kind: "partition", model, params }, diagnostics, opts).then((o) => o.result as PartitionExportResult);
}
