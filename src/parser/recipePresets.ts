/**
 * Named recipe presets for batch processing (roadmap item 5).
 *
 * Pure and vscode-free: a preset is a named op list plus batch defaults
 * (`naming`, `outputExt`, `overwrite`) stored as one JSON file per preset, so
 * a preset is reviewable, diffable and shareable. The on-disk shape reuses the
 * recipe `operations` key, so a preset file also reads as an operations
 * recipe. Filesystem discovery lives in `src/recipePresetLibrary.ts`, the
 * same pure-core/fs-half split as the material catalog.
 */
import { OpRecord, parseOpsJson } from "./operations";

export const RECIPE_PRESET_VERSION = 1;

export interface RecipePreset {
  /** Display name; also the default `recipeName` for output naming. */
  name: string;
  description?: string;
  /** Output name template (`{stem}`/`{recipe}`/`{index}`/`{ext}`); batch default when absent. */
  naming?: string;
  /** Output extension with dot; default keeps each input's own when absent. */
  outputExt?: string;
  overwrite?: boolean;
  /** Validated op records; unknown entries are dropped with a warning at parse time. */
  ops: OpRecord[];
  /** Source file, set by discovery. Never serialized. */
  file?: string;
}

/** Keeps a preset name usable inside a file name. */
export function safePresetFileName(name: string): string {
  const s = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return s || "preset";
}

export function serializeRecipePreset(preset: Omit<RecipePreset, "ops" | "file"> & { ops: unknown[] }): string {
  const body: Record<string, unknown> = { version: RECIPE_PRESET_VERSION, name: preset.name, operations: preset.ops };
  if (preset.description !== undefined) body.description = preset.description;
  if (preset.naming !== undefined) body.naming = preset.naming;
  if (preset.outputExt !== undefined) body.outputExt = preset.outputExt;
  if (preset.overwrite !== undefined) body.overwrite = preset.overwrite;
  return JSON.stringify(body, null, 2) + "\n";
}

/**
 * Tolerant read: a malformed file gives `preset: undefined` plus warnings,
 * never a throw. Unknown operations are dropped with a warning (the
 * `parseOpsJson` rule); invalid batch defaults fall back to the batch
 * defaults with a warning rather than failing every later plan.
 */
export function parseRecipePreset(text: string, file?: string): { preset?: RecipePreset; warnings: string[] } {
  const tag = file ?? "preset";
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { warnings: [`${tag}: not valid JSON.`] };
  }
  const obj = raw as Record<string, unknown> | null;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { warnings: [`${tag}: not a JSON object.`] };
  const name = typeof obj.name === "string" && obj.name.trim() !== "" ? obj.name : undefined;
  const fileStem =
    file !== undefined ? file.replace(/\\/g, "/").split("/").pop()?.replace(/\.json$/i, "") || undefined : undefined;
  if (!name) warnings.push(`${tag}: no usable "name"; using ${fileStem ? `the file name ("${fileStem}")` : '"preset"'}.`);
  const parsed = parseOpsJson(text);
  for (const w of parsed.warnings) warnings.push(`${tag}: ${w}`);
  let naming: string | undefined;
  if (obj.naming !== undefined) {
    if (typeof obj.naming === "string" && (obj.naming.includes("{stem}") || obj.naming.includes("{index}"))) {
      naming = obj.naming;
    } else {
      warnings.push(`${tag}: "naming" must contain {stem} or {index}; using the batch default.`);
    }
  }
  let outputExt: string | undefined;
  if (obj.outputExt !== undefined) {
    if (typeof obj.outputExt === "string" && obj.outputExt.startsWith(".")) {
      outputExt = obj.outputExt;
    } else {
      warnings.push(`${tag}: "outputExt" must start with a dot; using each input's own extension.`);
    }
  }
  let overwrite: boolean | undefined;
  if (obj.overwrite !== undefined) {
    if (typeof obj.overwrite === "boolean") {
      overwrite = obj.overwrite;
    } else {
      warnings.push(`${tag}: "overwrite" must be a boolean; using false.`);
    }
  }
  const preset: RecipePreset = {
    name: name ?? fileStem ?? "preset",
    ops: parsed.operations,
    ...(typeof obj.description === "string" && obj.description !== "" ? { description: obj.description } : {}),
    ...(naming !== undefined ? { naming } : {}),
    ...(outputExt !== undefined ? { outputExt } : {}),
    ...(overwrite !== undefined ? { overwrite } : {}),
    ...(file !== undefined ? { file } : {}),
  };
  return { preset, warnings };
}

/**
 * Finds a preset by name. Last match wins, so a directory searched later (a
 * workspace file over a shared one) overrides on apply while discovery still
 * lists both.
 */
export function findRecipePreset(presets: RecipePreset[], name: string): RecipePreset | undefined {
  const want = name.toLowerCase();
  let found: RecipePreset | undefined;
  for (const p of presets) {
    if (p.name.toLowerCase() === want) found = p;
  }
  return found;
}
