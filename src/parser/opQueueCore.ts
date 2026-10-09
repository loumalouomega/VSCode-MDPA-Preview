/**
 * The operation queue's state (former roadmap item 5, delivered 2026-10-09) — "combine several operations
 * into one apply", without any DOM.
 *
 * Pure and Node-testable: the webview module (`webview/opQueue.ts`) owns the
 * rows, the inline JSON editor and the host messaging, and delegates every
 * state transition here, so reorder/edit/import/export are pinned by
 * `src/test/opQueueCore.test.ts` instead of only by a Chromium smoke check.
 * `OP_LABELS` comes from the fs-free `opLabels.ts` leaf, never from
 * `operations.ts` (whose `node:fs`/`node:path` imports the browser bundle
 * cannot resolve).
 */
import { OP_LABELS, OpName } from "./opLabels";

export interface QueuedOp {
  msg: Record<string, unknown>;
  label: string;
  summary: string;
}

/** Short "param: value, param: value" text for a queue row — not exhaustive. */
export function summarizeOp(msg: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(msg)) {
    if (k === "op" || k === "type") continue;
    if (typeof v === "number" || typeof v === "boolean") {
      parts.push(`${k}: ${v}`);
    } else if (typeof v === "string" && v.length > 0 && v.length <= 24) {
      parts.push(`${k}: ${v}`);
    } else if (Array.isArray(v)) {
      parts.push(`${k}: ${v.length}`);
    }
    if (parts.length >= 3) break;
  }
  return parts.join(", ");
}

export function labelOp(msg: Record<string, unknown>): string {
  const op = typeof msg.op === "string" ? msg.op : "";
  return OP_LABELS[op as OpName] ?? op;
}

export function makeQueuedOp(msg: Record<string, unknown>): QueuedOp {
  return { msg, label: labelOp(msg), summary: summarizeOp(msg) };
}

/** True for a plain `{op: "<name>", ...}` object; the host validates params. */
export function isStagableOp(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return typeof (value as Record<string, unknown>).op === "string";
}

/** Parses the inline JSON editor's text into a staged op, or an error to show. */
export function parseEditedOp(text: string): { msg?: Record<string, unknown>; error?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: "Not valid JSON." };
  }
  if (!isStagableOp(raw)) return { error: "Must be an object with a string \"op\" field." };
  return { msg: raw };
}

export class OpQueue {
  private steps: QueuedOp[] = [];

  get length(): number {
    return this.steps.length;
  }

  rows(): QueuedOp[] {
    return [...this.steps];
  }

  /** Appends one staged message; returns false when it is not an op at all. */
  stage(msg: Record<string, unknown>): boolean {
    if (!isStagableOp(msg)) return false;
    this.steps.push(makeQueuedOp(msg));
    return true;
  }

  /** Appends loaded recipe records; returns how many were stagable. */
  stageAll(ops: unknown[]): number {
    let n = 0;
    for (const op of ops) {
      if (isStagableOp(op)) {
        this.steps.push(makeQueuedOp(op));
        n++;
      }
    }
    return n;
  }

  /**
   * Moves a step; returns its new index, or -1 when the move was clamped or
   * out of range (the order is unchanged).
   */
  move(index: number, delta: -1 | 1): number {
    const j = index + delta;
    if (index < 0 || index >= this.steps.length || j < 0 || j >= this.steps.length) return -1;
    const [step] = this.steps.splice(index, 1);
    this.steps.splice(j, 0, step);
    return j;
  }

  remove(index: number): void {
    if (index >= 0 && index < this.steps.length) this.steps.splice(index, 1);
  }

  /** Replaces a step's message; false when the index or the JSON is bad. */
  update(index: number, text: string): { ok: boolean; error?: string } {
    if (index < 0 || index >= this.steps.length) return { ok: false, error: "No such step." };
    const parsed = parseEditedOp(text);
    if (!parsed.msg) return { ok: false, error: parsed.error };
    this.steps[index] = makeQueuedOp(parsed.msg);
    return { ok: true };
  }

  clear(): void {
    this.steps = [];
  }

  /** The staged messages, in order. Consuming the queue is the caller's job. */
  messages(): Record<string, unknown>[] {
    return this.steps.map((q) => q.msg);
  }

  /**
   * Folds the queue into `{type:"applyBatch", ops:[...]}` and clears it —
   * consumed like any other form's inputs, so a re-click cannot resubmit
   * steps that already ran. Undefined when the queue is empty.
   */
  takeBatch(): Record<string, unknown> | undefined {
    if (this.steps.length === 0) return undefined;
    const ops = this.messages();
    this.clear();
    return { type: "applyBatch", ops };
  }
}
