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
 * All state lives in `src/parser/opQueueCore.ts` (pure, Node-tested); this
 * module is the DOM glue — rows, reorder/edit buttons, the inline JSON
 * editor, the recipe save/load buttons and the host messaging.
 */

import { OpQueue } from "../src/parser/opQueueCore";

type PostMessage = (msg: unknown) => void;

const queue = new OpQueue();
let post: PostMessage = () => {};
/** Which row (by index) currently shows the inline JSON editor, if any. */
let editing = -1;
let queueMode = false;

export function isQueueMode(): boolean {
  return queueMode;
}

/** Stages a built `{op, ...params}` message instead of posting it immediately. */
export function stageOp(msg: Record<string, unknown>): void {
  queue.stage(msg);
  render();
}

export function clearQueue(): void {
  queue.clear();
  editing = -1;
  render();
}

/**
 * Stages recipe records loaded from disk (host `queueLoaded` reply).
 * Appends — never replaces — so a loaded recipe composes with steps already
 * staged. Returns how many records were stagable.
 */
export function stageLoadedOps(ops: unknown): number {
  const n = queue.stageAll(Array.isArray(ops) ? ops : []);
  render();
  return n;
}

function move(index: number, delta: -1 | 1): void {
  const landed = queue.move(index, delta);
  if (editing === index && landed >= 0) editing = landed;
  render();
}

function removeAt(index: number): void {
  queue.remove(index);
  if (editing === index) editing = -1;
  else if (editing > index) editing -= 1;
  render();
}

function rowButton(title: string, text: string, cls: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = cls;
  btn.title = title;
  btn.textContent = text;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick(e);
  });
  return btn;
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
  queue.rows().forEach((q, i) => {
    const row = document.createElement("div");
    row.className = "edit-op-row edit-queue-row";
    const num = document.createElement("span");
    num.className = "edit-op-num";
    num.textContent = String(i + 1);
    const label = document.createElement("span");
    label.className = "edit-op-label";
    label.textContent = q.summary ? `${q.label} (${q.summary})` : q.label;
    row.append(num, label);
    row.append(
      rowButton("Move step earlier", "↑", "edit-op-rowbtn", () => move(i, -1)),
      rowButton("Move step later", "↓", "edit-op-rowbtn", () => move(i, 1)),
      rowButton("Edit step parameters as JSON", "✎", "edit-op-rowbtn", () => {
        editing = editing === i ? -1 : i;
        render();
      }),
      rowButton("Remove from the queue", "×", "edit-op-remove", () => removeAt(i))
    );
    list.appendChild(row);
    if (editing === i) list.appendChild(editorRow(i, q.msg));
  });
}

/** The inline JSON editor for one queued step. */
function editorRow(index: number, msg: Record<string, unknown>): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "edit-queue-editor";
  const area = document.createElement("textarea");
  area.className = "edit-queue-json";
  area.rows = 4;
  area.spellcheck = false;
  area.value = JSON.stringify(msg, null, 2);
  const err = document.createElement("div");
  err.className = "edit-queue-error";
  err.hidden = true;
  const bar = document.createElement("div");
  bar.className = "edit-queue-editbar";
  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "panel-btn";
  apply.textContent = "Apply edit";
  apply.addEventListener("click", () => {
    const r = queue.update(index, area.value);
    if (!r.ok) {
      err.textContent = r.error ?? "Invalid step.";
      err.hidden = false;
      return;
    }
    editing = -1;
    render();
  });
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "panel-btn";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => {
    editing = -1;
    render();
  });
  bar.append(apply, cancel);
  wrap.append(area, err, bar);
  return wrap;
}

/**
 * Wires the queue-mode checkbox, the clear button and the recipe save/load
 * buttons. "Apply queued steps" itself needs no separate wiring — it
 * registers `buildApplyBatchMsg` under meshMod.ts's ASYNC_BUILDERS, which
 * already drives the play/stop toggle and `postMessage` for every async op
 * button.
 */
export function initOpQueue(postMessage: PostMessage): void {
  post = postMessage;
  document.getElementById("edit-queue-mode")?.addEventListener("change", (e) => {
    queueMode = (e.target as HTMLInputElement).checked;
  });
  document.getElementById("edit-queue-clear")?.addEventListener("click", () => clearQueue());
  document.getElementById("edit-queue-save")?.addEventListener("click", () => {
    if (queue.length > 0) post({ type: "saveQueue", ops: queue.messages() });
  });
  document.getElementById("edit-queue-load")?.addEventListener("click", () => post({ type: "loadQueue" }));
  render();
}

/** Registered into meshMod.ts's ASYNC_BUILDERS under the "batch" key. */
export function buildApplyBatchMsg(): Record<string, unknown> | undefined {
  const msg = queue.takeBatch();
  editing = -1;
  render();
  return msg;
}
