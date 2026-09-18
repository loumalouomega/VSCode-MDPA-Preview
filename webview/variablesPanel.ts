/**
 * Variables panel: the sidebar's NAMED field registry. Every field on the
 * mesh — parsed from the file, computed by any sidebar op, mapped across a
 * remesh, or made by MCP — has a row here, so this panel and the Field
 * panel (which lists the same inventory) can never disagree about what
 * exists. Rows come in two shapes:
 *
 * - DEFINITION rows (user-added, or auto-created from a firing form whose
 *   inputs fully define the computation — fieldCalc/sdfDistance): name,
 *   kind, method, inputs, Play. Re-runnable, validated, tracked.
 * - TRACKING rows (file fields, remesh-carried leftovers, MCP/timeline
 *   fields, and outputs of ops with no Variables method — average, gradient,
 *   …): locked display of name + kind + origin, with show-on-mesh and
 *   delete. No Play — there is nothing to re-run.
 *
 * Definitions and the Field forms' builders speak through the same choke
 * point (`noteFieldFireFromMessage` in fieldRegistry.ts), so the options are
 * consistent by construction: formula rows carry the same `location`
 * (Nodal/Elemental/Conditional) the Field calculator offers, distance rows
 * the same `sign`/`band` the Signed-distance form offers.
 *
 * Attribution works because the host never reports "this op produced field
 * X": each fire records its origin + expected outputs, and `setVariablesModel`
 * (called by main.ts on every `model` / `vtkFrame`) diffs the inventory keys
 * against the previous set. Genuinely new keys become rows; the pending fire
 * labels them, or "mesh" when the model came from elsewhere (timeline step,
 * MCP) and "file" for the very first message. Deleting a row only removes
 * the row, never the field — a `dismissedKeys` set suppresses re-adding
 * until the key vanishes and reappears.
 *
 * "Compute, then display on mesh" still has no message of its own: a Play
 * button records the field key it EXPECTS, and the next model message marks
 * the row done and stashes a `${kind}:${variable}` key for main.ts to open
 * the Field panel on (one-shot `consumePendingFocus`, the same shape as the
 * host's `takeRestoredOps`/`takePendingOps`).
 */

import { validateSizeExpr } from "../src/parser/sizeExpr";
import { scopeVariables } from "../src/parser/fieldCalc";
import { FieldData } from "../src/parser/types";
import { TOOLBAR_ICONS } from "../src/toolbarIcons";
import { isQueueMode, stageOp } from "./opQueue";
import {
  FieldMethod,
  FieldKind,
  drainPendingFieldFire,
  noteFieldFireFromMessage,
  fieldInventoryKey,
} from "./fieldRegistry";

type PostMessage = (msg: unknown) => void;

interface VarRow {
  name: string;
  /** The field kind this row tracks/produces; doubles as the formula location. */
  kind: FieldKind;
  method: FieldMethod;
  expr: string;
  /** Distance rows: sign mode, mirroring the Signed-distance form's default. */
  sign: string;
  /** Distance rows: raw band input, "" = unset. */
  band: string;
  /** Full path for distanceFile (display shows only the base name). */
  path: string;
  part: string;
  status: "idle" | "running" | "done" | "error";
  message?: string;
  /** "user" for + Add rows; op label / "file" / "mesh" for auto rows. */
  origin: string;
  /** Locked tracking rows render display-only (no method inputs, no Play). */
  locked: boolean;
}

const METHOD_LABELS: Record<FieldMethod, string> = {
  formula: "Formula",
  distanceFile: "Distance to file",
  distancePart: "Distance to SubModelPart",
};

const ROW_METHODS: [FieldMethod, string][] = [
  ["formula", "Formula"],
  ["distanceFile", "Distance to file"],
  ["distancePart", "Distance to SubModelPart"],
];

const KIND_OPTIONS: FieldKind[] = ["Nodal", "Elemental", "Conditional"];
const SIGN_OPTIONS = ["pseudonormal", "winding", "none"];

let post: PostMessage = () => {};
let rows: VarRow[] = [];
let smpPaths: string[] = [];
/** Formula scope per kind (x,y,z plus that kind's field names). */
let formulaScopes: Record<FieldKind, string[]> = { Nodal: [], Elemental: [], Conditional: [] };
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
/** Inventory keys of the last model message (undefined before the first). */
let prevKeys: Set<string> | undefined;
/** Row keys the user deleted: not re-added until the key vanishes + reappears. */
let dismissedKeys = new Set<string>();

function rowKey(row: VarRow): string {
  return fieldInventoryKey(row.kind, row.name.trim());
}

function blankRow(): VarRow {
  return {
    name: "",
    kind: "Nodal",
    method: "formula",
    expr: "",
    sign: "pseudonormal",
    band: "",
    path: "",
    part: "",
    status: "idle",
    origin: "user",
    locked: false,
  };
}

function originDisplay(origin: string): string {
  if (origin === "file") return "From file";
  if (origin === "mesh") return "On the mesh";
  if (origin === "user") return "";
  return `From ${origin}`;
}

export function initVariablesPanel(postMessage: PostMessage): void {
  post = postMessage;
  document.getElementById("var-add")?.addEventListener("click", () => {
    rows.push(blankRow());
    render();
  });
  render();
}

function fire(msg: Record<string, unknown>, originOverride?: string): void {
  if (isQueueMode()) {
    stageOp(msg);
    return;
  }
  // Provenance for the auto-row upsert on the next model message. The
  // Variables panel names its own methods; the message shape is identical.
  noteFieldFireFromMessage(msg, originOverride);
  post(msg);
}

/** Every `${kind}:${variable}` key currently holding a row. */
export function variableRowKeys(): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    if (row.name.trim()) out.add(rowKey(row));
  }
  return out;
}

/** Trailing path segment, for the file-picked display (the webview has no path module). */
function baseName(p: string): string {
  const cut = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return cut >= 0 ? p.slice(cut + 1) : p;
}

/** DOM id for a row (reveal target); variable names come off user input. */
function rowDomId(kind: string, name: string): string {
  return `var-row-${kind}-${name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

/**
 * Scrolls the Variables section open and flashes the row for a field key.
 * Called from main.ts behind the Field panel's reveal action. Returns false
 * when no row claims the key.
 */
export function revealVariableRow(key: string): boolean {
  const index = rows.findIndex((r) => r.name.trim() && rowKey(r) === key);
  if (index < 0) return false;
  const section = document.querySelector('section[data-section="variables"]');
  if (section?.classList.contains("collapsed")) {
    section.classList.remove("collapsed");
    section.querySelector(".sb-section-header")?.setAttribute("aria-expanded", "true");
  }
  render();
  const el = document.getElementById(rowDomId(rows[index].kind, rows[index].name.trim()));
  if (!el) return false;
  el.scrollIntoView({ block: "nearest" });
  el.classList.remove("var-row-flash");
  // Reflow between remove/add so a repeated reveal replays the flash.
  void el.offsetWidth;
  el.classList.add("var-row-flash");
  return true;
}

/**
 * (Re)populates the formula scopes + SubModelPart lists from the current
 * model, reconciles each running/done row against the field list, and upserts
 * rows for genuinely new fields — called by main.ts on every `model` /
 * `vtkFrame` message, right where `setMeshModFields`/`setMeshModParts`
 * already are.
 */
export function setVariablesModel(
  fields: FieldData[],
  parts: { path: string; children: unknown[] }[]
): void {
  const byKind = (kind: FieldKind): FieldData[] => fields.filter((f) => f.kind === kind);
  formulaScopes = {
    Nodal: scopeVariables(byKind("Nodal"), true),
    Elemental: scopeVariables(byKind("Elemental"), true),
    Conditional: scopeVariables(byKind("Conditional"), true),
  };

  const paths: string[] = [];
  const walk = (p: { path: string; children: unknown[] }): void => {
    paths.push(p.path);
    (p.children as { path: string; children: unknown[] }[]).forEach(walk);
  };
  parts.forEach(walk);
  smpPaths = paths;

  const pending = drainPendingFieldFire();
  const current = new Set(fields.map((f) => fieldInventoryKey(f.kind, f.variable)));
  const firstMessage = prevKeys === undefined;
  // Keys the user deleted come back only after vanishing + reappearing: a
  // dismissed key still present is not new, and a vanished one leaves the set.
  for (const key of [...dismissedKeys]) {
    if (!current.has(key)) dismissedKeys.delete(key);
  }
  if (prevKeys !== undefined) {
    for (const f of fields) {
      const key = fieldInventoryKey(f.kind, f.variable);
      if (prevKeys.has(key) || dismissedKeys.has(key)) continue;
      // A row may already claim this key (user added it by hand, then
      // computed it from a Field form): reconcile, don't duplicate.
      if (rows.some((r) => r.name.trim() && rowKey(r) === key)) continue;
      addAutoRow(f, key, pending, firstMessage);
    }
  } else {
    // Very first message: everything came from the file.
    for (const f of fields) {
      const key = fieldInventoryKey(f.kind, f.variable);
      if (!dismissedKeys.has(key)) addAutoRow(f, key, undefined, true);
    }
  }
  prevKeys = current;

  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.locked) {
      // Tracking rows mirror the inventory: a vanished field takes its row
      // with it (definition rows instead drop to idle, since they hold user
      // intent worth keeping). A dismissed key stays dismissed only while
      // present — vanishing clears it, so a genuine reappearance re-adds.
      if (row.name.trim() && !current.has(rowKey(row))) rows.splice(i, 1);
      continue;
    }
    const key = row.name.trim() ? rowKey(row) : "";
    if (row.status === "running") {
      // A running row's expected output is matched by exact key — fieldCalc
      // stores `output` verbatim, and sdfDistance's own sanitizeVariable is
      // a no-op for any name that was already a valid identifier, which
      // every reasonable variable name is.
      const found = key && fields.find((f) => fieldInventoryKey(f.kind, f.variable) === key);
      if (found) {
        row.status = "done";
        row.message =
          found.components > 1 ? `Computed (${found.components} components).` : "Computed.";
        pendingFocusKey = key;
      }
    } else if (row.status === "done") {
      // The field this row produced is gone from the mesh — a timeline step
      // replayed with skipAsyncOps (sdfDistance is async) wiped it. (A remesh
      // now maps fields forward via remeshFields.ts instead of dropping
      // them, so it no longer wipes them.) A stale "Computed." would claim
      // the box's current text is already on screen while the Remesh formula
      // next door correctly reports the name as unknown, so drop back to
      // idle with the reason instead of keeping the label.
      if (key && !current.has(key)) {
        row.status = "idle";
        row.message = "No longer on the mesh — press Play to recompute.";
      }
    }
  }
  render();
}

/** Creates the auto row for a genuinely new inventory key. */
function addAutoRow(
  field: FieldData,
  key: string,
  pending: ReturnType<typeof drainPendingFieldFire>,
  firstMessage: boolean
): void {
  const origin = firstMessage ? "file" : pending?.origin ?? "mesh";
  const def = pending?.definition;
  const expected = pending && pending.expectedKeys.length > 0 ? pending.expectedKeys.includes(key) : true;
  if (!firstMessage && def && (pending?.expectedKeys.length === 0 || expected)) {
    // The firing form's inputs fully define this computation: a real
    // definition row, prefilled, already computed.
    const row = blankRow();
    row.name = field.variable;
    row.method = def.method;
    row.origin = origin;
    if (def.method === "formula") {
      // The location rides the already-built message, but only our own three
      // spellings are addressable as row kinds — anything else is Nodal.
      row.kind = KIND_OPTIONS.includes(def.location as FieldKind)
        ? (def.location as FieldKind)
        : "Nodal";
      row.expr = def.expr ?? "";
    } else {
      row.kind = "Nodal";
      row.path = def.path ?? "";
      row.part = def.part ?? "";
      row.sign = def.sign ?? "pseudonormal";
      row.band = def.band ?? "";
    }
    row.status = "done";
    row.message = "Computed.";
    rows.push(row);
    return;
  }
  // No reconstructible definition (file field, remesh-carried, MCP-made, or
  // an op with no Variables method): a locked tracking row. Never running,
  // never settled, never focused — it only mirrors the inventory.
  rows.push({
    ...blankRow(),
    name: field.variable,
    kind: field.kind as VarRow["kind"],
    origin,
    locked: true,
    status: "done",
    message: firstMessage || origin === "file" ? "From file" : origin === "mesh" ? "On the mesh" : `From ${origin}`,
  });
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
 * an op is still in flight. Tracking rows never run, so only definition
 * rows can land here.
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
    return validateSizeExpr(row.expr.trim(), formulaScopes[row.kind]);
  }
  if (row.method === "distanceFile") {
    return row.path ? undefined : "Choose a surface file.";
  }
  return row.part ? undefined : "Choose a SubModelPart.";
}

function methodLabel(row: VarRow): string {
  return METHOD_LABELS[row.method];
}

function buildOpMessage(row: VarRow): Record<string, unknown> {
  const output = row.name.trim();
  if (row.method === "formula") {
    return { type: "applyOp", op: "fieldCalc", location: row.kind, output, expr: row.expr.trim() };
  }
  // Same options as the Signed-distance form (meshMod.ts): sign always rides
  // (its default is pseudonormal), band only when positive.
  const msg: Record<string, unknown> = { type: "applyOp", op: "sdfDistance", output };
  if (row.method === "distanceFile") msg.path = row.path;
  else msg.part = row.part;
  if (row.sign) msg.sign = row.sign;
  const band = Number(row.band);
  if (row.band.trim() !== "" && Number.isFinite(band) && band > 0) msg.band = band;
  return msg;
}

function render(): void {
  const list = document.getElementById("var-list");
  const hint = document.getElementById("var-hint");
  if (!list) return;
  hint?.classList.toggle("hidden", rows.length > 0);
  list.textContent = "";

  rows.forEach((row, index) => {
    if (row.locked) {
      list.appendChild(renderTrackingRow(row, index));
      return;
    }
    list.appendChild(renderDefinitionRow(row, index));
  });
}

/** Locked display for fields with no reconstructible definition. */
function renderTrackingRow(row: VarRow, index: number): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "var-row var-row-tracking";
  wrap.id = rowDomId(row.kind, row.name.trim());

  const line = document.createElement("div");
  line.className = "edit-form-row";
  const name = document.createElement("span");
  name.className = "var-track-name";
  name.textContent = row.name;
  name.title = `${row.kind} field`;
  const kind = document.createElement("span");
  kind.className = "var-track-kind";
  kind.textContent = row.kind;
  const origin = document.createElement("span");
  origin.className = "var-status";
  origin.textContent = row.message ?? "";
  const show = document.createElement("button");
  show.type = "button";
  show.className = "var-row-show";
  show.title = "Show this field on the mesh";
  show.innerHTML = `<span class="toolbar-icon">${TOOLBAR_ICONS.play}</span>`;
  show.addEventListener("click", () => {
    // Same one-shot focus handoff a computed row uses; main.ts opens the
    // Field panel on it. Never marks anything running — this only displays.
    pendingFocusKey = rowKey(row);
  });
  const del = document.createElement("button");
  del.type = "button";
  del.className = "var-row-del";
  del.title = "Remove this variable (the field stays on the mesh)";
  del.innerHTML = `<span class="toolbar-icon">${TOOLBAR_ICONS.close}</span>`;
  del.addEventListener("click", () => {
    dismissedKeys.add(rowKey(rows[index]));
    rows.splice(index, 1);
    render();
  });
  line.append(name, kind, origin, show, del);
  wrap.appendChild(line);
  return wrap;
}

function renderDefinitionRow(row: VarRow, index: number): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "var-row";
  wrap.id = rowDomId(row.kind, row.name.trim() || `row${index}`);

  // Row 1: name + kind (formula) or method + delete.
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
    wrap.id = rowDomId(row.kind, row.name.trim() || `row${index}`);
    revalidateStatus(wrap, row);
  });
  const methodSelect = document.createElement("select");
  methodSelect.className = "edit-sel edit-sel-grow";
  for (const [value, label] of ROW_METHODS) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    if (value === row.method) opt.selected = true;
    methodSelect.appendChild(opt);
  }
  methodSelect.addEventListener("change", () => {
    row.method = methodSelect.value as VarRow["method"];
    render();
  });
  const del = document.createElement("button");
  del.type = "button";
  del.className = "var-row-del";
  del.title = "Remove this variable";
  del.innerHTML = `<span class="toolbar-icon">${TOOLBAR_ICONS.close}</span>`;
  del.addEventListener("click", () => {
    if (row.name.trim()) dismissedKeys.add(rowKey(row));
    rows.splice(index, 1);
    render();
  });
  line1.append(nameInput, methodSelect, del);
  wrap.appendChild(line1);

  // Row 2: method-specific source (+ location for formulas).
  const line2 = document.createElement("div");
  line2.className = "edit-form-row";
  if (row.method === "formula") {
    const locSelect = document.createElement("select");
    locSelect.className = "edit-sel edit-sel-mid";
    locSelect.title = "Where the new field lives — same locations the Field calculator offers";
    for (const k of KIND_OPTIONS) {
      const opt = document.createElement("option");
      opt.value = k;
      opt.textContent = k;
      if (k === row.kind) opt.selected = true;
      locSelect.appendChild(opt);
    }
    locSelect.addEventListener("change", () => {
      row.kind = locSelect.value as VarRow["kind"];
      wrap.id = rowDomId(row.kind, row.name.trim() || `row${index}`);
      revalidateStatus(wrap, row);
    });
    const exprInput = document.createElement("input");
    exprInput.type = "text";
    exprInput.className = "edit-expr-input";
    exprInput.spellcheck = false;
    exprInput.placeholder = "sqrt(VELOCITY_X^2+VELOCITY_Y^2)";
    exprInput.value = row.expr;
    exprInput.title = `Variables (${row.kind}): ${formulaScopes[row.kind].join(", ")}. Functions: min max clamp abs sqrt sin cos tan exp log pow floor ceil round; constants pi e.`;
    exprInput.addEventListener("input", () => {
      row.expr = exprInput.value;
      revalidateStatus(wrap, row);
    });
    const field = document.createElement("label");
    field.className = "edit-expr-field edit-field-grow";
    field.append(document.createElement("span"));
    field.appendChild(exprInput);
    line2.append(locSelect, field);
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

  // Row 2b (distance methods): sign + band, the same options the
  // Signed-distance form offers.
  if (row.method !== "formula") {
    const opts = document.createElement("div");
    opts.className = "edit-form-row";
    const signSelect = document.createElement("select");
    signSelect.className = "edit-sel edit-sel-mid";
    signSelect.title = "How inside/outside is decided (pseudonormal is the fast default)";
    for (const s of SIGN_OPTIONS) {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s;
      if (s === row.sign) opt.selected = true;
      signSelect.appendChild(opt);
    }
    signSelect.addEventListener("change", () => {
      row.sign = signSelect.value;
      revalidateStatus(wrap, row);
    });
    const bandInput = document.createElement("input");
    bandInput.type = "number";
    bandInput.className = "edit-num";
    bandInput.min = "0";
    bandInput.step = "any";
    bandInput.value = row.band;
    bandInput.placeholder = "band";
    bandInput.title = "Exact values only within this distance; 0/empty = no band";
    bandInput.addEventListener("input", () => {
      row.band = bandInput.value;
      revalidateStatus(wrap, row);
    });
    const signField = document.createElement("label");
    signField.className = "edit-field";
    signField.append("sign", signSelect);
    const bandField = document.createElement("label");
    bandField.className = "edit-field";
    bandField.append("band", bandInput);
    opts.append(signField, bandField);
    wrap.appendChild(opts);
  }

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
    fire(buildOpMessage(row), methodLabel(row));
  });
  line3.appendChild(play);
  wrap.appendChild(line3);

  const status = document.createElement("div");
  status.className = "var-status";
  line3.appendChild(status);
  displayStatus(wrap, row);

  return wrap;
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
