/**
 * The vscode-facing "apply an operation" runner shared by both preview
 * providers — the in-flight guard, the inline sidebar progress plumbing and
 * the post-apply rerender, which used to be duplicated byte-for-byte in
 * `mdpaEditorProvider.ts` and `vtkEditorProvider.ts`.
 *
 * `applyOperation` is that duplicated block, lifted verbatim (same guard,
 * same progress messages, same catch/finally shape — no behavior change).
 * `applyBatch` is new: it runs several operations in one sequence via
 * `OperationHistory.applyMany`, sharing the SAME `opInFlight`/`opAbort` guard
 * state as `applyOperation` (only one of a single op or a batch can run at a
 * time per panel), but its failure handling genuinely differs — a batch can
 * commit several steps before a later one throws, so unlike `applyOperation`
 * (which never needs to rerender on a throw, since a single op either fully
 * committed or nothing did) `applyBatch`'s catch block rerenders too.
 */

import * as vscode from "vscode";
import { MdpaModel } from "./parser/types";
import { OperationHistory } from "./parser/opHistoryCore";
import { opRecordFromMessage, isAsyncOp, OP_LABELS, MmgRunOptions, OpRecord } from "./parser/operations";

export interface OpRunnerDeps {
  history: OperationHistory;
  webviewPanel: vscode.WebviewPanel;
  /** The provider's own `lastModel` — read fresh on every call, not captured. */
  getLastModel: () => MdpaModel | undefined;
  isDisposed: () => boolean;
  /** The provider's own re-render closure (owns `lastModel` + the webview post). */
  rerender: (opts?: MmgRunOptions) => Promise<void>;
}

export interface OpRunner {
  applyOperation(msg: Record<string, unknown>): Promise<void>;
  applyBatch(msg: { ops?: unknown[] }): Promise<void>;
  /** Aborts whichever of applyOperation/applyBatch is currently in flight. */
  cancel(): void;
}

export function createOpRunner(deps: OpRunnerDeps): OpRunner {
  const { history, webviewPanel, getLastModel, isDisposed, rerender } = deps;
  let opInFlight = false;
  let opAbort: AbortController | undefined;

  async function applyOperation(msg: Record<string, unknown>): Promise<void> {
    if (!history.hasBase() || !getLastModel()) {
      vscode.window.showWarningMessage("The mesh is still loading; try again.");
      return;
    }
    if (opInFlight) {
      vscode.window.showWarningMessage("An operation is already running; wait for it to finish.");
      return;
    }
    const rec = opRecordFromMessage(msg);
    if (!rec) {
      vscode.window.showWarningMessage("Invalid operation parameters.");
      return;
    }
    const mmgOp = isAsyncOp(rec.op);
    const postProgress = (running: boolean, message?: string): void => {
      if (!isDisposed() && mmgOp) {
        webviewPanel.webview.postMessage({ type: "opProgress", running, op: rec.op, message });
      }
    };
    opInFlight = true;
    try {
      let outcome;
      if (mmgOp) {
        opAbort = new AbortController();
        postProgress(true, `${OP_LABELS[rec.op]}…`);
        outcome = await history.applyNew(rec, {
          onProgress: (message) => postProgress(true, message),
          signal: opAbort.signal,
        });
      } else {
        outcome = await history.applyNew(rec);
      }
      if (outcome.message) {
        // A noop (rejected/cancelled/no-effect op) changes nothing on screen,
        // so make its explanation stand out.
        if (outcome.noop) vscode.window.showWarningMessage(outcome.message);
        else vscode.window.showInformationMessage(outcome.message);
      }
      if (!outcome.noop) await rerender();
    } catch (err) {
      vscode.window.showErrorMessage(
        `Operation failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      opInFlight = false;
      opAbort = undefined;
      postProgress(false);
    }
  }

  async function applyBatch(msg: { ops?: unknown[] }): Promise<void> {
    if (!history.hasBase() || !getLastModel()) {
      vscode.window.showWarningMessage("The mesh is still loading; try again.");
      return;
    }
    if (opInFlight) {
      vscode.window.showWarningMessage("An operation is already running; wait for it to finish.");
      return;
    }
    const raw = Array.isArray(msg.ops) ? msg.ops : [];
    const records: OpRecord[] = [];
    for (const entry of raw) {
      const rec = opRecordFromMessage((entry ?? {}) as Record<string, unknown>);
      if (rec) records.push(rec);
      else vscode.window.showWarningMessage("Skipped an invalid queued operation.");
    }
    if (records.length === 0) {
      vscode.window.showWarningMessage("Nothing valid to apply.");
      return;
    }
    const postProgress = (running: boolean, message?: string): void => {
      if (!isDisposed()) {
        webviewPanel.webview.postMessage({ type: "opProgress", running, op: "batch", message });
      }
    };
    opInFlight = true;
    opAbort = new AbortController();
    try {
      postProgress(true, `Applying ${records.length} queued step(s)…`);
      const result = await history.applyMany(records, {
        signal: opAbort.signal,
        onProgress: (message) => postProgress(true, message),
        onStepProgress: (i, total, rec) => postProgress(true, `Step ${i + 1}/${total}: ${OP_LABELS[rec.op]}…`),
      });
      const summary =
        `Applied ${result.appliedCount}/${records.length} queued step(s)` +
        (result.noopCount > 0 ? ` (${result.noopCount} no-op)` : "") +
        (result.stoppedEarly ? " — stopped early (cancelled)." : ".");
      if (result.appliedCount > 0) vscode.window.showInformationMessage(summary);
      else vscode.window.showWarningMessage(summary);
      if (result.appliedCount > 0) await rerender();
    } catch (err) {
      vscode.window.showErrorMessage(
        `Batch apply failed: ${err instanceof Error ? err.message : String(err)}`
      );
      // Earlier steps in the batch may have committed before the throw.
      await rerender();
    } finally {
      opInFlight = false;
      opAbort = undefined;
      postProgress(false);
    }
  }

  return {
    applyOperation,
    applyBatch,
    cancel: () => opAbort?.abort(),
  };
}
