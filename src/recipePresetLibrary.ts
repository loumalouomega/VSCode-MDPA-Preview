/**
 * Where named recipe presets live on disk: JSON files under the workspace
 * directories named by `kratos.recipes.extraPaths` (default
 * `.kratos/recipes`), the same discovery shape as
 * `kratos.problemtypes.extraPaths` and `kratos.materials.extraPaths`, and for
 * the same reason — a curated recipe is something you review, diff and share,
 * not something hidden in `globalState`.
 *
 * `node:fs` only, and therefore NOT importable from the webview: the pure
 * preset core (format, tolerant parsing, name resolution) lives in
 * `src/parser/recipePresets.ts`, which is.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { RecipePreset, parseRecipePreset } from "./parser/recipePresets";

export interface RecipePresetProblem {
  file: string;
  message: string;
}

/**
 * Where presets are looked for when no configuration says otherwise: the
 * `kratos.recipes.extraPaths` default. The MCP server has no settings to
 * read, so it uses this; the extension reads the setting with this default.
 */
export const DEFAULT_RECIPE_PRESET_PATHS = [".kratos/recipes"];

/** Absolute paths of every preset file, in discovery order. */
export function recipePresetFilePaths(roots: string[], extraPaths: string[]): string[] {
  const files: string[] = [];
  for (const root of roots) {
    for (const dir of extraPaths) {
      const abs = path.isAbsolute(dir) ? dir : path.join(root, dir);
      let names: string[];
      try {
        names = fs.readdirSync(abs);
      } catch {
        continue; // the directory does not exist — nothing to load
      }
      for (const name of names.sort()) {
        if (name.toLowerCase().endsWith(".json")) files.push(path.join(abs, name));
      }
    }
  }
  return files;
}

/**
 * Reads every preset file. A missing directory, a malformed file or a preset
 * with no usable operations is reported and the scan continues: one broken
 * file must not empty the catalog.
 */
export function discoverRecipePresets(
  roots: string[],
  extraPaths: string[]
): { presets: RecipePreset[]; problems: RecipePresetProblem[] } {
  const presets: RecipePreset[] = [];
  const problems: RecipePresetProblem[] = [];
  for (const file of recipePresetFilePaths(roots, extraPaths)) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (err) {
      problems.push({ file, message: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const parsed = parseRecipePreset(text, file);
    if (!parsed.preset || parsed.preset.ops.length === 0) {
      problems.push({
        file,
        message: parsed.warnings.length > 0 ? parsed.warnings.join(" ") : "No usable operations.",
      });
      continue;
    }
    presets.push(parsed.preset);
  }
  return { presets, problems };
}
