/**
 * The operation queue — "combine several operations into one apply".
 *
 * A staging list, client-side only: while queue mode is on, the Apply button
 * on ANY sidebar form (Edit section's transform forms and Mesh Modification's
 * SYNC_BUILDERS/ASYNC_BUILDERS-driven ones) stages its built `{op, ...params}`
 * message here instead of posting it. "Apply queued steps" then posts them all
 * in one `applyBatch` message, which the host runs in sequence via
 * `OperationHistory.applyMany` — each step still lands as its own,
 * independently undoable history row; queuing changes nothing about how a
 * step is recorded, only how many clicks it takes to fire them off.
 *
 * `OP_LABELS` is imported from `opLabels.ts`, not `operations.ts` — the latter
 * pulls in `node:fs`/`node:path` (mergeMesh's file-reading helpers) that the
 * browser-platform webview bundle cannot resolve.
 */

import { OP_LABELS } from "../src/parser/opLabels";

interface QueuedOp {
  msg: Record<string, unknown>;
  label: string;
  summary: string;
}

let queueMode = false;
let queue: QueuedOp[] = [];

export function isQueueMode(): boolean {
  return queueMode;
}

/** Short "param: value, param: value" text for a queue row — not exhaustive. */
function summarize(msg: Record<string, unknown>): string {
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

/** Stages a built `{op, ...params}` message instead of posting it immediately. */
export function stageOp(msg: Record<string, unknown>): void {
  const op = typeof msg.op === "string" ? msg.op : "";
  queue.push({
    msg,
    label: OP_LABELS[op as keyof typeof OP_LABELS] ?? op,
    summary: summarize(msg),
  });
  render();
}

export function clearQueue(): void {
  queue = [];
  render();
}

function removeAt(index: number): void {
  queue.splice(index, 1);
  render();
}

/** `{type:"applyBatch", ops:[...]}`, or undefined when the queue is empty. */
function buildApplyBatchMsg(): Record<string, unknown> | undefined {
  if (queue.length === 0) return undefined;
  const ops = queue.map((q) => q.msg);
  queue = []; // consumed on submit, like any other form's inputs
  render();
  return { type: "applyBatch", ops };
}

function render(): void {
  const list = document.getElementById("edit-queue-list");
  const applyBtn = document.getElementById("edit-apply-batch") as HTMLButtonElement | null;
  const empty = queue.length === 0;
  // Direct, for immediate feedback right after staging/removing an item (no
  // opProgress event fires just from that). The gate element mirrors it too,
  // so a LATER, unrelated setMeshModProgress call (after some other op
  // finishes) restores this button's disabled state from the gate rather than
  // unconditionally clearing it — see the markup comment in webviewChrome.ts.
  if (applyBtn) applyBtn.disabled = empty;
  const gate = document.getElementById("edit-queue-gate") as HTMLInputElement | null;
  if (gate) gate.disabled = empty;
  if (!list) return;
  list.textContent = "";
  queue.forEach((q, i) => {
    const row = document.createElement("div");
    row.className = "edit-op-row edit-queue-row";
    const num = document.createElement("span");
    num.className = "edit-op-num";
    num.textContent = String(i + 1);
    const label = document.createElement("span");
    label.className = "edit-op-label";
    label.textContent = q.summary ? `${q.label} (${q.summary})` : q.label;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "edit-op-remove";
    remove.title = "Remove from the queue";
    remove.textContent = "×";
    remove.addEventListener("click", (e) => {
      e.stopPropagation();
      removeAt(i);
    });
    row.append(num, label, remove);
    list.appendChild(row);
  });
}

/**
 * Wires the queue-mode checkbox and the clear button. "Apply queued steps"
 * itself needs no separate wiring — it registers `buildApplyBatchMsg` under
 * meshMod.ts's ASYNC_BUILDERS, which already drives the play/stop toggle and
 * `postMessage` for every async op button.
 */
export function initOpQueue(): void {
  document.getElementById("edit-queue-mode")?.addEventListener("change", (e) => {
    queueMode = (e.target as HTMLInputElement).checked;
  });
  document.getElementById("edit-queue-clear")?.addEventListener("click", () => clearQueue());

  render();
}

/** Registered into meshMod.ts's ASYNC_BUILDERS under the "batch" key. */
export { buildApplyBatchMsg };
