/**
 * Variables panel: a repeatable list of NAMED variable definitions, each
 * computed by one of a few methods and — once computed — an ordinary field
 * like any other, immediately usable in any other formula in the sidebar
 * (the Field calculator, or the Remesh "size = ƒ(h)" formula, whose scope
 * `sizeExpr.ts`'s `remeshSizeExprVars` widens with the mesh's own Nodal
 * fields — see operations.ts).
 *
 * This is deliberately UI-only sugar over two operations that already exist
 * and are already tested on their own: `fieldCalc` (a formula over existing
 * fields/coordinates) and `sdfDistance` (signed distance to a surface, file
 * or SubModelPart). A row just builds the right `applyOp` message with a
 * user-chosen `output` name; nothing here is a new backend capability, so
 * there is no separate MCP surface for it — `mesh_transform` already reaches
 * both ops.
 *
 * "Compute, then display on mesh" (the feature this panel exists for) has no
 * message of its own: the host has no way to report "this op produced field
 * X" beyond re-posting the model, so a Play button records which field name
 * it EXPECTS, and `setVariablesModel` (called by main.ts on every `model` /
 * `vtkFrame` message, alongside `setMeshModFields`) checks whether that name
 * now exists among the mesh's Nodal fields. When it does, the row is marked
 * done and the key rides `consumePendingFocus()` for main.ts to open the
 * Field panel on — a one-shot handoff, the same shape `takeRestoredOps`/
 * `takePendingOps` use host-side for "something happened, come get it once".
 */

import { validateSizeExpr } from "../src/parser/sizeExpr";
import { scopeVariables } from "../src/parser/fieldCalc";
import { FieldData } from "../src/parser/types";
import { TOOLBAR_ICONS } from "../src/toolbarIcons";
import { isQueueMode, stageOp } from "./opQueue";

type PostMessage = (msg: unknown) => void;
type VarMethod = "formula" | "distanceFile" | "distancePart";

interface VarRow {
  name: string;
  method: VarMethod;
  expr: string;
  /** Full path for distanceFile (display shows only the base name). */
  path: string;
  part: string;
  status: "idle" | "running" | "done" | "error";
  message?: string;
}

let post: PostMessage = () => {};
let rows: VarRow[] = [];
let smpPaths: string[] = [];
/** Formula scope: x,y,z plus every existing Nodal field, fieldCalc.ts's own convention. */
let formulaVars: string[] = ["x", "y", "z"];
/**
 * True while ANY sidebar operation is running host-side (driven by the host's
 * `opProgress` messages via `setVariablesProgress`, wired in main.ts next to
 * `setMeshModProgress`). Guards `settleVariableRows` so a row is never failed
 * while its own op is still in flight.
 */
let opRunning = false;
/** Which row (if any) is waiting on a `pickMeshFile` reply for its own surface file. */
let awaitingFileRow: number | undefined;
/** The `${kind}:${variable}` key of a field a row just computed, for main.ts to focus once. */
let pendingFocusKey: string | undefined;

export function initVariablesPanel(postMessage: PostMessage): void {
  post = postMessage;
  document.getElementById("var-add")?.addEventListener("click", () => {
    rows.push({ name: "", method: "formula", expr: "", path: "", part: "", status: "idle" });
    render();
  });
  render();
}

function fire(msg: Record<string, unknown>): void {
  if (isQueueMode()) stageOp(msg);
  else post(msg);
}

/** Trailing path segment, for the file-picked display (the webview has no path module). */
function baseName(p: string): string {
  const cut = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return cut >= 0 ? p.slice(cut + 1) : p;
}

/**
 * (Re)populates the formula scope + SubModelPart lists from the current
 * model, and reconciles each running row against the field list — called by
 * main.ts on every `model` / `vtkFrame` message, right where
 * `setMeshModFields`/`setMeshModParts` already are.
 */
export function setVariablesModel(
  fields: FieldData[],
  parts: { path: string; children: unknown[] }[]
): void {
  const nodal = fields.filter((f) => f.kind === "Nodal");
  formulaVars = scopeVariables(nodal, true);

  const paths: string[] = [];
  const walk = (p: { path: string; children: unknown[] }): void => {
    paths.push(p.path);
    (p.children as { path: string; children: unknown[] }[]).forEach(walk);
  };
  parts.forEach(walk);
  smpPaths = paths;

  // A running row's expected output is matched by exact name — fieldCalc
  // stores `output` verbatim, and sdfDistance's own sanitizeVariable is a
  // no-op for any name that was already a valid identifier, which every
  // reasonable variable name is.
  for (const row of rows) {
    if (row.status === "running") {
      const found = nodal.find((f) => f.variable === row.name);
      if (found) {
        row.status = "done";
        row.message = found.components > 1 ? `Computed (${found.components} components).` : "Computed.";
        pendingFocusKey = `Nodal:${found.variable}`;
      }
    } else if (row.status === "done") {
      // The field this row produced is gone from the mesh — a timeline step
      // replayed with skipAsyncOps (sdfDistance is async), a remesh (which
      // drops all fields), or a reload wiped it. A stale "Computed." would
      // claim the box's current text is already on screen while the Remesh
      // formula next door correctly reports the name as unknown, so drop
      // back to idle with the reason instead of keeping the label.
      if (!nodal.some((f) => f.variable === row.name)) {
        row.status = "idle";
        row.message = "No longer on the mesh — press Play to recompute.";
      }
    }
  }
  render();
}

/** One-shot: the field key a just-finished row produced, or undefined. Consumed by main.ts. */
export function consumePendingFocus(): string | undefined {
  const key = pendingFocusKey;
  pendingFocusKey = undefined;
  return key;
}

/**
 * Reflects the host's `opProgress` running flag (wired in main.ts next to
 * `setMeshModProgress`). Async ops (sdfDistance) bracket their run with
 * running:true/false; sync ops (fieldCalc) send none and settle via `opState`.
 */
export function setVariablesProgress(running: boolean): void {
  opRunning = running;
  if (!running) settleVariableRows();
}

/**
 * Fails every row still marked running once its op has finished without
 * producing the expected field — a noop (e.g. sdfDistance over an empty
 * surface, or a part that no longer exists) posts no model, so without this
 * the row reads "Computing…" forever and only a host toast says why. Called
 * from main.ts on every `opState` (which the host now posts even for noops —
 * see opApply.ts) and from `setVariablesProgress(false)`. Never fires while
 * an op is still in flight.
 */
export function settleVariableRows(): void {
  if (opRunning) return;
  let changed = false;
  for (const row of rows) {
    if (row.status !== "running") continue;
    row.status = "error";
    row.message = row.name.trim()
      ? `Did not produce a field named "${row.name.trim()}" — see the notification.`
      : "The operation produced no field — see the notification.";
    changed = true;
  }
  if (changed) render();
}

/** Reply to this panel's own `pickMeshFile{target:"variableDistance"}` request. */
export function setVariableDistancePath(paths: string[]): void {
  const clean = paths.filter((p) => typeof p === "string" && p.length > 0);
  if (awaitingFileRow === undefined) return;
  const row = rows[awaitingFileRow];
  awaitingFileRow = undefined;
  if (!row || !clean[0]) {
    render();
    return;
  }
  row.path = clean[0];
  row.part = ""; // mutually exclusive with the SubModelPart alternative
  render();
}

function validateRow(row: VarRow): string | undefined {
  if (!row.name.trim()) return "Name the variable.";
  if (row.method === "formula") {
    if (!row.expr.trim()) return "Enter a formula.";
    return validateSizeExpr(row.expr.trim(), formulaVars);
  }
  if (row.method === "distanceFile") {
    return row.path ? undefined : "Choose a surface file.";
  }
  return row.part ? undefined : "Choose a SubModelPart.";
}

function buildOpMessage(row: VarRow): Record<string, unknown> {
  const output = row.name.trim();
  if (row.method === "formula") {
    return { type: "applyOp", op: "fieldCalc", location: "Nodal", output, expr: row.expr.trim() };
  }
  if (row.method === "distanceFile") {
    return { type: "applyOp", op: "sdfDistance", path: row.path, output };
  }
  return { type: "applyOp", op: "sdfDistance", part: row.part, output };
}

function render(): void {
  const list = document.getElementById("var-list");
  const hint = document.getElementById("var-hint");
  if (!list) return;
  hint?.classList.toggle("hidden", rows.length > 0);
  list.textContent = "";

  rows.forEach((row, index) => {
    const wrap = document.createElement("div");
    wrap.className = "var-row";

    // Row 1: name + method + delete.
    const line1 = document.createElement("div");
    line1.className = "edit-form-row";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "edit-text";
    nameInput.placeholder = "d";
    nameInput.value = row.name;
    nameInput.title = "Variable / field name";
    nameInput.addEventListener("input", () => {
      row.name = nameInput.value;
      revalidateStatus(wrap, row);
    });
    const methodSelect = document.createElement("select");
    methodSelect.className = "edit-sel edit-sel-grow";
    const methods: [VarMethod, string][] = [
      ["formula", "Formula"],
      ["distanceFile", "Distance to file"],
      ["distancePart", "Distance to SubModelPart"],
    ];
    for (const [value, label] of methods) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      if (value === row.method) opt.selected = true;
      methodSelect.appendChild(opt);
    }
    methodSelect.addEventListener("change", () => {
      row.method = methodSelect.value as VarMethod;
      render();
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "var-row-del";
    del.title = "Remove this variable";
    del.innerHTML = `<span class="toolbar-icon">${TOOLBAR_ICONS.close}</span>`;
    del.addEventListener("click", () => {
      rows.splice(index, 1);
      render();
    });
    line1.append(nameInput, methodSelect, del);
    wrap.appendChild(line1);

    // Row 2: method-specific source.
    const line2 = document.createElement("div");
    line2.className = "edit-form-row";
    if (row.method === "formula") {
      const exprInput = document.createElement("input");
      exprInput.type = "text";
      exprInput.className = "edit-expr-input";
      exprInput.spellcheck = false;
      exprInput.placeholder = "sqrt(VELOCITY_X^2+VELOCITY_Y^2)";
      exprInput.value = row.expr;
      exprInput.title = `Variables: ${formulaVars.join(", ")}. Functions: min max clamp abs sqrt sin cos tan exp log pow floor ceil round; constants pi e.`;
      exprInput.addEventListener("input", () => {
        row.expr = exprInput.value;
        revalidateStatus(wrap, row);
      });
      const field = document.createElement("label");
      field.className = "edit-expr-field edit-field-grow";
      field.append(document.createElement("span"));
      field.appendChild(exprInput);
      line2.appendChild(field);
    } else if (row.method === "distanceFile") {
      const pathInput = document.createElement("input");
      pathInput.type = "text";
      pathInput.className = "edit-text edit-field-grow";
      pathInput.readOnly = true;
      pathInput.placeholder = "Choose a surface mesh…";
      pathInput.value = row.path ? baseName(row.path) : "";
      pathInput.title = row.path;
      const browse = document.createElement("button");
      browse.type = "button";
      browse.title = "Choose the surface mesh to measure distance to";
      browse.innerHTML = `<span class="toolbar-icon">${TOOLBAR_ICONS.open}</span>`;
      browse.addEventListener("click", () => {
        awaitingFileRow = index;
        post({ type: "pickMeshFile", target: "variableDistance" });
      });
      const field = document.createElement("label");
      field.className = "edit-field edit-field-grow";
      field.appendChild(pathInput);
      line2.append(field, browse);
    } else {
      const partSelect = document.createElement("select");
      partSelect.className = "edit-sel edit-sel-grow";
      if (smpPaths.length === 0) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "no SubModelParts";
        partSelect.appendChild(opt);
        partSelect.disabled = true;
      } else {
        const none = document.createElement("option");
        none.value = "";
        none.textContent = "— choose —";
        partSelect.appendChild(none);
        for (const p of smpPaths) {
          const opt = document.createElement("option");
          opt.value = p;
          opt.textContent = p;
          partSelect.appendChild(opt);
        }
        if (smpPaths.includes(row.part)) partSelect.value = row.part;
      }
      partSelect.addEventListener("change", () => {
        row.part = partSelect.value;
        revalidateStatus(wrap, row);
      });
      const field = document.createElement("label");
      field.className = "edit-field edit-field-grow";
      field.appendChild(partSelect);
      line2.appendChild(field);
    }
    wrap.appendChild(line2);

    // Row 3: play + status.
    const line3 = document.createElement("div");
    line3.className = "edit-form-row";
    const play = document.createElement("button");
    play.type = "button";
    play.className = "edit-apply edit-apply-mmg";
    play.title = "Compute this variable and show it on the mesh";
    play.innerHTML =
      `<span class="apply-play toolbar-icon">${TOOLBAR_ICONS.play}</span>` +
      `<span class="apply-stop toolbar-icon">${TOOLBAR_ICONS.stop}</span>`;
    play.addEventListener("click", () => {
      const err = validateRow(row);
      if (err) {
        row.status = "error";
        row.message = err;
        render();
        return;
      }
      row.status = "running";
      row.message = undefined;
      render();
      fire(buildOpMessage(row));
    });
    line3.appendChild(play);
    wrap.appendChild(line3);

    const status = document.createElement("div");
    status.className = "var-status";
    line3.appendChild(status);
    displayStatus(wrap, row);

    list.appendChild(wrap);
  });
}

/** Paints a row's inline status line from its CURRENT (unmodified) status/message. */
function displayStatus(wrap: HTMLElement, row: VarRow): void {
  const status = wrap.querySelector<HTMLDivElement>(".var-status");
  if (!status) return;
  status.textContent = row.status === "running" ? "Computing…" : row.message ?? "";
  status.classList.toggle("error", row.status === "error");
  status.classList.toggle("done", row.status === "done");
}

/**
 * Re-validates a row after an input/select edit and repaints its status line.
 * A live edit ALWAYS clears a prior "done"/"error" — the mesh still carries
 * whatever the LAST Play produced until it runs again, so keeping the
 * "Computed." label would claim the box's current text is already on screen.
 */
function revalidateStatus(wrap: HTMLElement, row: VarRow): void {
  if (row.status !== "running") {
    const err = validateRow(row);
    row.status = err ? "error" : "idle";
    row.message = err;
  }
  displayStatus(wrap, row);
}
