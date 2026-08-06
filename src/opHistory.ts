/**
 * The vscode-facing glue around the operation history: the JSON recipe
 * save/load dialogs, and the cancellable replay progress notification.
 *
 * The history itself is `parser/opHistoryCore.ts` — pure and Node-testable —
 * and is re-exported here so every existing import site keeps working. The same
 * core/glue split as `whatsNewCore.ts` / `whatsNew.ts`.
 */

import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { MmgRunOptions, serializeOps, parseOpsJson } from "./parser/operations";
import { OperationHistory } from "./parser/opHistoryCore";

export { OperationHistory } from "./parser/opHistoryCore";
export type {
  OpStateMsg,
  OpStateEntry,
  OpStatus,
  RebaseReport,
} from "./parser/opHistoryCore";

/**
 * Replays the history with a cancellable progress notification.
 *
 * Was duplicated byte-for-byte in both providers; `rerender` is the provider's
 * own re-render closure (it owns `lastModel` and the webview post), so the only
 * thing that ever differed between the two copies stays with the caller.
 *
 * Cancellation is checked BETWEEN ops (see `replayOpsAsync`), so a running MMG
 * op finishes and its partial result is kept — hence the warning's wording.
 */
export function replayWithProgress(
  rerender: (opts: MmgRunOptions) => Promise<void>,
  title = "Replaying operations…"
): Thenable<void> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: true,
    },
    async (progress, token) => {
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());
      await rerender({
        onProgress: (message) => progress.report({ message }),
        signal: abort.signal,
      });
      if (token.isCancellationRequested) {
        vscode.window.showWarningMessage(
          "Replay cancelled — the preview shows a partial result; use Clear or re-load the recipe."
        );
      }
    }
  );
}

/** Save the applied operations to a JSON recipe chosen by the user. */
export async function saveOps(history: OperationHistory, sourceFsPath: string): Promise<void> {
  const ops = history.appliedOps();
  if (ops.length === 0) {
    vscode.window.showWarningMessage("No operations have been applied to save.");
    return;
  }
  const stem = path.basename(sourceFsPath, path.extname(sourceFsPath));
  const dest = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(path.dirname(sourceFsPath), `${stem}.ops.json`)),
    filters: { "Operation recipe": ["json"] },
    title: "Save Operations",
  });
  if (!dest) return;
  await fs.promises.writeFile(
    dest.fsPath,
    serializeOps(ops, path.basename(sourceFsPath)),
    "utf8"
  );
  vscode.window.showInformationMessage(`Saved ${ops.length} operation(s) to ${path.basename(dest.fsPath)}.`);
}

/**
 * Load a JSON recipe into `history` (replayed on the current base). Returns true
 * when the history changed so the caller re-renders.
 */
export async function loadOps(history: OperationHistory, sourceFsPath: string): Promise<boolean> {
  const picks = await vscode.window.showOpenDialog({
    canSelectMany: false,
    defaultUri: vscode.Uri.file(path.dirname(sourceFsPath)),
    filters: { "Operation recipe": ["json"], "All files": ["*"] },
    title: "Load Operations",
  });
  if (!picks || picks.length === 0) return false;
  let text: string;
  try {
    text = await fs.promises.readFile(picks[0].fsPath, "utf8");
  } catch (err) {
    vscode.window.showErrorMessage(`Could not read recipe: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  const { operations, warnings } = parseOpsJson(text);
  for (const w of warnings) vscode.window.showWarningMessage(w);
  if (operations.length === 0) {
    if (warnings.length === 0) vscode.window.showWarningMessage("Recipe contained no operations.");
    return false;
  }
  history.load(operations);
  vscode.window.showInformationMessage(`Loaded ${operations.length} operation(s).`);
  return true;
}
