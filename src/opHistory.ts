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
import { MdpaModel } from "./parser/types";
import {
  OpRecord,
  OpName,
  OP_LABELS,
  OpApplied,
  OpOutcome,
  applyOpAsync,
  replayOpsAsync,
  isAsyncOp,
  MmgRunOptions,
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
  /**
   * Prefix-length → state after that many ops, stored for prefixes ending in
   * an MMG op so replays (undo/redo of later ops) never re-run the remesher.
   * Ops are deterministic, so a snapshot is exactly what a replay would yield.
   */
  private snapshots = new Map<number, OpApplied>();

  /** Set the pristine model (parse / frame load); resets the op stack. */
  setBase(model: MdpaModel): void {
    this.base = model;
    this.ops = [];
    this.cursor = 0;
    this.snapshots.clear();
  }

  hasBase(): boolean {
    return this.base !== undefined;
  }

  /** Current model = base with ops[0..cursor) applied (from the nearest snapshot). */
  async current(opts?: MmgRunOptions): Promise<OpApplied> {
    if (!this.base) throw new Error("OperationHistory has no base model");
    let start = 0;
    let state: OpApplied = { model: this.base };
    for (const [len, snap] of this.snapshots) {
      if (len <= this.cursor && len > start) {
        start = len;
        state = snap;
      }
    }
    if (start === this.cursor) return state;
    return replayOpsAsync(state.model, this.ops.slice(start, this.cursor), opts);
  }

  /**
   * Applies a new op after truncating any redo tail. Returns the outcome; when
   * it is a noop the op is NOT recorded (the model is unchanged). `opts` feeds
   * live progress + cancellation into the MMG runner.
   */
  async applyNew(rec: OpRecord, opts?: MmgRunOptions): Promise<OpOutcome> {
    const cur = await this.current(opts);
    const out = await applyOpAsync(cur.model, rec, opts);
    if (!out.noop) {
      this.ops = this.ops.slice(0, this.cursor);
      for (const len of [...this.snapshots.keys()]) {
        if (len > this.cursor) this.snapshots.delete(len);
      }
      this.ops.push(rec);
      this.cursor++;
      if (isAsyncOp(rec.op)) {
        this.snapshots.set(this.cursor, { model: out.model, highlightNodes: out.highlightNodes });
      }
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
    this.snapshots.clear();
  }
  /** Move the cursor to `n` ops applied (partial revert; redo tail preserved). */
  revertTo(n: number): void {
    this.cursor = Math.max(0, Math.min(this.ops.length, n));
  }
  /** Replace the stack with a loaded recipe (all applied). */
  load(records: OpRecord[]): void {
    this.ops = records.slice();
    this.cursor = records.length;
    this.snapshots.clear();
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
