/**
 * Host-side operation-history manager and its vscode-facing helpers (parameter
 * gathering + JSON recipe save/load). Each editor panel owns one
 * OperationHistory. The pure replay/dispatch/serialization lives in
 * parser/operations.ts; this module adds the mutable cursor/stack and the native
 * UI (input boxes, quick picks, save/open dialogs) around it.
 */

import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { MdpaModel, SubModelPart } from "./parser/types";
import {
  OpRecord,
  OpName,
  OP_LABELS,
  OpApplied,
  OpOutcome,
  applyOp,
  replayOps,
  serializeOps,
  parseOpsJson,
} from "./parser/operations";

export interface OpStateMsg {
  ops: { op: OpName; label: string }[];
  cursor: number;
  canUndo: boolean;
  canRedo: boolean;
}

/** Replay-from-base history: a pristine base + an ordered op list + a cursor. */
export class OperationHistory {
  private base: MdpaModel | undefined;
  private ops: OpRecord[] = [];
  private cursor = 0;

  /** Set the pristine model (parse / frame load); resets the op stack. */
  setBase(model: MdpaModel): void {
    this.base = model;
    this.ops = [];
    this.cursor = 0;
  }

  hasBase(): boolean {
    return this.base !== undefined;
  }

  /** Current model = base with ops[0..cursor) applied. */
  current(): OpApplied {
    if (!this.base) throw new Error("OperationHistory has no base model");
    return replayOps(this.base, this.ops.slice(0, this.cursor));
  }

  /**
   * Applies a new op after truncating any redo tail. Returns the outcome; when
   * it is a noop the op is NOT recorded (the model is unchanged).
   */
  applyNew(rec: OpRecord): OpOutcome {
    const cur = this.current();
    const out = applyOp(cur.model, rec);
    if (!out.noop) {
      this.ops = this.ops.slice(0, this.cursor);
      this.ops.push(rec);
      this.cursor++;
    }
    return out;
  }

  undo(): void {
    if (this.cursor > 0) this.cursor--;
  }
  redo(): void {
    if (this.cursor < this.ops.length) this.cursor++;
  }
  /** Wipe the whole stack (back to base). */
  clear(): void {
    this.ops = [];
    this.cursor = 0;
  }
  /** Move the cursor to `n` ops applied (partial revert; redo tail preserved). */
  revertTo(n: number): void {
    this.cursor = Math.max(0, Math.min(this.ops.length, n));
  }
  /** Replace the stack with a loaded recipe (all applied). */
  load(records: OpRecord[]): void {
    this.ops = records.slice();
    this.cursor = records.length;
  }
  /** The applied ops (what a Save writes). */
  appliedOps(): OpRecord[] {
    return this.ops.slice(0, this.cursor);
  }

  state(): OpStateMsg {
    return {
      ops: this.ops.map((o) => ({ op: o.op, label: OP_LABELS[o.op] })),
      cursor: this.cursor,
      canUndo: this.cursor > 0,
      canRedo: this.cursor < this.ops.length,
    };
  }
}

/** Depth-first list of every SubModelPart path (for the delete quick pick). */
function collectPartPaths(parts: SubModelPart[], out: string[] = []): string[] {
  for (const p of parts) {
    out.push(p.path);
    collectPartPaths(p.children, out);
  }
  return out;
}

/**
 * Builds a full OpRecord for a newly-requested op, prompting for parameters via
 * native UI. Returns undefined if the user cancels.
 */
export async function gatherOp(
  op: string,
  model: MdpaModel
): Promise<OpRecord | undefined> {
  switch (op) {
    case "linearToQuadratic":
    case "removeOrphanNodes":
      return { op };
    case "mergeNodes": {
      const input = await vscode.window.showInputBox({
        title: "Merge coincident nodes",
        prompt: "Welding tolerance (nodes closer than this are merged)",
        value: "1e-6",
        validateInput: (v) =>
          Number.isFinite(Number(v)) && Number(v) > 0 ? undefined : "Enter a positive number.",
      });
      if (input === undefined) return undefined;
      return { op: "mergeNodes", tolerance: Number(input) };
    }
    case "transformCoords": {
      const input = await vscode.window.showInputBox({
        title: "Scale / translate coordinates",
        prompt: "Enter: scale dx dy dz  (space-separated, e.g. 0.001 0 0 0)",
        value: "1 0 0 0",
        validateInput: (v) => {
          const parts = v.trim().split(/\s+/).map(Number);
          return parts.length >= 1 && parts.length <= 4 && parts.every(Number.isFinite)
            ? undefined
            : "Enter 1–4 numbers: scale [dx dy dz].";
        },
      });
      if (input === undefined) return undefined;
      const [scale, dx = 0, dy = 0, dz = 0] = input.trim().split(/\s+/).map(Number);
      return { op: "transformCoords", scale, dx, dy, dz };
    }
    case "deleteSubModelPart": {
      const paths = collectPartPaths(model.subModelParts);
      if (paths.length === 0) {
        vscode.window.showWarningMessage("This mesh has no SubModelParts to delete.");
        return undefined;
      }
      const pick = await vscode.window.showQuickPick(paths, {
        title: "Delete a SubModelPart",
        placeHolder: "Select the SubModelPart to delete (with its subtree)",
      });
      if (pick === undefined) return undefined;
      return { op: "deleteSubModelPart", path: pick };
    }
    default:
      vscode.window.showWarningMessage(`Unknown operation "${op}".`);
      return undefined;
  }
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
