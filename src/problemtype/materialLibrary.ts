/**
 * Where user material presets live on disk: JSON files under the workspace
 * directories named by `kratos.materials.extraPaths` (default
 * `.kratos/materials`), the same discovery shape as
 * `kratos.problemtypes.extraPaths` and for the same reasons — a curated
 * catalog is something you review, diff and share, not something hidden in
 * `globalState`.
 *
 * `node:fs` only, and therefore NOT importable from the webview: the pure
 * catalog core (types, units, resolution, tolerant parsing) lives in
 * `materialCatalog.ts`, which is.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { MaterialPreset, parsePresetFile, serializePresetFile } from "./materialCatalog";

export interface LibraryProblem {
  file: string;
  message: string;
}

export interface MaterialLibrary {
  presets: MaterialPreset[];
  problems: LibraryProblem[];
}

/**
 * Where user presets are looked for when no configuration says otherwise: the
 * `kratos.materials.extraPaths` default. The MCP server has no settings to
 * read, so it uses this; the extension reads the setting with this default.
 */
export const DEFAULT_MATERIAL_LIBRARY_PATHS = [".kratos/materials"];

/** Absolute paths of every library file, in discovery order. */
export function presetFilePaths(roots: string[], extraPaths: string[]): string[] {
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
 * Reads every library file. A missing directory, a malformed file or a rejected
 * entry is reported and the scan continues: a broken row must not empty the
 * catalog.
 */
export function discoverMaterialLibrary(roots: string[], extraPaths: string[]): MaterialLibrary {
  const presets: MaterialPreset[] = [];
  const problems: LibraryProblem[] = [];
  for (const file of presetFilePaths(roots, extraPaths)) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (err) {
      problems.push({ file, message: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const read = parsePresetFile(text, file);
    presets.push(...read.presets);
    for (const message of read.warnings) problems.push({ file, message });
  }
  return { presets, problems };
}

/** The library directories that exist, creating none of them. */
export function existingLibraryDirs(roots: string[], extraPaths: string[]): string[] {
  const dirs: string[] = [];
  for (const root of roots) {
    for (const dir of extraPaths) {
      const abs = path.isAbsolute(dir) ? dir : path.join(root, dir);
      try {
        if (fs.statSync(abs).isDirectory()) dirs.push(abs);
      } catch {
        /* not there */
      }
    }
  }
  return dirs;
}

/**
 * Copies an external preset file into the first library directory, validating
 * it on the way in. Refuses to overwrite a different file unless told to,
 * because a name collision between two libraries is the one way this could
 * lose a user's hand-written row.
 */
export function importPresetFile(
  source: string,
  roots: string[],
  extraPaths: string[]
): { written: string; presets: MaterialPreset[]; warnings: string[] } {
  const text = fs.readFileSync(source, "utf8");
  const read = parsePresetFile(text, source);
  if (read.presets.length === 0) {
    throw new Error(`No usable preset in ${source}. ${read.warnings.join(" ")}`.trim());
  }
  const dir = existingLibraryDirs(roots, extraPaths)[0] ?? firstLibraryDir(roots, extraPaths);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${read.presets[0].id}.json`);
  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target, "utf8");
    if (existing === serializePresetFile(read.presets)) {
      return { written: target, presets: read.presets, warnings: read.warnings };
    }
    throw new Error(
      `${path.basename(target)} already exists in the material library with different content. ` +
        `Remove or rename it first, or import into a file of your own.`
    );
  }
  fs.writeFileSync(target, serializePresetFile(read.presets));
  return { written: target, presets: read.presets, warnings: read.warnings };
}

/** Writes a preset to an explicit path (export), refusing to clobber silently. */
export function writePresetFile(file: string, presets: MaterialPreset[], overwrite = false): void {
  if (fs.existsSync(file) && !overwrite) {
    throw new Error(`${file} already exists. Choose another name or confirm the overwrite.`);
  }
  fs.writeFileSync(file, serializePresetFile(presets));
}

/** The first configured library directory, created on demand by the caller. */
function firstLibraryDir(roots: string[], extraPaths: string[]): string {
  const dir = extraPaths[0] ?? ".kratos/materials";
  return path.isAbsolute(dir) ? dir : path.join(roots[0] ?? process.cwd(), dir);
}
