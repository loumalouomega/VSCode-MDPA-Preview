/**
 * What the host process actually wired at startup: which of the optional
 * worker bundles and the MMG wasm it found. `mcpServer.ts` and `extension.ts`
 * install each worker only when its file exists next to the bundle and
 * otherwise fall back to the in-process runner — the right behaviour for an
 * unbuilt tree, and a silent one for a packaged distribution that lost a file.
 * Recording the outcome here lets `mesh_capabilities` report it, so a staged
 * distribution check can fail on a fallback instead of passing through it.
 * Pure state, no imports.
 */
export type WorkerKind = "mmg" | "oracle" | "derived" | "meshioRead" | "meshioWrite";
export type WorkerMode = "worker" | "in-process";

export interface RuntimeWiring {
  workers: Record<WorkerKind, WorkerMode>;
  /** `bundled` = fed from `mmg-core.wasm` beside the bundle; `package` = the package self-resolves it. */
  mmgWasm: "bundled" | "package";
}

const wiring: RuntimeWiring = {
  workers: {
    mmg: "in-process",
    oracle: "in-process",
    derived: "in-process",
    meshioRead: "in-process",
    meshioWrite: "in-process",
  },
  mmgWasm: "package",
};

export function recordWorker(kind: WorkerKind, mode: WorkerMode): void {
  wiring.workers[kind] = mode;
}

export function recordMmgWasm(source: RuntimeWiring["mmgWasm"]): void {
  wiring.mmgWasm = source;
}

/** A copy, so a caller cannot change what later calls report. */
export function getRuntimeWiring(): RuntimeWiring {
  return { workers: { ...wiring.workers }, mmgWasm: wiring.mmgWasm };
}
