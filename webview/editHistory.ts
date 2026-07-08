// Edit / operation-history sidebar wiring for the webview. The section markup
// lives in src/webviewChrome.ts (SIDEBAR_HTML); this module forwards button
// clicks to the host (which owns the OperationHistory) and renders the history
// list from the `opState` messages the host posts back.

type PostMessage = (msg: unknown) => void;

interface OpStateMsg {
  ops: { op: string; label: string }[];
  cursor: number;
  canUndo: boolean;
  canRedo: boolean;
}

let post: PostMessage = () => {};

/** Wire the Edit-section buttons. Safe to call once after the DOM is ready. */
export function initEditHistory(postMessage: PostMessage): void {
  post = postMessage;

  const on = (id: string, msg: unknown): void => {
    document.getElementById(id)?.addEventListener("click", () => post(msg));
  };

  on("edit-undo", { type: "opUndo" });
  on("edit-redo", { type: "opRedo" });
  on("edit-clear", { type: "opClear" });
  on("edit-remove-orphans", { type: "applyOp", op: "removeOrphanNodes" });
  on("edit-save-ops", { type: "saveOps" });
  on("edit-load-ops", { type: "loadOps" });

  // Interactive transform forms: each Apply button reads its inputs and posts an
  // applyOp with the parameters (no native prompt).
  document.querySelectorAll<HTMLButtonElement>(".edit-apply").forEach((btn) => {
    btn.addEventListener("click", () => {
      const msg = buildApplyMsg(btn.dataset.op ?? "");
      if (msg) post(msg);
    });
  });
  // Enter within a form field applies that form.
  document.querySelectorAll<HTMLElement>(".edit-form-row").forEach((row) => {
    row.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") {
        row.querySelector<HTMLButtonElement>(".edit-apply")?.click();
      }
    });
  });

  // Each transform form collapses/expands its inputs under its title button.
  document.querySelectorAll<HTMLButtonElement>(".edit-form-title").forEach((title) => {
    title.addEventListener("click", () => {
      title.closest(".edit-form")?.classList.toggle("collapsed");
    });
  });
}

/** Reads a numeric input by id. */
function numVal(id: string): number {
  return Number((document.getElementById(id) as HTMLInputElement | null)?.value);
}

/** Builds the applyOp message for a transform form, or undefined if unknown. */
function buildApplyMsg(op: string): Record<string, unknown> | undefined {
  switch (op) {
    case "mergeNodes":
      return { type: "applyOp", op, tolerance: numVal("merge-tol") };
    case "scale":
      return { type: "applyOp", op, sx: numVal("scale-x"), sy: numVal("scale-y"), sz: numVal("scale-z") };
    case "translate":
      return { type: "applyOp", op, dx: numVal("trans-x"), dy: numVal("trans-y"), dz: numVal("trans-z") };
    case "rotate":
      return {
        type: "applyOp",
        op,
        axis: (document.getElementById("rot-axis") as HTMLSelectElement | null)?.value ?? "z",
        angle: numVal("rot-angle"),
      };
    default:
      return undefined;
  }
}

/** Reflect the host's operation-history state into the Edit section. */
export function renderOpHistory(state: OpStateMsg): void {
  const undo = document.getElementById("edit-undo") as HTMLButtonElement | null;
  const redo = document.getElementById("edit-redo") as HTMLButtonElement | null;
  const clear = document.getElementById("edit-clear") as HTMLButtonElement | null;
  if (undo) undo.disabled = !state.canUndo;
  if (redo) redo.disabled = !state.canRedo;
  if (clear) clear.disabled = state.ops.length === 0;

  const list = document.getElementById("edit-history");
  if (!list) return;
  list.textContent = "";
  if (state.ops.length === 0) {
    const empty = document.createElement("p");
    empty.className = "sb-placeholder";
    empty.textContent = "No operations applied.";
    list.appendChild(empty);
    return;
  }

  state.ops.forEach((o, i) => {
    const applied = i < state.cursor;
    const row = document.createElement("button");
    row.type = "button";
    row.className = "edit-op-row" + (applied ? "" : " undone");
    row.title = applied ? "Revert to this step" : "Redo up to this step";
    // Clicking a row moves the cursor to just after this op (partial revert).
    row.addEventListener("click", () => post({ type: "opRevertTo", index: i + 1 }));

    const num = document.createElement("span");
    num.className = "edit-op-num";
    num.textContent = String(i + 1);
    const label = document.createElement("span");
    label.className = "edit-op-label";
    label.textContent = o.label;
    row.append(num, label);
    list.appendChild(row);
  });
}
