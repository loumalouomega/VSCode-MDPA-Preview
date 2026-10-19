/**
 * Comparing two saved runs (roadmap item 6): what changed between them, as
 * facts about identity, settings, inputs and outputs — never as a judgement
 * about which run is "better".
 *
 * The comparison is built on the two portable records an isolated run already
 * keeps, so it needs no new registry and cannot collide between cases sharing a
 * source folder: a run is identified by its execution receipt (requestId +
 * ownerId + jobId), its files by revisions frozen when it ended, and its
 * settings by the preparation manifest written beside the run's own inputs.
 *
 * Readers must never upgrade a legacy receipt by hashing today's bytes: the
 * revision of an artifact comes from the receipt as recorded, and a run whose
 * evidence cannot prove identity is reported as incomparable rather than
 * guessed at.
 *
 * Pure (no vscode), so the MCP `case_compare` tool and any UI share it.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  executionFilePath,
  parseExecutionReceipt,
  terminalExecution,
  type ExecutionArtifact,
  type ExecutionReceipt,
} from "./runReceipt";
import { PREPARATION_FILE, parsePreparationReport, type PreparationReport } from "./preparation";

/** One side of a comparison, read from a run directory. */
export interface RunEvidence {
  /** The run directory the evidence was read from (absolute). */
  runDirectory: string;
  receipt?: ExecutionReceipt;
  preparation?: PreparationReport;
  /** Why this side cannot be compared, when it cannot. */
  problem?: string;
}

/** A single setting that differs between two runs. */
export interface SettingChange {
  /** Dotted path into the case state, e.g. `values.materials.youngsModulus`. */
  path: string;
  left?: unknown;
  right?: unknown;
}

export interface ArtifactChange {
  role: string;
  /** Path relative to the run directory, so two directories compare meaningfully. */
  path: string;
  left?: string;
  right?: string;
  /**
   * Set when at least one side recorded no revision: the two files have the
   * same name but their bytes were never pinned, so equality is NOT claimed.
   */
  unverified?: true;
}

export interface RunComparison {
  left: { runDirectory: string; requestId: string; ownerId: string; jobId?: string; state: string; createdAt?: number };
  right: RunComparison["left"];
  /** True when both sides are terminal isolated runs with readable evidence. */
  comparable: boolean;
  /** Why the comparison is partial, when it is. */
  problems: string[];
  /** Identity facts: equal run id, same source revision, same settings. */
  same: {
    /** Both manifests name the same source mesh bytes (the real "same case" test). */
    sourceMesh?: boolean;
    /** Both manifests name the same problemtype. */
    problemtype?: boolean;
    /** The recorded settings are byte-identical. */
    settings?: boolean;
    /**
     * Both manifests name the same CAD source revision; when both also recorded
     * a replay fingerprint it must match too. Absent when either side was not
     * generated from a CAD handoff, because then the claim cannot be made.
     */
    cadSource?: boolean;
  };
  settings: SettingChange[];
  /** How many artifacts both runs record under the same role and run-relative name. */
  counts: { paired: number; onlyLeft: number; onlyRight: number; changed: number; unverified: number };
  /** Artifacts one side has and the other does not, as `role:path` (bounded). */
  onlyLeft: string[];
  onlyRight: string[];
  /** Outputs whose recorded revision differs: same name, different bytes (bounded). */
  changed: ArtifactChange[];
  /** Paired artifacts whose bytes were never pinned, so equality is not claimed (bounded). */
  unverified: ArtifactChange[];
}

/** Rows kept per comparison list; the report names the bound when it is hit. */
export const COMPARE_LIST_LIMIT = 200;

/** Reads the evidence of one saved run from its directory. Never throws. */
export function readRunEvidence(runDirectory: string): RunEvidence {
  const dir = path.resolve(runDirectory);
  const out: RunEvidence = { runDirectory: dir };
  let text: string;
  try {
    text = fs.readFileSync(executionFilePath(dir), "utf8");
  } catch {
    return { ...out, problem: `No execution receipt in ${dir}; only an isolated run records what it executed.` };
  }
  const receipt = parseExecutionReceipt(text, dir);
  if (!receipt) return { ...out, problem: `The execution receipt in ${dir} is unreadable or belongs to another schema.` };
  out.receipt = receipt;
  try {
    out.preparation = parsePreparationReport(fs.readFileSync(path.join(dir, PREPARATION_FILE), "utf8"));
  } catch {
    // A run that was never generated (a generate:false launch) has no manifest;
    // the comparison then reports identity and artifacts only.
  }
  return out;
}

/** Dotted leaf paths of two JSON-like values; arrays compare whole. */
function flatten(value: unknown, prefix: string, out: Map<string, unknown>): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    out.set(prefix, value);
    return;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) out.set(prefix, value);
  for (const [key, child] of entries) flatten(child, prefix ? `${prefix}.${key}` : key, out);
}

function same(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return false;
  if (typeof left !== "object") return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Every leaf that differs, left-to-right, bounded. */
export function diffSettings(left: unknown, right: unknown, limit = COMPARE_LIST_LIMIT): SettingChange[] {
  const a = new Map<string, unknown>(), b = new Map<string, unknown>();
  flatten(left, "", a);
  flatten(right, "", b);
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
  const out: SettingChange[] = [];
  for (const key of keys) {
    if (same(a.get(key), b.get(key))) continue;
    out.push({
      path: key || "(root)",
      ...(a.has(key) ? { left: a.get(key) } : {}),
      ...(b.has(key) ? { right: b.get(key) } : {}),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** A run-relative path for an artifact, so two run directories compare by name. */
function relative(dir: string, file: string): string {
  const rel = path.relative(dir, path.resolve(file));
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) ? rel : path.basename(file);
}

function side(receipt: ExecutionReceipt): RunComparison["left"] {
  return {
    runDirectory: receipt.runDirectory,
    requestId: receipt.requestId,
    ownerId: receipt.ownerId,
    ...(receipt.jobId ? { jobId: receipt.jobId } : {}),
    state: receipt.state,
    createdAt: receipt.createdAt,
  };
}

/**
 * Compares two saved runs.
 *
 * Refuses (with `problems`, not a throw) when either side is not a terminal
 * isolated run: a live run's outputs are still changing, and a legacy in-folder
 * sidecar never recorded which bytes belonged to it.
 */
export function compareRuns(leftDirectory: string, rightDirectory: string): RunComparison {
  const left = readRunEvidence(leftDirectory), right = readRunEvidence(rightDirectory);
  const problems: string[] = [];
  for (const [label, evidence] of [["Left", left], ["Right", right]] as const) {
    if (evidence.problem) problems.push(`${label}: ${evidence.problem}`);
    else if (evidence.receipt && !terminalExecution(evidence.receipt)) {
      problems.push(`${label}: run ${evidence.receipt.requestId} is ${evidence.receipt.state}, so its outputs are still changing.`);
    }
  }
  if (path.resolve(left.runDirectory) === path.resolve(right.runDirectory)) {
    problems.push("Both sides name the same run directory; choose two different runs.");
  }
  const l = left.receipt, r = right.receipt;
  const empty: RunComparison = {
    left: l ? side(l) : { runDirectory: left.runDirectory, requestId: "", ownerId: "", state: "unknown" },
    right: r ? side(r) : { runDirectory: right.runDirectory, requestId: "", ownerId: "", state: "unknown" },
    comparable: false,
    problems,
    same: {},
    settings: [],
    counts: { paired: 0, onlyLeft: 0, onlyRight: 0, changed: 0, unverified: 0 },
    onlyLeft: [],
    onlyRight: [],
    changed: [],
    unverified: [],
  };
  if (!l || !r) return empty;

  const sameFacts: RunComparison["same"] = {};
  if (left.preparation && right.preparation) {
    sameFacts.sourceMesh = left.preparation.sourceMesh.revision === right.preparation.sourceMesh.revision;
    sameFacts.problemtype = left.preparation.problemtype === right.preparation.problemtype;
    sameFacts.settings = left.preparation.settingsRevision === right.preparation.settingsRevision;
    const lh = left.preparation.handoff, rh = right.preparation.handoff;
    if (lh && rh) {
      sameFacts.cadSource = lh.sourceRevision === rh.sourceRevision &&
        (lh.replay === undefined || rh.replay === undefined || lh.replay === rh.replay);
    }
  }

  const byLeft = new Map<string, ExecutionArtifact>();
  for (const artifact of l.artifacts) byLeft.set(`${artifact.role}\u0000${relative(l.runDirectory, artifact.path)}`, artifact);
  const byRight = new Map<string, ExecutionArtifact>();
  for (const artifact of r.artifacts) byRight.set(`${artifact.role}\u0000${relative(r.runDirectory, artifact.path)}`, artifact);

  const paired: ArtifactChange[] = [], changed: ArtifactChange[] = [], unverified: ArtifactChange[] = [], onlyLeft: string[] = [], onlyRight: string[] = [];
  for (const [k, artifact] of byLeft) {
    const other = byRight.get(k);
    const rel = relative(l.runDirectory, artifact.path);
    if (!other) {
      onlyLeft.push(`${artifact.role}:${rel}`);
      continue;
    }
    const change: ArtifactChange = {
      role: artifact.role,
      path: rel,
      ...(artifact.revision ? { left: artifact.revision } : {}),
      ...(other.revision ? { right: other.revision } : {}),
    };
    paired.push(change);
    // No revision on either side is NOT equality: nothing pinned those bytes,
    // so the pair is reported as unverified rather than as unchanged or changed.
    if (artifact.revision === undefined || other.revision === undefined) unverified.push({ ...change, unverified: true });
    else if (artifact.revision !== other.revision) changed.push(change);
  }
  for (const [k, artifact] of byRight) {
    if (!byLeft.has(k)) onlyRight.push(`${artifact.role}:${relative(r.runDirectory, artifact.path)}`);
  }

  return {
    ...empty,
    comparable: problems.length === 0,
    same: sameFacts,
    settings: left.preparation && right.preparation ? diffSettings(left.preparation.settings, right.preparation.settings) : [],
    counts: {
      paired: paired.length,
      onlyLeft: onlyLeft.length,
      onlyRight: onlyRight.length,
      changed: changed.length,
      unverified: unverified.length,
    },
    onlyLeft: onlyLeft.slice(0, COMPARE_LIST_LIMIT),
    onlyRight: onlyRight.slice(0, COMPARE_LIST_LIMIT),
    changed: changed.slice(0, COMPARE_LIST_LIMIT),
    unverified: unverified.slice(0, COMPARE_LIST_LIMIT),
  };
}
