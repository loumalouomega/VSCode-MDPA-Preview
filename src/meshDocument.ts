/**
 * The custom-document type both preview providers share, and the hooks a
 * resolved panel publishes onto it.
 *
 * Why hooks rather than state: `saveCustomDocument` and its three siblings are
 * handed only a document, while `history`, `lastModel` and `exportCtx()` live
 * inside `resolveCustomEditor`'s several-hundred-line closure. Hoisting that
 * closure onto the document is the rewrite `emptyPreview.ts` and the matching
 * roadmap non-goal already declined — in a repo with no VS Code integration
 * harness to catch what it breaks. Publishing a small object of thunks at the
 * end of `resolveCustomEditor` is instead the idiom this codebase already uses
 * four times over: `activeMenuHandler` / `activeReloadHandler` /
 * `activePtController`, the `exportCtx()` thunk itself, and the
 * `{reveal, goToLatest}` record `vtkEditorProvider` puts into `panelsByPath`.
 *
 * One hooks object per document is sound only because both providers register
 * with `supportsMultipleEditorsPerDocument: false` (see `extension.ts`): at
 * most one live panel per document, so there is nothing to arbitrate.
 */

import * as vscode from "vscode";
import * as path from "node:path";
import { OpRecord } from "./parser/operations";
import { readOpsBackup, writeOpsBackup, deleteOpsBackup } from "./parser/opsBackup";

/**
 * What a resolved preview panel exposes to the custom-editor lifecycle.
 *
 * `save`/`saveAs` return **false when nothing was written** rather than
 * throwing: every refusal inside `saveMesh` already shows its own warning, and
 * a rejected `saveCustomDocument` would report a second time on top of it. The
 * boolean is what stops VS Code clearing the dirty marker on a file that was
 * never written — the failure this whole migration exists to prevent, arriving
 * through its own fix.
 */
export interface MeshEditorHooks {
  /** The applied operations, for the hot-exit backup. */
  ops(): OpRecord[];
  /** Overwrites the source file. FALSE = nothing was written. */
  save(): Promise<boolean>;
  /** Writes to `destination`. FALSE = nothing was written. */
  saveAs(destination: vscode.Uri): Promise<boolean>;
  /** Drops every edit and re-reads the file from disk. */
  revert(): Promise<void>;
  undo(): void;
  redo(): void;
}

/**
 * A mesh preview's document.
 *
 * `restoredOps` carries a hot-exit backup from `openCustomDocument` to the
 * point in `resolveCustomEditor` where a base model first exists. It **must be
 * consumed once** — the same discipline `takePendingOps` enforces by deleting
 * from its map. The VTK provider's `applyPendingOps` runs on every frame post,
 * and `OperationHistory.load` resets the cursor to the end of the stack, so a
 * recipe left in place would silently undo the user's undos on every timeline
 * step.
 */
export class MeshPreviewDocument implements vscode.CustomDocument {
  constructor(
    readonly uri: vscode.Uri,
    public restoredOps?: OpRecord[]
  ) {}

  /** Published by `resolveCustomEditor`; undefined until the panel resolves. */
  hooks?: MeshEditorHooks;

  /** Removes and returns the restored recipe, if any (one-shot). */
  takeRestoredOps(): OpRecord[] | undefined {
    const ops = this.restoredOps;
    this.restoredOps = undefined;
    return ops;
  }

  dispose(): void {}
}

/**
 * Reads a hot-exit backup named by `CustomDocumentOpenContext.backupId`.
 *
 * The id is whatever `backupCustomDocument` returned; both providers return the
 * destination Uri's string form, so this parses it back. Warnings from the
 * recipe parser are surfaced, since a partly-recovered backup is exactly the
 * case a user needs told about.
 */
export async function restoreOpsFromBackup(
  backupId: string | undefined
): Promise<OpRecord[] | undefined> {
  if (!backupId) return undefined;
  let fsPath: string;
  try {
    fsPath = vscode.Uri.parse(backupId).fsPath;
  } catch {
    return undefined;
  }
  const back = await readOpsBackup(fsPath);
  if (!back) return undefined;
  for (const w of back.warnings) vscode.window.showWarningMessage(`Restored edits: ${w}`);
  return back.operations;
}

/**
 * The shared body of `backupCustomDocument`.
 *
 * The refusal is load-bearing rather than defensive. A document still holding
 * an unconsumed `restoredOps` has not adopted a base model yet — it is showing
 * a header summary, or is still parsing — so its history is empty, and writing
 * here would serialise that empty history **over the very backup those
 * operations came from**. The gate is therefore "is a recipe still waiting",
 * not "are there operations": an empty stack the user genuinely undid their way
 * back to is worth recording faithfully, and reads back as nothing to restore.
 */
export async function backupOps(
  document: MeshPreviewDocument,
  context: vscode.CustomDocumentBackupContext
): Promise<vscode.CustomDocumentBackup> {
  const hooks = document.hooks;
  if (!hooks || document.restoredOps) {
    throw new Error("This preview has not loaded its mesh yet; nothing to back up.");
  }
  const dest = context.destination;
  await writeOpsBackup(dest.fsPath, hooks.ops(), path.basename(document.uri.fsPath));
  return {
    id: dest.toString(),
    delete: () => deleteOpsBackup(dest.fsPath),
  };
}

/**
 * The shared body of `saveCustomDocument` / `saveCustomDocumentAs`.
 *
 * Throwing is the whole point: VS Code clears the dirty marker when this
 * resolves, so a refusal that returned normally would tell the user their work
 * is on disk when it is not.
 */
export async function saveDocument(
  document: MeshPreviewDocument,
  destination?: vscode.Uri
): Promise<void> {
  const hooks = document.hooks;
  if (!hooks) throw new Error("This preview is still loading; try saving again in a moment.");
  const wrote = destination ? await hooks.saveAs(destination) : await hooks.save();
  if (!wrote) {
    throw new Error("The mesh was not written — the editor stays marked as unsaved.");
  }
}
