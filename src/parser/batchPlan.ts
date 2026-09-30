/**
 * Batch application of one recipe to many meshes (roadmap item 4).
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
  const entries: BatchEntry[] = [];
  const seenOutputs = new Map<string, string>();
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
    const clash = seenOutputs.get(k);
    if (clash) {
      problems.push(`${clash} and ${input} both map to ${output}; use {index} in the naming template.`);
    }
    seenOutputs.set(k, input);
    if (!opts.overwrite && opts.exists?.(output) && !inputKeys.has(k)) {
      problems.push(`Output ${output} already exists (pass overwrite to replace it, or resume).`);
    }
    entries.push({ input, output, status: "pending" });
  });
  return { entries, problems };
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
  process(entry: BatchEntry, signal?: AbortSignal): Promise<{ message?: string } | void>;
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
    if (prev?.status === "done" && prev.inputStamp !== undefined && prev.inputStamp === stamp) {
      e.status = "skipped";
      e.message = "Already done (input unchanged).";
      e.inputStamp = stamp;
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
        e.inputStamp = stamp;
      } catch (err) {
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
