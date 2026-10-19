/**
 * The shared writer for `.kkss-execution.json` (roadmap item 6 / item 19).
 *
 * One receipt contract, two producers: the MCP server's queue-owned runs and
 * the extension's own isolated runs. This module is the ONLY writer — a second
 * copy of this logic is how the two would drift, and a reader such as
 * `parser/plot/runs.ts` verifies both with the same rules (IDs echoed in the
 * latest-run sidecar, artifact revisions frozen at observed completion).
 *
 * It is provenance, not a second run registry: the sidecar keeps process
 * identity, the receipt keeps artifact identity.
 *
 * Pure (no vscode), so both producers compile against it and the tests call it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { discoverOutputs } from "./outputDiscovery";
import { PREPARATION_FILE, parsePreparationReport, type PreparationReport } from "./preparation";
import { runFilePath } from "./caseFile";
import { parseRunJson, type RunSidecar } from "./runFile";
import { THREAD_RECEIPT } from "./threadControl";
import { plotDirectorySource } from "../parser/plot/directoryInventory";
import {
  executionFilePath,
  parseExecutionReceipt,
  terminalExecution,
  type ExecutionArtifact,
  type ExecutionReceipt,
  type ExecutionState,
} from "./runReceipt";
import { freezeExecutionResult } from "./runResultInventory";

/** The receipt's owning request: what a later reader must echo to claim it. */
export interface OwnedRun {
  requestId: string;
  ownerId: string;
  runDirectory: string;
}

/** Atomically replaces the receipt; a torn file must never read as a receipt. */
export function writeExecution(receipt: ExecutionReceipt): void {
  const file = executionFilePath(receipt.runDirectory);
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  fs.renameSync(temp, file);
}

export function readExecution(runDirectory: string): ExecutionReceipt | undefined {
  try {
    return parseExecutionReceipt(fs.readFileSync(executionFilePath(runDirectory), "utf8"), runDirectory);
  } catch {
    return undefined;
  }
}

export function executionState(status: string | undefined): ExecutionState {
  if (status === "finished") return "succeeded";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (status === "running" || status === "detached") return "running";
  if (status === "starting") return "dispatching";
  return "uncertain";
}

/** Streams one file's SHA-256 (`sha256:<hex>`), or undefined when unreadable. */
export function artifactRevision(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let count: number;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
    return `sha256:${hash.digest("hex")}`;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The sidecar's log file, when one was written — the only thing an artifact pass needs. */
function sidecarOf(meshPath: string): RunSidecar | undefined {
  try {
    return parseRunJson(fs.readFileSync(runFilePath(meshPath), "utf8")).sidecar;
  } catch {
    return undefined;
  }
}

/**
 * The inputs the preparation manifest recorded — generated documents and the
 * solver mesh — with the manifest's own revisions. Re-hashing today's file
 * would let bytes written after the run be labelled as this run's input.
 */
function recordedInputs(receipt: ExecutionReceipt): { role: string; path: string; revision: string }[] {
  const dir = path.dirname(receipt.meshPath);
  let preparation: PreparationReport;
  try {
    preparation = parsePreparationReport(fs.readFileSync(path.join(dir, PREPARATION_FILE), "utf8"));
  } catch {
    return [];
  }
  const out: { role: string; path: string; revision: string }[] = [];
  const add = (file: string, revision: string): void => {
    const abs = path.resolve(file);
    try {
      if (!fs.statSync(abs).isFile()) return;
    } catch {
      return;
    }
    out.push({ role: "input", path: abs, revision: `sha256:${revision}` });
  };
  for (const input of preparation.inputs) add(path.join(dir, input.name), input.revision);
  // The solver mesh is a separate record; when it IS the executed mesh it is
  // already `mesh` and would only be a second name for the same bytes.
  if (preparation.solverMesh.name !== path.basename(receipt.meshPath)) {
    add(path.join(dir, preparation.solverMesh.name), preparation.solverMesh.revision);
  }
  return out;
}

/**
 * Collects every artifact a receipt should pin: the executed mesh, the
 * thread-control record, the generated inputs, the case's own evidence
 * (convergence, preparation), the discovered outputs and the run log.
 *
 * A frozen receipt is returned as-is: once the owning process observed
 * completion, revisions are final, and re-hashing later bytes must never
 * relabel rewritten output as the old run.
 */
export async function collectExecutionArtifacts(
  receipt: ExecutionReceipt,
  generated?: object,
  prior: ExecutionArtifact[] = []
): Promise<ExecutionArtifact[]> {
  if (terminalExecution(receipt)) return receipt.artifacts;
  const out: ExecutionArtifact[] = [];
  const seen = new Set<string>();
  const add = (role: string, file: string, recorded?: string): void => {
    const abs = path.resolve(file);
    const key = `${role}\0${abs}`;
    if (seen.has(key)) return;
    seen.add(key);
    try {
      if (!fs.statSync(abs).isFile()) return;
      const revision = recorded ?? artifactRevision(abs);
      out.push({ role, path: abs, ...(revision ? { revision } : { revisionUnavailable: "Could not read file." }) });
    } catch {
      /* A missing generated artifact is left out and reported by status consumers. */
    }
  };
  for (const artifact of prior) add(artifact.role, artifact.path);
  add("mesh", receipt.meshPath);
  add("resources", path.join(path.dirname(receipt.meshPath), THREAD_RECEIPT));
  const generatedFiles =
    generated && typeof generated === "object" && "written" in generated && Array.isArray((generated as { written?: unknown }).written)
      ? (generated as { written: unknown[] }).written
      : [];
  for (const file of generatedFiles) if (typeof file === "string") add("input", file);
  // The manifest is the run's own record of what generation wrote. Its
  // revisions are used as recorded, so this pass never upgrades evidence by
  // hashing bytes that may have changed since (and gives the extension's
  // receipts the same input artifacts the MCP path collects).
  for (const input of recordedInputs(receipt)) add(input.role, input.path, input.revision);
  const sidecar = sidecarOf(receipt.meshPath);

  add("convergence", path.join(path.dirname(receipt.meshPath), "kkss-convergence-v1.jsonl"));
  add("convergence", path.join(path.dirname(receipt.meshPath), "kkss-convergence-v2.jsonl"));
  add("preparation", path.join(path.dirname(receipt.meshPath), PREPARATION_FILE));
  const outputs = discoverOutputs(path.dirname(receipt.meshPath));
  for (const file of outputs.results) add("result", file);
  for (const file of outputs.companions) add("result-companion", file);
  if (sidecar?.logFile) add("log", sidecar.logFile);
  for (const result of out.filter((a) => a.role === "result" && plotDirectorySource(a.path))) {
    try {
      for (const artifact of await freezeExecutionResult(result.path)) {
        const existing = out.find((a) => a.role === artifact.role && a.path === artifact.path);
        if (existing) Object.assign(existing, artifact);
        else out.push(artifact);
      }
    } catch (error) {
      result.inventoryUnavailable = error instanceof Error ? error.message : String(error);
    }
  }
  return out;
}

/**
 * Merges one update into the receipt of the given owning request, and refuses
 * to touch a receipt that belongs to somebody else. A terminal receipt is
 * never updated: the observation that ended it is the last word.
 */
export function updateExecution(owned: OwnedRun, update: Partial<ExecutionReceipt>): ExecutionReceipt | undefined {
  const current = readExecution(owned.runDirectory);
  if (!current || current.requestId !== owned.requestId || current.ownerId !== owned.ownerId) return undefined;
  // Once the owning process observed completion, pin its artifact revisions.
  // Status polling must not relabel rewritten output bytes as the old run.
  if (terminalExecution(current)) return current;
  if (["succeeded", "failed", "cancelled"].includes(String(update.state))) {
    const outputs = discoverOutputs(path.dirname(current.meshPath));
    update = { ...update, outputFindings: outputs.findings };
  }
  let resources = current.resources;
  try {
    const value = JSON.parse(fs.readFileSync(path.join(owned.runDirectory, THREAD_RECEIPT), "utf8"));
    if (
      resources &&
      value.version === 1 &&
      value.requestedThreads === resources.requestedThreads &&
      value.effectiveThreads === resources.requestedThreads
    ) {
      resources = value;
    }
  } catch {
    /* Unacknowledged thread application remains unknown. */
  }
  const next = { ...current, ...update, ...(resources ? { resources } : {}), updatedAt: Date.now() };
  writeExecution(next);
  return next;
}

/**
 * Writes the receipt for one observed run status. Returns undefined when there
 * is no receipt yet, or when it belongs to a different request/owner.
 */
export function executionReceiptForRun(
  owned: OwnedRun | undefined,
  meshPath: string,
  status: string,
  runId?: string,
  artifacts: ExecutionArtifact[] = []
): ExecutionReceipt | undefined {
  if (!owned) return undefined;
  const current = readExecution(owned.runDirectory);
  if (!current || current.requestId !== owned.requestId || current.ownerId !== owned.ownerId) return undefined;
  const next = {
    ...current,
    meshPath: path.resolve(meshPath),
    ...(runId ? { jobId: runId } : {}),
    state: executionState(status),
    artifacts,
    updatedAt: Date.now(),
  };
  return updateExecution(owned, next);
}
