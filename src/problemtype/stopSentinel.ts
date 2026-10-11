/**
 * The cooperative stop sentinel — the launcher's half.
 *
 * A stop that needs no console and so works the same on every platform: the
 * generated `MainKratos.py` checks a file between solution steps and leaves its
 * loop through the stage's normal `Finalize`. This module is what the two
 * launchers (the editor's `RunManager` and the MCP `case_run`) share so the
 * contract cannot drift between them:
 *
 * - `KRATOS_PREVIEW_STOP_FILE` names the file (`<stem>.kratosstop`), and
 *   `KRATOS_PREVIEW_RUN_ID` the run it addresses. The file's CONTENT is the run
 *   id and the script honours it only on an exact match, so a leftover from an
 *   earlier run can never stop a later one.
 * - It is wired only when the script on disk contains the marker. A script
 *   generated before this existed cannot answer, and waiting a grace period on
 *   it would just make Stop slower — it is escalated as it always was.
 *
 * No vscode import: the decision is testable, which matters because this repo
 * has no VS Code integration harness.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { STOP_SENTINEL_MARKER, scriptHonoursStopSentinel } from "./mainKratosTemplate";
import { stopFilePath } from "./caseFile";
import type { StopSentinel } from "./runProcess";

export const STOP_FILE_ENV = "KRATOS_PREVIEW_STOP_FILE";
export const RUN_ID_ENV = "KRATOS_PREVIEW_RUN_ID";

export interface PreparedStopSentinel {
  /** Env additions for the child; always includes the run id when wired. */
  env: Record<string, string>;
  /** The file the script watches. */
  file: string;
  /** What `spawnRun` / `stopPid` take as the cooperative first rung. */
  sentinel: StopSentinel;
  /** Best-effort removal once the run is over. */
  remove(): void;
}

/** Writes the run id into the stop file, creating the folder if needed. */
export function writeStopFile(file: string, runId: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, runId, "utf8");
}

/** Removes a stop file, ignoring "not there". */
export function removeStopFile(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* a locked or read-only folder must not fail a run that already ended */
  }
}

/**
 * Wires the sentinel for one run, or returns undefined when the script cannot
 * honour it (missing, unreadable, or generated before the contract existed).
 * Any stale file from a previous run is removed first.
 */
export function prepareStopSentinel(opts: {
  meshFsPath: string;
  caseDir: string;
  scriptName: string;
  runId: string;
  graceMs?: number;
}): PreparedStopSentinel | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(opts.caseDir, opts.scriptName), "utf8");
  } catch {
    return undefined;
  }
  if (!scriptHonoursStopSentinel(text)) return undefined;
  const file = stopFilePath(opts.meshFsPath);
  removeStopFile(file);
  return {
    env: { [STOP_FILE_ENV]: file, [RUN_ID_ENV]: opts.runId },
    file,
    sentinel: {
      write: () => writeStopFile(file, opts.runId),
      ...(opts.graceMs !== undefined ? { graceMs: opts.graceMs } : {}),
    },
    remove: () => removeStopFile(file),
  };
}

export { STOP_SENTINEL_MARKER };
