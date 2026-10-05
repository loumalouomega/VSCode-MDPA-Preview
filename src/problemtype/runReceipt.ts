/** Existing isolated-run receipt contract, shared by run tools and result readers.
 * This is provenance, not a second run/process registry. */
import * as path from "node:path";

export const EXECUTION_FILE = ".kkss-execution.json";
/** Pointer index only; run sidecars/receipts remain the shared truth. */
export const RUN_SIDECAR_INDEX_KEY = "kratos.runSidecars";
export type ExecutionState = "dispatching" | "running" | "uncertain" | "succeeded" | "failed" | "cancelled";
export interface ExecutionArtifact {
  role: string;
  path: string;
  revision?: string;
  revisionUnavailable?: string;
  /** Portable content/path/timeline closure for directory-backed mesh sources.
   * Pin at completion, never rebuild it from a later status poll. */
  inventoryRevision?: string;
  inventoryUnavailable?: string;
}
export interface ExecutionReceipt {
  outputFindings?: string[];
  resources?: { requestedThreads: number; effectiveThreads?: number };
  version: 1;
  requestId: string;
  ownerId: string;
  jobId?: string;
  state: ExecutionState;
  runDirectory: string;
  meshPath: string;
  createdAt: number;
  updatedAt: number;
  artifacts: ExecutionArtifact[];
  message?: string;
}
export const executionFilePath = (directory: string): string => path.join(path.resolve(directory), EXECUTION_FILE);
export const terminalExecution = (receipt: ExecutionReceipt): boolean => ["succeeded","failed","cancelled"].includes(receipt.state);

/** Only rebase paths that the recorded run directory owns. */
export function parseExecutionReceipt(text: string, directory: string): ExecutionReceipt | undefined {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return undefined; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Partial<ExecutionReceipt>;
  if (value.version !== 1 || typeof value.requestId !== "string" || !value.requestId || typeof value.ownerId !== "string" || !value.ownerId ||
      typeof value.runDirectory !== "string" || !value.runDirectory || typeof value.meshPath !== "string" || !value.meshPath ||
      !["dispatching", "running", "uncertain", "succeeded", "failed", "cancelled"].includes(String(value.state))) return undefined;
  const currentDirectory = path.resolve(directory), recordedDirectory = path.resolve(value.runDirectory);
  const relocate = (file: string): string => {
    const absolute = path.resolve(file), relative = path.relative(recordedDirectory, absolute);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      ? path.resolve(currentDirectory, relative) : absolute;
  };
  return {
    ...(value as ExecutionReceipt), runDirectory: currentDirectory, meshPath: relocate(value.meshPath),
    artifacts: Array.isArray(value.artifacts) ? value.artifacts.filter((artifact): artifact is ExecutionArtifact =>
      !!artifact && typeof artifact.role === "string" && typeof artifact.path === "string").map(artifact => ({ ...artifact, path: relocate(artifact.path) })) : [],
  };
}
