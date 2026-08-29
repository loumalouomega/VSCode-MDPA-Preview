/**
 * The run sidecar: `<stem>.kratosrun.json`, holding the LATEST run for a case.
 *
 * Pure (no vscode), and tolerant in exactly the way `caseFile.ts` is: it never
 * throws, it returns `{ record?, warnings }`, and it stamps a version so a file
 * written by a newer build is reported rather than misread.
 *
 * This file — not any in-memory registry — is the shared truth between the
 * extension and the MCP server, the same way `<stem>.kratoscase.json` already
 * mediates between the sidebar and `case_write_state`. The MCP server cannot
 * own a running process (its stdout IS its JSON-RPC transport and it dies with
 * its client), so filesystem mediation is the only parity available.
 *
 * It is therefore deliberately **process-identifying, not handle-identifying**:
 * a `pid` survives a window reload where an object reference cannot.
 */

import { LaunchMode, RunRecord, RunStatus } from "./runCore";

const RUN_VERSION = 1;

const STATUSES: RunStatus[] = [
  "starting",
  "running",
  "finished",
  "failed",
  "cancelled",
  "detached",
  "orphaned",
];

/** What actually goes on disk — a subset of RunRecord plus provenance. */
export interface RunSidecar {
  version: number;
  runId: string;
  stem: string;
  meshFile: string;
  status: RunStatus;
  launchMode: LaunchMode;
  argv: string[];
  startedAt: number;
  pid?: number;
  endedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  message?: string;
  /** Which side started it, so a reader knows who to expect updates from. */
  launchedBy: "extension" | "mcp";
  /**
   * Latched on disk the moment a stop is requested, BEFORE the signal is sent.
   *
   * `RunRecord.stopRequested` cannot cross a process boundary, and the process
   * that owns the handle is the one that writes the terminal record — which is
   * usually NOT the process asking for the stop. Without this, an MCP-issued
   * stop of an extension-owned run ends up classified `failed`, which is
   * exactly the lie the in-memory latch was invented to prevent.
   */
  stopRequested?: boolean;
  /** Present only for a detached run, whose output is tee'd to a file. */
  logFile?: string;
}

export function serializeRun(sidecar: Omit<RunSidecar, "version">): string {
  return JSON.stringify({ ...sidecar, version: RUN_VERSION }, null, 2) + "\n";
}

/** Builds the on-disk shape from a live record. */
export function sidecarFromRecord(
  record: RunRecord,
  launchedBy: "extension" | "mcp",
  logFile?: string
): Omit<RunSidecar, "version"> {
  return {
    runId: record.id,
    stem: record.stem,
    meshFile: record.meshFsPath,
    status: record.status,
    launchMode: record.launchMode,
    argv: [...record.argv],
    startedAt: record.startedAt,
    ...(record.pid !== undefined ? { pid: record.pid } : {}),
    ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
    ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
    ...(record.signal !== undefined ? { signal: record.signal } : {}),
    ...(record.message !== undefined ? { message: record.message } : {}),
    launchedBy,
    ...(record.stopRequested ? { stopRequested: true } : {}),
    ...(logFile ? { logFile } : {}),
  };
}

function isRecordObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Parses a run sidecar. Returns `{ warnings }` with no record when nothing
 * usable is inside — a missing or corrupt file must never break the reader.
 */
export function parseRunJson(text: string): { sidecar?: RunSidecar; warnings: string[] } {
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { warnings: ["Run file is not valid JSON."] };
  }
  if (!isRecordObject(raw)) return { warnings: ["Run file is not a JSON object."] };
  if (typeof raw.runId !== "string" || raw.runId.length === 0) {
    return { warnings: ["Run file has no runId."] };
  }
  if (typeof raw.version === "number" && raw.version > RUN_VERSION) {
    warnings.push(`Run file version ${raw.version} is newer than supported (${RUN_VERSION}).`);
  }
  let status: RunStatus = "orphaned";
  if (typeof raw.status === "string" && (STATUSES as string[]).includes(raw.status)) {
    status = raw.status as RunStatus;
  } else {
    // An unreadable status must not read as "running" — that would claim a
    // liveness the file does not support.
    warnings.push(`Unknown run status ${JSON.stringify(raw.status)}; treated as orphaned.`);
  }
  const launchMode: LaunchMode = raw.launchMode === "terminal" ? "terminal" : "output";
  return {
    sidecar: {
      version: RUN_VERSION,
      runId: raw.runId,
      stem: typeof raw.stem === "string" ? raw.stem : "",
      meshFile: typeof raw.meshFile === "string" ? raw.meshFile : "",
      status,
      launchMode,
      argv: readStringArray(raw.argv),
      startedAt: typeof raw.startedAt === "number" ? raw.startedAt : 0,
      ...(typeof raw.pid === "number" ? { pid: raw.pid } : {}),
      ...(typeof raw.endedAt === "number" ? { endedAt: raw.endedAt } : {}),
      ...(typeof raw.exitCode === "number" || raw.exitCode === null
        ? { exitCode: raw.exitCode as number | null }
        : {}),
      ...(typeof raw.signal === "string" || raw.signal === null
        ? { signal: raw.signal as string | null }
        : {}),
      ...(typeof raw.message === "string" ? { message: raw.message } : {}),
      launchedBy: raw.launchedBy === "mcp" ? "mcp" : "extension",
      // Strictly `=== true`: a garbage value must never claim a stop that was
      // never requested.
      ...(raw.stopRequested === true ? { stopRequested: true as const } : {}),
      ...(typeof raw.logFile === "string" ? { logFile: raw.logFile } : {}),
    },
    warnings,
  };
}

/**
 * Reconciles a sidecar against the OS.
 *
 * A record still marked running is only a claim: the window may have gone away
 * without updating it. `alive` comes from a `process.kill(pid, 0)` probe by the
 * caller — which cannot be trusted on its own, because pids are reused, so a
 * live probe downgrades to `detached` ("may still be running") rather than
 * being promoted back to `running`.
 */
export function reconcileStatus(
  sidecar: RunSidecar,
  alive: boolean | undefined
): { status: RunStatus; message?: string } {
  if (sidecar.status !== "running" && sidecar.status !== "starting") {
    return { status: sidecar.status, message: sidecar.message };
  }
  if (sidecar.pid === undefined) {
    return {
      status: "orphaned",
      message: "No pid was recorded, so this run cannot be checked.",
    };
  }
  if (alive === true) {
    return {
      status: "detached",
      message:
        `PID ${sidecar.pid} may still be running — this window is not attached to it, ` +
        `and pids are reused, so this is a maybe rather than a yes.`,
    };
  }
  return {
    status: "orphaned",
    message: "The process is gone and no exit code was recorded.",
  };
}
