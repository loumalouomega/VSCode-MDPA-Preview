/**
 * The replay-from-base operation history: a pristine base model + an ordered op
 * list + a cursor. Each editor panel owns one.
 *
 * Pure module — no `vscode`, no DOM — so the whole stateful layer is
 * Node-testable. The vscode-facing glue (the recipe save/load dialogs and the
 * replay progress notification) lives in `src/opHistory.ts`, which re-exports
 * this class; the same core/glue split as `whatsNewCore.ts` / `whatsNew.ts`.
 * The pure replay/dispatch/serialization one level down is `operations.ts`.
 *
 * ## setBase vs rebase
 *
 * `setBase` is for a genuinely NEW document and discards the stack. `rebase`
 * is for the same document re-read from disk (a watcher fired, the user hit
 * Reload, the timeline moved to another step) and KEEPS it, so an external file
 * change no longer silently destroys every edit the user made. The distinction
 * is the whole point of this module: before it existed there was only `setBase`
 * and every re-parse called it.
 */

import { MdpaModel } from "./types";
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
} from "./operations";

/**
 * What became of one op the last time the stack was replayed onto a new base.
 *
 * There is deliberately no "failed" state: `applyOpAsync` never throws for a
 * data problem — a real failure and a legitimate nothing-to-do both come back
 * as `{noop: true, message}` — so claiming to tell them apart would be a lie.
 * `noop` carries the op's own message instead and lets the user judge.
 */
export type OpStatus =
  /** Ran and changed the model. */
  | "applied"
  /** Ran and changed nothing; `note` is the op's own explanation. */
  | "noop"
  /** Deliberately not run (an async op during a timeline step). */
  | "skipped";

export interface OpStateEntry {
  op: OpName;
  label: string;
  /** Absent until the stack has been replayed onto a new base at least once. */
  status?: OpStatus;
  /** The op's own message, shown as the row's tooltip. */
  note?: string;
}

export interface OpStateMsg {
  ops: OpStateEntry[];
  cursor: number;
  canUndo: boolean;
  canRedo: boolean;
  /** True when any applied op was skipped — drives the "Re-apply" affordance. */
  hasSkipped: boolean;
}

/** Result of applying several records in one call via `applyMany`. */
export interface ApplyManyResult {
  outcomes: OpOutcome[];
  /** How many steps actually changed the model. */
  appliedCount: number;
  /** How many steps ran but had no effect (not recorded, per `applyNew`'s rule). */
  noopCount: number;
  /** True when an abort signal stopped the sequence before every step ran. */
  stoppedEarly: boolean;
}

export interface ApplyManyOptions extends MmgRunOptions {
  /** Fired just before each step starts, e.g. for a "Step i/N: <label>…" line. */
  onStepProgress?: (index: number, total: number, rec: OpRecord) => void;
}

/** Per-op outcome of a rebase replay, index-aligned with the op stack. */
export interface RebaseReport {
  model: MdpaModel;
  highlightNodes?: number[];
  statuses: OpStatus[];
  notes: (string | undefined)[];
  /** Counts, for the caller's summary message. */
  applied: number;
  noops: number;
  skipped: number;
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
  /** Status of each op as of the last rebase replay; parallel to `ops`. */
  private statuses = new Map<number, { status: OpStatus; note?: string }>();

  /** Set the pristine model for a NEW document; resets the op stack. */
  setBase(model: MdpaModel): void {
    this.base = model;
    this.ops = [];
    this.cursor = 0;
    this.snapshots.clear();
    this.statuses.clear();
  }

  /**
   * Swap the base for a re-read of the SAME document, keeping the op stack.
   *
   * Snapshots are dropped: they are states computed against the old base, so
   * reusing one would silently mix two files' geometry. The caller replays with
   * `replayOntoBase` and posts the result.
   */
  rebase(model: MdpaModel): void {
    this.base = model;
    this.snapshots.clear();
    this.statuses.clear();
  }

  hasBase(): boolean {
    return this.base !== undefined;
  }

  /** How many ops are currently applied — 0 means a rebase is free. */
  appliedCount(): number {
    return this.cursor;
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
   * Replay the applied ops onto the current base, recording what each one did.
   *
   * Always replays the whole prefix from the base — a `rebase` has just cleared
   * the snapshots, so there is nothing to start from anyway. `opts.skipAsyncOps`
   * passes over the MMG / meshio++-oracle ops, which is what makes stepping a
   * timeline cheap: the edits follow you through time without a remesh firing on
   * every arrow-key press.
   */
  async replayOntoBase(opts?: MmgRunOptions): Promise<RebaseReport> {
    if (!this.base) throw new Error("OperationHistory has no base model");
    const statuses: OpStatus[] = [];
    const notes: (string | undefined)[] = [];
    let model = this.base;
    let highlightNodes: number[] | undefined;

    for (let i = 0; i < this.cursor; i++) {
      const rec = this.ops[i];
      if (opts?.signal?.aborted) {
        // Everything from here on is untouched rather than mislabelled.
        break;
      }
      if (opts?.skipAsyncOps && isAsyncOp(rec.op)) {
        statuses.push("skipped");
        notes.push(`${OP_LABELS[rec.op]} was not re-applied automatically.`);
        continue;
      }
      const out = await applyOpAsync(model, rec, opts);
      model = out.model;
      if (out.noop) {
        statuses.push("noop");
        notes.push(out.message);
      } else {
        statuses.push("applied");
        notes.push(undefined);
        highlightNodes = out.highlightNodes;
      }
    }

    this.statuses.clear();
    for (let i = 0; i < statuses.length; i++) {
      this.statuses.set(i, { status: statuses[i], note: notes[i] });
    }
    return {
      model,
      highlightNodes,
      statuses,
      notes,
      applied: statuses.filter((s) => s === "applied").length,
      noops: statuses.filter((s) => s === "noop").length,
      skipped: statuses.filter((s) => s === "skipped").length,
    };
  }

  /** True when the last replay skipped an op, so a re-apply would do something. */
  hasSkipped(): boolean {
    for (const [i, s] of this.statuses) {
      if (s.status === "skipped" && i < this.cursor) return true;
    }
    return false;
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
      // A hand-applied op is applied by definition, and it invalidates any
      // status a rebase recorded for the ops it now follows.
      this.statuses.set(this.cursor - 1, { status: "applied" });
    }
    return out;
  }

  /**
   * Applies several records in order, each via `applyNew` — so each step is its
   * own independently undoable history entry, not one opaque unit. A noop step
   * does not stop the sequence (mirroring `replayOntoBase`'s "only an abort
   * halts a replay" rule) and is not recorded, matching `applyNew`. A genuine
   * throw from one step propagates, but every EARLIER step's push already
   * committed via its own `applyNew` call — a batch is a sequence of
   * independently atomic steps, not one all-or-nothing transaction.
   */
  async applyMany(recs: OpRecord[], opts?: ApplyManyOptions): Promise<ApplyManyResult> {
    const outcomes: OpOutcome[] = [];
    let appliedCount = 0;
    let noopCount = 0;
    for (let i = 0; i < recs.length; i++) {
      if (opts?.signal?.aborted) {
        return { outcomes, appliedCount, noopCount, stoppedEarly: true };
      }
      opts?.onStepProgress?.(i, recs.length, recs[i]);
      const out = await this.applyNew(recs[i], opts);
      outcomes.push(out);
      if (out.noop) noopCount++;
      else appliedCount++;
    }
    return { outcomes, appliedCount, noopCount, stoppedEarly: false };
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
    this.statuses.clear();
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
    this.statuses.clear();
  }
  /** The applied ops (what a Save writes). */
  appliedOps(): OpRecord[] {
    return this.ops.slice(0, this.cursor);
  }

  state(): OpStateMsg {
    return {
      ops: this.ops.map((o, i) => {
        const s = this.statuses.get(i);
        const entry: OpStateEntry = { op: o.op, label: OP_LABELS[o.op] };
        if (s) {
          entry.status = s.status;
          if (s.note) entry.note = s.note;
        }
        return entry;
      }),
      cursor: this.cursor,
      canUndo: this.cursor > 0,
      canRedo: this.cursor < this.ops.length,
      hasSkipped: this.hasSkipped(),
    };
  }
}
