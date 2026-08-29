/**
 * The run manager's pure core: what a tracked Kratos run is, how its row reads,
 * and which result file is "the latest".
 *
 * No vscode, no DOM — so all of it is unit-tested, which matters more here than
 * usual: the tree view above it cannot be tested at all in this repo (there is
 * no VS Code integration harness). The rule that follows is that
 * `src/runTreeView.ts` contains no conditionals of its own; every label,
 * description, icon and context value comes from a function in this file.
 */

import { TIMELINE_EXTENSIONS } from "../parser/meshFormats";
import { VtkFileGroup, fileFor, groupVtkFiles } from "../parser/vtkFileGroup";

/**
 * Where a run is.
 *
 * `detached` and `orphaned` are the honest states, and the reason this is not a
 * boolean: `detached` means a process we are NOT attached to may still be alive
 * (a terminal launch, or one adopted from a sidecar after a window reload), and
 * `orphaned` means it was live when the window went away and no exit code was
 * ever recorded. Neither may be reported as `running`, which would claim a
 * liveness we cannot observe.
 */
export type RunStatus =
  | "starting"
  | "running"
  | "finished"
  | "failed"
  | "cancelled"
  | "detached"
  | "orphaned";

/** How a run was launched. */
export type LaunchMode = "output" | "terminal";

/** Progress derived from `vtk_output/` — never from parsing solver stdout. */
export interface RunProgress {
  /** Latest step label written, numerically ordered (not lexicographic). */
  stepLabel?: string;
  /** How many result files exist. */
  fileCount?: number;
  /** Last non-empty stdout line, shown verbatim as "last output" — never parsed. */
  lastLine?: string;
}

export interface RunRecord {
  id: string;
  /** The case's identity: the resolved mesh path (lowercased on win32). */
  caseKey: string;
  meshFsPath: string;
  caseDir: string;
  stem: string;
  /** argv, never a shell string — which is also what fixes quoting. */
  argv: string[];
  launchMode: LaunchMode;
  startedAt: number;
  status: RunStatus;
  pid?: number;
  endedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  message?: string;
  progress?: RunProgress;
  /**
   * Latched the moment a stop is requested, BEFORE the signal is sent. The exit
   * handler consults it so a deliberate stop reads `cancelled` rather than
   * `failed` — a failure badge on a run the user stopped is a lie the tree
   * would keep telling.
   */
  stopRequested?: boolean;
}

/** A run we are still attached to, or that may still be alive without us. */
export function isLive(r: RunRecord): boolean {
  return r.status === "starting" || r.status === "running" || r.status === "detached";
}

/** Terminal states — the ones "Clear finished" may remove. */
export function isDone(r: RunRecord): boolean {
  return !isLive(r);
}

/** The case's identity. Case-insensitive on Windows, where paths are. */
export function caseKeyFor(resolvedMeshPath: string, platform: string): string {
  return platform === "win32" ? resolvedMeshPath.toLowerCase() : resolvedMeshPath;
}

// ---- row projections --------------------------------------------------------

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s.toString().padStart(2, "0")}s`;
}

export function runRowLabel(r: RunRecord): string {
  return r.stem;
}

/** `running · 1m 12s · step 34` / `failed · 0m 04s · exit 1` */
export function runRowDescription(r: RunRecord, now: number): string {
  const parts: string[] = [r.status];
  const end = r.endedAt ?? now;
  const elapsed = formatDuration(end - r.startedAt);
  if (elapsed) parts.push(elapsed);
  if (r.status === "failed" && typeof r.exitCode === "number") {
    parts.push(`exit ${r.exitCode}`);
  } else if (r.status === "detached" && r.launchMode === "terminal") {
    parts.push("terminal");
  } else if (isLive(r) && r.progress?.stepLabel) {
    parts.push(`step ${r.progress.stepLabel}`);
  }
  return parts.join(" · ");
}

/** A VS Code ThemeIcon id. `sync~spin` is VS Code chrome, not our webview, so
 *  the design system's "no decorative motion" rule is not engaged. */
export function runRowIconId(r: RunRecord): string {
  switch (r.status) {
    case "starting":
    case "running":
      return "sync~spin";
    case "finished":
      return "pass";
    case "failed":
      return "error";
    case "cancelled":
      return "circle-slash";
    case "detached":
      return "question";
    default:
      return "warning";
  }
}

/** Drives the `when` clauses of the view's context menu. */
export function runContextValue(r: RunRecord): string {
  return `kratosRun.${r.status}`;
}

/** Quotes one argv entry for DISPLAY only — never for execution (argv is an
 *  array and `shell` is false, which is what makes a path with spaces work). */
export function quoteArg(platform: string, arg: string): string {
  if (arg.length > 0 && !/[\s"']/.test(arg)) return arg;
  return platform === "win32" ? `"${arg.replace(/"/g, '\\"')}"` : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function displayCommand(argv: readonly string[], platform: string): string {
  return argv.map((a) => quoteArg(platform, a)).join(" ");
}

// ---- results ----------------------------------------------------------------

export interface LatestResult {
  group: VtkFileGroup;
  step: string;
  fileName: string;
  /** Index into `group.steps` — what the timeline calls a frame. */
  frameIndex: number;
  rank: number;
}

/**
 * The newest result file in a directory listing.
 *
 * Replaces the hand-rolled `names.sort()[0]` this feature used to do, which was
 * wrong three ways: the sort was LEXICOGRAPHIC (so `_0_10` came before `_0_2`),
 * it then took the FIRST entry rather than the last, and its extension filter
 * was narrower than `TIMELINE_EXTENSIONS` (silently missing `.vti`/`.vts`/
 * `.vtr`). Reusing `groupVtkFiles` fixes all three at once, because that module
 * already sorts steps numerically.
 *
 * `excludeNewest` drops the last step: a solver that was killed can leave a
 * half-written final file (the writer has no atomic rename), so opening the
 * results of a cancelled run should target the last COMPLETE step.
 */
export function latestResultFile(
  fileNames: string[],
  opts: { excludeNewest?: boolean } = {}
): LatestResult | undefined {
  const groups = groupVtkFiles(fileNames, TIMELINE_EXTENSIONS);
  if (groups.length === 0) return undefined;
  // Most steps wins; ties broken by name so the choice is deterministic rather
  // than dependent on readdir order.
  const group = [...groups].sort(
    (a, b) => b.steps.length - a.steps.length || a.rootPrefix.localeCompare(b.rootPrefix)
  )[0];
  if (group.steps.length === 0) return undefined;
  let index = group.steps.length - 1;
  if (opts.excludeNewest && group.steps.length > 1) index--;
  const step = group.steps[index];
  const rank = group.ranks[0] ?? 0;
  const fileName = fileFor(group, group.rootPrefix, rank, step);
  if (!fileName) return undefined;
  return { group, step, fileName, frameIndex: index, rank };
}
