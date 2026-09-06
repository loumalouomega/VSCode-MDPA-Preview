/**
 * Reading and writing the hot-exit backup of a preview's unsaved edits.
 *
 * What gets backed up is the **operation recipe**, not the mesh. VS Code calls
 * `backupCustomDocument` roughly one second after the user stops editing, so
 * re-serialising a multi-gigabyte mesh into the extension's storage directory
 * on every idle tick is not an option — and it would not be the right answer
 * even if it were cheap: the recipe IS this extension's representation of
 * unsaved work. It is what `saveOps` writes, what `parseOpsJson` reads, and
 * what a Save-problem archive carries, so the format keeps one definition
 * across all four consumers rather than growing a backup-only variant.
 *
 * Pure in the `parser/` sense — `node:fs` plus the recipe serialisers, no
 * `vscode` — which is what makes it Node-testable (`src/test/opsBackup.test.ts`)
 * while the document glue that calls it (`src/meshDocument.ts`) is not. Same
 * core/glue split as `opHistoryCore.ts` / `opHistory.ts`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { OpRecord, serializeOps, parseOpsJson } from "./operations";

/**
 * Writes the recipe to `destFsPath`, creating its parent directory.
 *
 * The parent really may be missing: `CustomDocumentBackupContext.destination`
 * points inside `ExtensionContext.storagePath` and the API states outright that
 * the folder may not exist yet.
 */
export async function writeOpsBackup(
  destFsPath: string,
  ops: OpRecord[],
  sourceName: string
): Promise<void> {
  await fs.promises.mkdir(path.dirname(destFsPath), { recursive: true });
  await fs.promises.writeFile(destFsPath, serializeOps(ops, sourceName), "utf8");
}

/** What a backup read recovered, plus whatever the recipe parser complained about. */
export interface OpsBackup {
  operations: OpRecord[];
  warnings: string[];
}

/**
 * Reads a backup written by `writeOpsBackup`, or `undefined` if there is
 * nothing usable there.
 *
 * Deliberately total: a missing, unreadable or corrupt backup must never stop
 * the file itself from opening. The worst case is that the user loses edits
 * they had already lost by definition — refusing to open the mesh on top of
 * that would turn a bad session into a stuck one. A recipe that parses to zero
 * operations is `undefined` too, so callers need only one emptiness test.
 */
export async function readOpsBackup(fsPath: string): Promise<OpsBackup | undefined> {
  let text: string;
  try {
    text = await fs.promises.readFile(fsPath, "utf8");
  } catch {
    return undefined;
  }
  const { operations, warnings } = parseOpsJson(text);
  if (operations.length === 0) return undefined;
  return { operations, warnings };
}

/**
 * Deletes a backup, swallowing every failure.
 *
 * `CustomDocumentBackup.delete()` is declared to return `void`, so there is
 * nobody to report a failure to and nothing that could act on one; a rejected
 * promise here would surface as an unhandled rejection in the extension host.
 */
export function deleteOpsBackup(fsPath: string): void {
  void fs.promises.rm(fsPath, { force: true }).catch(() => undefined);
}
