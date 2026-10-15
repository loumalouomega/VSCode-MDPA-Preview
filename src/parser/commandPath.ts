/**
 * Pure path rule for command-line file arguments (`export vtu to=out/a.vtu`).
 * No vscode, no fs: the host supplies the base folder and checks existence.
 * Relative paths resolve against the mesh's folder; nothing is expanded.
 */
import * as path from "node:path";

export type CommandPathResult = { ok: true; path: string } | { ok: false; reason: string };

export function resolveCommandPath(raw: unknown, baseDir: string, opts: { ext?: string } = {}): CommandPathResult {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, reason: "The path is empty." };
  if (raw.includes("\0")) return { ok: false, reason: "The path contains a NUL character." };
  if (/[\\/]$/.test(raw.trim())) return { ok: false, reason: `"${raw}" names a folder, not a file.` };
  let full = path.resolve(baseDir, raw.trim());
  if (opts.ext) {
    const want = opts.ext.toLowerCase();
    const have = path.extname(full).toLowerCase();
    if (!have) full += want;
    else if (!full.toLowerCase().endsWith(want)) return { ok: false, reason: `"${raw}" does not end in ${want}.` };
  }
  return { ok: true, path: full };
}

export function overwriteRefusal(file: string): string {
  return `${file} already exists; add overwrite=true to replace it.`;
}
