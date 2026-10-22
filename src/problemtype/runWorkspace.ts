/**
 * Per-run workspaces (former roadmap item 6, delivered 2026-10-19): where an isolated run keeps the inputs
 * it generated from, and the copy of the source case that starts it.
 *
 * Pure (no vscode) and shared by the sidebar's Run and the MCP `case_run` tool,
 * so both create the SAME layout: `<caseDir>/<runsFolder>/<stem>-<runId>/`,
 * with the case's own `vtk_output/` inside it and the preparation record beside
 * the generated files. The preparation manifest records identity only; the
 * execution receipt is machine-local by design (it pins artifact paths).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { isRunIdentity } from "./preparation";
import { caseFilePath } from "./caseFile";

/** Where a case's run workspaces live unless the user configures another folder. */
export const DEFAULT_RUNS_FOLDER = "runs";

/**
 * The folder name run workspaces live under, from a user setting. Only a
 * relative, `..`-free path is accepted; anything else falls back to the
 * default rather than resolving outside the case folder.
 */
export function runWorkspaceFolder(configured: string | undefined): string {
  const raw = (configured ?? "").trim();
  if (!raw || raw === DEFAULT_RUNS_FOLDER) return DEFAULT_RUNS_FOLDER;
  if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) return DEFAULT_RUNS_FOLDER;
  const segments = raw.split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    return DEFAULT_RUNS_FOLDER;
  }
  return segments.join(path.sep);
}

/**
 * The workspace one run executes in: `<caseDir>/<runsFolder>/<stem>-<runId>`.
 *
 * Deterministic in its inputs, so an MCP retry with the same requestId plans
 * the SAME directory and finds its own receipt instead of dispatching again.
 * `runId` must be a run identity — the same grammar the preparation manifest
 * and the execution receipt use, so a name can never escape the case folder.
 */
export function planRunWorkspace(options: {
  caseDir: string;
  stem: string;
  runId: string;
  runsFolder?: string;
}): string {
  const { caseDir, stem, runId } = options;
  // The id becomes a directory name, so it must also survive Windows: a colon
  // (legal in a manifest identity) is not legal in a path component there.
  if (!isRunIdentity(runId) || /[<>:"|?*\u0000-\u001f]/.test(runId) || /[. ]$/.test(runId)) {
    throw new Error(`"${runId}" is not a usable run id for a workspace folder (letters, digits, . _ -; no colon, trailing dot or space).`);
  }
  if (!stem.trim() || /[\\/]/.test(stem) || /[. ]$/.test(stem)) {
    throw new Error(`"${stem}" is not a usable case name for a run workspace.`);
  }
  return path.join(caseDir, runWorkspaceFolder(options.runsFolder), `${stem}-${runId}`);
}

/** What was copied into a run workspace from the source case. */
export interface RunInputSnapshot {
  /** The mesh this run executes — a copy inside the run workspace. */
  meshPath: string;
  /** The case state it generated from, when the source case file existed. */
  casePath?: string;
  /** The driver script it executes, only for a run that skips generation. */
  scriptPath?: string;
}

/**
 * Copies the source mesh — and optionally its case state and driver script —
 * into a run workspace, refusing to overwrite anything. The directory itself
 * is created when missing; an EXISTING file is an error, never a replacement,
 * because the only copy of a run's inputs must never be quietly rewritten.
 */
export function snapshotRunInputs(options: {
  sourceMesh: string;
  runDirectory: string;
  /** The source case state file; copied when it exists. */
  casePath?: string;
  /** Copy this script name from the source folder (a `generate: false` run). */
  scriptName?: string;
}): RunInputSnapshot {
  const sourceMesh = path.resolve(options.sourceMesh);
  const runDirectory = path.resolve(options.runDirectory);
  fs.mkdirSync(runDirectory, { recursive: true });
  const copy = (from: string, name: string): string => {
    const to = path.join(runDirectory, name);
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    return to;
  };
  const snapshot: RunInputSnapshot = { meshPath: copy(sourceMesh, path.basename(sourceMesh)) };
  if (options.casePath && fs.existsSync(options.casePath)) {
    // A caller-named state file is copied under the name this workspace's own
    // tools look for (`<stem>.kratoscase.json`), so the snapshot is complete.
    snapshot.casePath = copy(path.resolve(options.casePath), path.basename(caseFilePath(snapshot.meshPath)));
  }
  if (options.scriptName) {
    const source = path.join(path.dirname(sourceMesh), options.scriptName);
    if (fs.existsSync(source)) snapshot.scriptPath = copy(source, options.scriptName);
  }
  return snapshot;
}
