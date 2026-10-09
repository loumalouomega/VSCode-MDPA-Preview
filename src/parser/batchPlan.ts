/**
 * Batch application of one recipe to many meshes (former roadmap item 5, delivered 2026-10-09).
 *
 * Pure and vscode-free: planning (deterministic output names plus the refusal
 * of any output that would overwrite an input, another output or an existing
 * file), the resumable manifest and the sequential runner. Everything that
 * touches a mesh (load, apply, write) is injected, so the same core serves the
 * MCP tool and the extension command, and stays testable without wasm.
 */
import * as path from "node:path";
import { createHash } from "node:crypto";
import { meshExtname, meshStem } from "./meshFormats";
import type { ExportReport } from "./exportReport";

export const BATCH_MANIFEST_VERSION = 1;
export const BATCH_MANIFEST_NAME = "kkss-batch.json";
export const DEFAULT_BATCH_NAMING = "{stem}_{recipe}{ext}";

export type BatchStatus = "pending" | "done" | "failed" | "skipped";

export interface BatchEntry {
  input: string;
  output: string;
  status: BatchStatus;
  message?: string;
  /** size:mtime of the input when it was processed; a changed input is redone on resume. */
  inputStamp?: string;
  report?: ExportReport;
}

export interface BatchManifest {
  version: number;
  recipeName: string;
  recipeHash: string;
  entries: BatchEntry[];
}

export interface PlanBatchOptions {
  inputs: string[];
  outputDir: string;
  recipeName: string;
  /** Placeholders: {stem} {recipe} {index} {ext}. Default `{stem}_{recipe}{ext}`. */
  naming?: string;
  /** Output extension (with dot); default is each input's own. */
  outputExt?: string;
  overwrite?: boolean;
  exists?: (p: string) => boolean;
  /** Case-fold path comparison (Windows). Defaults to the current platform. */
  caseInsensitive?: boolean;
}

export interface BatchPlan {
  entries: BatchEntry[];
  /** Reasons the plan cannot run. A non-empty list means nothing may be written. */
  problems: string[];
  /** Non-blocking notes, e.g. outputs whose companions cannot be predicted. */
  warnings: string[];
}

/**
 * Companion files a batch output will write BESIDE itself, predicted from the
 * output path and extension alone (no model is loaded at plan time).
 *
 * Deterministic cases mirror the writer layer: XDMF keeps its heavy arrays in
 * `<stem>.h5`, TetGen `.ele` needs `<stem>.node`, EnSight `.case` needs
 * `<stem>.geo`, ascii GiD `<stem>.post.msh` needs `<stem>.post.res`, and an
 * OpenFOAM `<dir>/x.foam` marker owns `<dir>/constant` (plus `0/` fields, which
 * a `constant` tripwire already covers). `.vtm` (one `.vtu` per top-level part)
 * and Dolfin `.xml` (one `<stem>_<field>.xml` sibling per field) are
 * model-dependent, so they report `unpredictable` instead of guessing.
 */
export function outputCompanions(output: string): { paths: string[]; unpredictable: boolean } {
  const ext = meshExtname(output).toLowerCase();
  const dir = path.dirname(output);
  const stem = meshStem(path.basename(output));
  switch (ext) {
    case ".xdmf":
    case ".xmf":
      return { paths: [path.join(dir, `${stem}.h5`)], unpredictable: false };
    case ".ele":
      return { paths: [path.join(dir, `${stem}.node`)], unpredictable: false };
    case ".case":
      return { paths: [path.join(dir, `${stem}.geo`)], unpredictable: false };
    case ".post.msh":
      return { paths: [path.join(dir, `${stem}.post.res`)], unpredictable: false };
    case ".foam":
      return { paths: [path.join(dir, "constant")], unpredictable: false };
    case ".vtm":
    case ".xml":
      return { paths: [], unpredictable: true };
    default:
      return { paths: [], unpredictable: false };
  }
}

export function recipeHash(recipeJson: string): string {
  return createHash("sha256").update(recipeJson).digest("hex").slice(0, 16);
}

/** Keeps a recipe name usable inside a file name. */
export function safeRecipeName(name: string): string {
  const s = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return s || "recipe";
}

export function planBatch(opts: PlanBatchOptions): BatchPlan {
  const ci = opts.caseInsensitive ?? process.platform === "win32";
  const key = (p: string) => (ci ? path.resolve(p).toLowerCase() : path.resolve(p));
  const template = opts.naming ?? DEFAULT_BATCH_NAMING;
  const recipe = safeRecipeName(opts.recipeName);
  const problems: string[] = [];
  if (opts.inputs.length === 0) problems.push("No input files.");
  if (!template.includes("{stem}") && !template.includes("{index}")) {
    problems.push(`Naming template "${template}" must contain {stem} or {index}, or every file gets one name.`);
  }
  const inputKeys = new Set(opts.inputs.map(key));
  // OpenFOAM case directories of the inputs: a `.foam` output in the same
  // directory rewrites the input's own `constant/polyMesh`, which a plain path
  // comparison waves through (the `wouldOverwriteOpenFoamCase` rule).
  const inputCaseDirs = new Set(
    opts.inputs.filter((i) => meshExtname(i).toLowerCase() === ".foam").map((i) => key(path.dirname(i)))
  );
  const entries: BatchEntry[] = [];
  const warnings: string[] = [];
  // Every claimed path (outputs and predicted companions alike) maps to the
  // human-readable claim that took it first, so any second claim — output or
  // companion — is refused instead of silently winning the file.
  const seenOutputs = new Map<string, string>();
  const claim = (p: string, desc: string, hint = "; use {index} in the naming template."): void => {
    const k = key(p);
    const prev = seenOutputs.get(k);
    if (prev) {
      problems.push(`${prev} and ${desc} both map to ${p}${hint}`);
    } else {
      seenOutputs.set(k, desc);
    }
  };
  const existsBlocked = (p: string): boolean => !opts.overwrite && (opts.exists?.(p) ?? false);
  opts.inputs.forEach((input, i) => {
    const ext = opts.outputExt ?? meshExtname(input);
    const name = template
      .replace(/\{stem\}/g, meshStem(input))
      .replace(/\{recipe\}/g, recipe)
      .replace(/\{index\}/g, String(i + 1).padStart(4, "0"))
      .replace(/\{ext\}/g, ext);
    if (/[\\/]/.test(name)) problems.push(`Naming template produced a path separator for ${input}.`);
    const output = path.resolve(opts.outputDir, name);
    const k = key(output);
    if (inputKeys.has(k)) {
      problems.push(`Output ${output} is also an input; it would overwrite it.`);
    }
    if (ext.toLowerCase() === ".foam" && inputCaseDirs.has(key(path.dirname(output)))) {
      problems.push(
        `Output ${output} would rewrite the OpenFOAM case an input came from (${path.dirname(output)}); use a different outputDir.`
      );
    }
    claim(output, input);
    if (existsBlocked(output) && !inputKeys.has(k)) {
      problems.push(`Output ${output} already exists (pass overwrite to replace it, or resume).`);
    }
    const companions = outputCompanions(output);
    const isFoam = ext.toLowerCase() === ".foam";
    for (const companion of companions.paths) {
      const desc = `companion of ${input}'s output`;
      const ck = key(companion);
      if (inputKeys.has(ck)) {
        problems.push(`Companion ${companion} (${desc}) is also an input; it would be overwritten.`);
      }
      // An OpenFOAM marker owns its whole directory's constant/ tree, so two
      // .foam outputs in one outputDir collide no matter how they are named.
      claim(companion, desc, isFoam ? ". OpenFOAM outputs each own their directory's constant/ tree: batch at most one .foam per outputDir." : undefined);
      if (existsBlocked(companion) && !inputKeys.has(ck)) {
        problems.push(`Companion ${companion} (${desc}) already exists (pass overwrite to replace it, or resume).`);
      }
    }
    if (companions.unpredictable) {
      warnings.push(
        `Output ${output} writes model-dependent companions (per-part .vtu children for .vtm, per-field siblings for Dolfin .xml) the plan cannot predict; confirm the directory before running.`
      );
    }
    entries.push({ input, output, status: "pending" });
  });
  return { entries, problems, warnings };
}

export function serializeBatchManifest(m: Omit<BatchManifest, "version">): string {
  return JSON.stringify({ version: BATCH_MANIFEST_VERSION, ...m }, null, 2) + "\n";
}

/** Tolerant read: a missing, corrupt or foreign file gives `undefined` plus warnings, never a throw. */
export function parseBatchManifest(text: string): { manifest?: BatchManifest; warnings: string[] } {
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { warnings: ["Batch manifest is not valid JSON."] };
  }
  const r = raw as Partial<BatchManifest> | null;
  if (!r || typeof r !== "object" || !Array.isArray(r.entries)) {
    return { warnings: ["Batch manifest has no entries."] };
  }
  if (typeof r.version === "number" && r.version > BATCH_MANIFEST_VERSION) {
    warnings.push(`Batch manifest version ${r.version} is newer than this reader (${BATCH_MANIFEST_VERSION}).`);
  }
  const statuses: BatchStatus[] = ["pending", "done", "failed", "skipped"];
  const entries: BatchEntry[] = [];
  for (const e of r.entries as Partial<BatchEntry>[]) {
    if (!e || typeof e.input !== "string" || typeof e.output !== "string") {
      warnings.push("Skipped a malformed manifest entry.");
      continue;
    }
    entries.push({
      input: e.input,
      output: e.output,
      status: statuses.includes(e.status as BatchStatus) ? (e.status as BatchStatus) : "pending",
      message: typeof e.message === "string" ? e.message : undefined,
      inputStamp: typeof e.inputStamp === "string" ? e.inputStamp : undefined,
      ...(e.report && typeof e.report === "object" && Array.isArray(e.report.categories) && e.report.target && typeof e.report.target.file === "string" ? { report: e.report } : {}),
    });
  }
  return {
    manifest: {
      version: BATCH_MANIFEST_VERSION,
      recipeName: typeof r.recipeName === "string" ? r.recipeName : "",
      recipeHash: typeof r.recipeHash === "string" ? r.recipeHash : "",
      entries,
    },
    warnings,
  };
}

export interface RunBatchDeps {
  /** Loads, applies the recipe and writes one output. Throwing marks only that file failed. */
  process(entry: BatchEntry, signal?: AbortSignal): Promise<{ message?: string; report?: ExportReport } | void>;
  /** Persists the manifest after every file, so a killed run resumes. */
  save(manifest: BatchManifest): void;
  /** size:mtime of an input; used to decide whether a `done` entry is still valid. */
  stampOf(input: string): string | undefined;
}

export interface RunBatchOptions {
  recipeName: string;
  recipeHash: string;
  signal?: AbortSignal;
  onProgress?(done: number, total: number, entry: BatchEntry): void;
  /** Previous manifest for the same output directory. Honoured only when the recipe hash matches. */
  resume?: BatchManifest;
}

export interface RunBatchResult {
  manifest: BatchManifest;
  done: number;
  failed: number;
  skipped: number;
  cancelled: boolean;
  /** Set when a resume manifest was ignored, and why. */
  resumeNote?: string;
}

export async function runBatch(
  plan: BatchEntry[],
  deps: RunBatchDeps,
  opts: RunBatchOptions
): Promise<RunBatchResult> {
  let resumeNote: string | undefined;
  const previous = new Map<string, BatchEntry>();
  if (opts.resume) {
    if (opts.resume.recipeHash === opts.recipeHash) {
      for (const e of opts.resume.entries) previous.set(path.resolve(e.input) + "\0" + path.resolve(e.output), e);
    } else {
      resumeNote = "Existing manifest was made with a different recipe; ignored.";
    }
  }
  const entries: BatchEntry[] = plan.map((e) => ({ ...e }));
  const manifest = (): BatchManifest => ({
    version: BATCH_MANIFEST_VERSION,
    recipeName: opts.recipeName,
    recipeHash: opts.recipeHash,
    entries,
  });
  let cancelled = false;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (opts.signal?.aborted) {
      cancelled = true;
      break;
    }
    const prev = previous.get(path.resolve(e.input) + "\0" + path.resolve(e.output));
    const stamp = deps.stampOf(e.input);
    if ((prev?.status === "done" || prev?.status === "skipped") && prev.inputStamp !== undefined && prev.inputStamp === stamp) {
      e.status = "skipped";
      e.message = "Already done (input unchanged).";
      e.inputStamp = stamp;
      e.report = prev.report;
    } else {
      try {
        const r = await deps.process(e, opts.signal);
        if (opts.signal?.aborted) {
          cancelled = true;
          e.status = "pending";
          e.message = "Cancelled.";
          deps.save(manifest());
          break;
        }
        e.status = "done";
        e.message = r?.message;
        e.report = r?.report;
        e.inputStamp = stamp;
      } catch (err) {
        if (opts.signal?.aborted) {
          // The abort landed mid-file: the in-flight op was interrupted (an
          // MMG remesh is terminated, a later op never starts), so this entry
          // is NOT a failure — it goes back to pending for the next resume,
          // and the rest of the run stops here.
          cancelled = true;
          e.status = "pending";
          e.message = "Cancelled mid-file; nothing was recorded for this file.";
          deps.save(manifest());
          break;
        }
        e.status = "failed";
        e.message = err instanceof Error ? err.message : String(err);
        e.inputStamp = stamp;
      }
    }
    deps.save(manifest());
    opts.onProgress?.(i + 1, entries.length, e);
  }
  const count = (s: BatchStatus) => entries.filter((e) => e.status === s).length;
  return {
    manifest: manifest(),
    done: count("done"),
    failed: count("failed"),
    skipped: count("skipped"),
    cancelled,
    resumeNote,
  };
}
