// fs half of restart (roadmap item 29): checks the previous run and finds its
// restart files. Refuses by name; never guesses a missing piece.

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

import { PREPARATION_FILE, parsePreparationReport } from "./preparation";
import { readExecution } from "./runReceiptWriter";
import { terminalExecution } from "./runReceipt";
import type { CaseState, RestartState } from "./types";
import { supportsRestart } from "./restart";
import type { PreparationRestart } from "./preparation";

export const RESTART_FOLDER_SUFFIX = "__restart_files";

/** The restart stems found in a run directory for `label`: `{dir, stem}` per match. */
export function findRestartFiles(runDirectory: string, label: number): { dir: string; stem: string }[] {
  const out: { dir: string; stem: string }[] = [];
  const tail = `_${label}.rest`;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(runDirectory, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.endsWith(RESTART_FOLDER_SUFFIX)) continue;
    const dir = path.join(runDirectory, e.name);
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(tail) && f.length > tail.length) out.push({ dir, stem: f.slice(0, -tail.length) });
    }
  }
  return out;
}

/** Labels with a restart file in a run directory, ascending. */
export function listRestartLabels(runDirectory: string): number[] {
  const labels = new Set<number>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(runDirectory, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.endsWith(RESTART_FOLDER_SUFFIX)) continue;
    for (const f of fs.readdirSync(path.join(runDirectory, e.name))) {
      const m = /_(\d+)\.rest$/.exec(f);
      if (m) labels.add(Number(m[1]));
    }
  }
  return [...labels].sort((a, b) => a - b);
}

/**
 * Validates the previous run and returns `from` with `inputFilename` set (the
 * restart stem relative to `caseDir`, forward slashes). Throws one message that
 * names every reason. `solverMeshPath` is the mesh the NEW case will read: it
 * must be byte-identical to the one the source run was prepared with, since a
 * restart file is keyed by node and element order.
 */
export function resolveRestartSource(
  caseDir: string,
  from: NonNullable<RestartState["from"]>,
  solverMeshPath: string
): NonNullable<RestartState["from"]> {
  const runDir = path.resolve(caseDir, from.runDirectory);
  const problems: string[] = [];
  const receipt = readExecution(runDir);
  if (!receipt) problems.push(`"${from.runDirectory}" has no run receipt, so it is not a recorded run.`);
  else if (!terminalExecution(receipt)) problems.push(`The source run is ${receipt.state}; wait until it has ended.`);
  let sourceMesh: string | undefined;
  try {
    sourceMesh = parsePreparationReport(fs.readFileSync(path.join(runDir, PREPARATION_FILE), "utf8")).solverMesh?.revision;
  } catch {
    problems.push("The source run has no readable preparation record, so its mesh cannot be compared.");
  }
  if (sourceMesh !== undefined) {
    let current: string | undefined;
    try {
      current = createHash("sha256").update(fs.readFileSync(solverMeshPath)).digest("hex");
    } catch {
      problems.push("The new case mesh cannot be read to compare it with the source run's.");
    }
    if (current !== undefined && current !== sourceMesh) {
      problems.push("The mesh differs from the one the source run used (node and element order must match for a restart).");
    }
  }
  // No label given: the run's latest restart (highest label).
  const label = from.label ?? listRestartLabels(runDir).pop();
  const found = label === undefined ? [] : findRestartFiles(runDir, label);
  if (found.length === 0) problems.push(`No restart file${label === undefined ? "" : ` for label ${label}`} in "${from.runDirectory}" (expected <name>${RESTART_FOLDER_SUFFIX}/<name>_<label>.rest).`);
  else if (found.length > 1) problems.push(`Several restart files match label ${label}; the source run is ambiguous.`);
  if (problems.length > 0) throw new Error(`The restart source cannot be used:\n- ${problems.join("\n- ")}`);
  const { dir, stem } = found[0];
  // Kratos joins the restart folder to input_filename itself, so give the stem
  // path without the folder.
  const rel = path.relative(path.resolve(caseDir), path.join(path.dirname(dir), stem)).split(path.sep).join("/");
  return { ...from, label: label as number, inputFilename: rel };
}

/**
 * The one resolution step for every generating front end (MCP, sidebar): a state
 * whose restart names a source gets it resolved against the mesh the new case
 * will read; any other state is returned as is. Throws the refusal text.
 */
export function resolveStateRestart(caseDir: string, state: CaseState, solverMeshPath: string): CaseState {
  const from = state.restart?.from;
  if (!from || !supportsRestart(state.problemtypeId)) return state;
  return { ...state, restart: { ...state.restart, from: resolveRestartSource(caseDir, from, solverMeshPath) } };
}

/** Identity of the restart source for the preparation record: no paths. */
export function restartIdentity(caseDir: string, state: CaseState): PreparationRestart | undefined {
  const from = state.restart?.from;
  if (!from || from.label === undefined) return undefined;
  const receipt = readExecution(path.resolve(caseDir, from.runDirectory));
  if (!receipt) return undefined;
  return { requestId: receipt.requestId, label: from.label };
}

/**
 * Dry-run form for preflight: the state to generate with, and the reasons the
 * restart source was refused. On a refusal the source is dropped from the
 * returned state so the dry run does not say it again in another wording.
 * `meshPath` is the mesh the case reads: the `<stem>_case.mdpa` when one was
 * written already, else the source mesh.
 */
export function checkRestart(
  caseDir: string,
  stem: string,
  sourceMeshPath: string,
  state: CaseState
): { state: CaseState; problems: string[] } {
  if (!state.restart?.from || !supportsRestart(state.problemtypeId)) return { state, problems: [] };
  const adapted = path.join(caseDir, `${stem}_case.mdpa`);
  const meshPath = fs.existsSync(adapted) ? adapted : sourceMeshPath;
  try {
    return { state: resolveStateRestart(caseDir, state, meshPath), problems: [] };
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    const problems = text.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
    const { from: _dropped, ...rest } = state.restart;
    return { state: { ...state, restart: rest.save ? rest : undefined } as CaseState, problems: problems.length > 0 ? problems : [text] };
  }
}
