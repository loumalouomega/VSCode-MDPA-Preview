/**
 * Variables panel: the sidebar's NAMED field registry. Every field on the
 * mesh — parsed from the file, computed by any sidebar op, mapped across a
 * remesh, or made by MCP — has a row here, so this panel and the Field
 * panel (which lists the same inventory) can never disagree about what
 * exists. Global (scalar) variables live here too, under `global:` keys.
 * Rows come in three shapes:
 *
 * - DEFINITION rows (user-added, or auto-created from a firing form whose
 *   inputs fully define the computation — fieldCalc/sdfDistance/average/…):
 *   name, kind, method, inputs, Play. Re-runnable, validated, tracked.
 * - TRACKING rows (file fields, remesh-carried leftovers, MCP/timeline
 *   fields, and outputs of ops with no Variables method): locked display of
 *   name + kind + origin, with show-on-mesh and delete. No Play — there is
 *   nothing to re-run.
 * - TRANSFER rows: a nameless launcher (source + arrays + conflict). Play
 *   runs the op; whatever new fields arrive are attributed to it and the row
 *   reports the count. A transfer produces many fields, so no single name
 *   fits — the row is the definition, not a variable.
 *
 * The method dropdown offers every operation the Mesh Modification sidebar's
 * Fields subsection offers (calculator, average, gradient, Hessian, error
 * estimate, distance, transfer) plus globals — each with the same glyph as
 * its form (a native `<select>` cannot render icons inside its options, so
 * the row shows the method's icon beside the dropdown instead). Definitions
 * and the Field forms' builders speak through the same choke point
 * (`noteFieldFireFromMessage` in fieldRegistry.ts), so the options are
 * consistent by construction: formula rows carry the same `location`
 * (Nodal/Elemental/Conditional) the Field calculator offers, distance rows
 * the same `sign`/`band` the Signed-distance form offers, and so on for
 * every method.
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
 * host's `takeRestoredOps`/`takePendingOps`). Globals and transfers have no
 * single field to focus — globals show their live scalar value instead, and
 * a transfer focuses the first newly-arrived field.
 */

import { validateSizeExpr } from "../src/parser/sizeExpr";
import { scopeVariables } from "../src/parser/fieldCalc";
import {
  GLOBAL_REDUCTIONS,
  GlobalReduction,
  computeGlobal,
  defaultGlobalName,
} from "../src/parser/globalReduce";
import { FieldData } from "../src/parser/types";
import { TOOLBAR_ICONS } from "../src/toolbarIcons";
import { isQueueMode, stageOp } from "./opQueue";
import {
  FieldMethod,
  FieldKind,
  FieldDefinition,
  METHOD_ICONS,
  drainPendingFieldFire,
  noteFieldFire,
  noteFieldFireFromMessage,
  fieldInventoryKey,
} from "./fieldRegistry";

type PostMessage = (msg: unknown) => void;

interface VarRow {
  name: string;
  /** Formula location / global source kind (fixed-kind methods ignore it). */
  kind: FieldKind;
  method: FieldMethod;
  expr: string;
  /** Distance rows: sign mode, mirroring the Signed-distance form's default. */
  sign: string;
  /** Distance rows: raw band input, "" = unset. */
  band: string;
  /** Full path for file-picked surfaces/sources (display shows base name). */
  path: string;
  part: string;
  /** Source variable for average/gradient/hessian/error/global rows. */
  variable: string;
  /** Average rows: nodalToElemental / elementalToNodal. */
  direction: string;
  /** Average rows: Elements / Conditions target. */
  target: string;
  /** Gradient rows: gradient / divergence / curl. */
  operator: string;
  /** Gradient/Hessian rows: green-gauss / least-squares. */
  opMethod: string;
  /** Error rows: none / absolute / fraction / dorfler. */
  marking: string;
  /** Error rows: raw marking value, "" = unset. */
  markingValue: string;
  /** Transfer rows: comma-separated array list, "" = all. */
  arrays: string;
  /** Transfer rows: overwrite / suffix / error. */
  onConflict: string;
  /** Global rows: the reduction. */
  reduction: GlobalReduction;
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
  average: "Average field",
  gradient: "Field gradient",
  hessian: "Field Hessian",
  error: "Error estimate",
  transfer: "Transfer fields",
  global: "Global reduction",
};

const ROW_METHODS: [FieldMethod, string][] = [
  ["formula", "Formula"],
  ["distanceFile", "Distance to file"],
  ["distancePart", "Distance to SubModelPart"],
  ["average", "Average field"],
  ["gradient", "Field gradient"],
  ["hessian", "Field Hessian"],
  ["error", "Error estimate"],
  ["transfer", "Transfer fields"],
  ["global", "Global reduction"],
];

const KIND_OPTIONS: FieldKind[] = ["Nodal", "Elemental", "Conditional"];
const SIGN_OPTIONS = ["pseudonormal", "winding", "none"];
const TARGET_OPTIONS = ["Elements", "Conditions"];
const OPERATOR_OPTIONS = ["gradient", "divergence", "curl"];
const OPMETHOD_OPTIONS = ["green-gauss", "least-squares"];
const MARKING_OPTIONS = ["none", "absolute", "fraction", "dorfler"];
const CONFLICT_OPTIONS = ["overwrite", "suffix", "error"];

let post: PostMessage = () => {};
let rows: VarRow[] = [];
let smpPaths: string[] = [];
/** Formula scope per kind (x,y,z plus that kind's field names, plus globals). */
let formulaScopes: Record<FieldKind, string[]> = { Nodal: [], Elemental: [], Conditional: [] };
/** Field variable names per kind, for the row source pickers. */
let fieldNamesByKind: Record<FieldKind, string[]> = { Nodal: [], Elemental: [], Conditional: [] };
/** Scalar-only Nodal names, for the Hessian picker. */
let scalarNodalNames: string[] = [];
/** Latest fields, for live global-value display. */
let liveFields: FieldData[] = [];
/** Latest global specs, for inventory + live values. */
let liveGlobals: Record<string, { variable: string; kind: FieldKind; reduction: GlobalReduction }> = {};
/**
 * True while ANY sidebar operation is running host-side (driven by the host's
 * `opProgress` messages via `setVariablesProgress`, wired in main.ts next to
 * `setMeshModProgress`). Guards `settleVariableRows` so a row is never failed
 * while its own op is still in flight.
 */
let opRunning = false;
/** Which row (if any) is waiting on a `pickMeshFile` reply, and for what. */
let awaitingPickRow: { index: number; target: "variableDistance" | "variableTransfer" } | undefined;
/** The `${kind}:${variable}` key of a field a row just computed, for main.ts to focus once. */
let pendingFocusKey: string | undefined;
/** Inventory keys of the last model message (undefined before the first). */
let prevKeys: Set<string> | undefined;
/** Row keys the user deleted: not re-added until the key vanishes + reappears. */
let dismissedKeys = new Set<string>();
/** Index of the transfer row awaiting its result model (one op runs at a time). */
let transferAwaiting: number | undefined;

function isGlobalRow(row: VarRow): boolean {
  return row.method === "global";
}

function isTransferRow(row: VarRow): boolean {
  return row.method === "transfer";
}

/**
 * The field kind a row's OUTPUT lives in. Average derives it from direction
 * + target (mirroring fieldCalc.ts); gradient/Hessian/distance are Nodal,
 * error is Elemental (the indicator — ERROR_MARKED is tracked, not owned);
 * formula and global rows read `row.kind` (location / source kind).
 * Transfer rows have no key; the kind is unused for them.
 */
function outputKindOf(row: VarRow): FieldKind {
  switch (row.method) {
    case "average":
      return row.direction === "nodalToElemental"
        ? row.target === "Conditions"
          ? "Conditional"
          : "Elemental"
        : "Nodal";
    case "gradient":
    case "hessian":
    case "distanceFile":
    case "distancePart":
      return "Nodal";
    case "error":
      return "Elemental";
    case "formula":
    case "global":
    case "transfer":
      return row.kind;
  }
}

/** Inventory key a row tracks: `kind:variable` for fields, `global:name` for globals. */
function rowKey(row: VarRow): string {
  if (isGlobalRow(row)) return `global:${row.name.trim()}`;
  if (isTransferRow(row)) return "";
  return fieldInventoryKey(outputKindOf(row), row.name.trim());
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
    variable: "",
    direction: "nodalToElemental",
    target: "Elements",
    operator: "gradient",
    opMethod: "green-gauss",
    marking: "none",
    markingValue: "0.5",
    arrays: "",
    onConflict: "overwrite",
    reduction: "mean",
    status: "idle",
    origin: "user",
    locked: false,
  };
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

/** Every inventory key currently holding a row (`kind:variable` + `global:name`). */
export function variableRowKeys(): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    if (isTransferRow(row)) continue;
    if (row.name.trim()) out.add(rowKey(row));
  }
  return out;
}

/** Trailing path segment, for the file-picked display (the webview has no path module). */
function baseName(p: string): string {
  const cut = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return cut >= 0 ? p.slice(cut + 1) : p;
}

/** DOM id for a row (reveal target); names come off user input, hence sanitized. */
function rowDomId(row: VarRow, index: number): string {
  const tag = isGlobalRow(row) ? "global" : outputKindOf(row);
  const name = row.name.trim() || `row${index}`;
  return `var-row-${tag}-${name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

/**
 * Scrolls the Variables section open and flashes the row for an inventory
 * key. Called from main.ts behind the Field panel's reveal action. Returns
 * false when no row claims the key.
 */
export function revealVariableRow(key: string): boolean {
  const index = rows.findIndex((r) => {
    if (isTransferRow(r)) return false;
    return r.name.trim() && rowKey(r) === key;
  });
  if (index < 0) return false;
  const section = document.querySelector('section[data-section="variables"]');
  if (section?.classList.contains("collapsed")) {
    section.classList.remove("collapsed");
    section.querySelector(".sb-section-header")?.setAttribute("aria-expanded", "true");
  }
  render();
  const el = document.getElementById(rowDomId(rows[index], index));
  if (!el) return false;
  el.scrollIntoView({ block: "nearest" });
  el.classList.remove("var-row-flash");
  // Reflow between remove/add so a repeated reveal replays the flash.
  void el.offsetWidth;
  el.classList.add("var-row-flash");
  return true;
}

/** Live scalar value for a global row, recomputed from the latest fields. */
function globalRowValue(row: VarRow): number {
  // computeGlobal only reads `.fields`; the cast stands in a fields-only
  // carrier rather than a full model.
  const carrier = { fields: liveFields } as unknown as import("../src/parser/types").MdpaModel;
  return computeGlobal(carrier, { variable: row.variable, kind: row.kind, reduction: row.reduction });
}

function fmtGlobal(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e6 || a < 1e-4) return v.toExponential(3);
  return String(Math.round(v * 1e6) / 1e6);
}

/**
 * (Re)populates the formula scopes + picker lists from the current model,
 * reconciles each running/done row against the inventory, and upserts rows
 * for genuinely new keys — called by main.ts on every `model` / `vtkFrame`
 * message, right where `setMeshModFields`/`setMeshModParts` already are.
 */
export function setVariablesModel(
  fields: FieldData[],
  parts: { path: string; children: unknown[] }[],
  globals?: Record<string, { variable: string; kind: FieldKind; reduction: GlobalReduction }>
): void {
  liveFields = fields;
  liveGlobals = globals ?? {};
  const byKind = (kind: FieldKind): FieldData[] => fields.filter((f) => f.kind === kind);
  const globalNames = Object.keys(liveGlobals);
  formulaScopes = {
    Nodal: scopeVariables(byKind("Nodal"), true, globalNames),
    Elemental: scopeVariables(byKind("Elemental"), true, globalNames),
    Conditional: scopeVariables(byKind("Conditional"), true, globalNames),
  };
  fieldNamesByKind = {
    Nodal: byKind("Nodal").map((f) => f.variable),
    Elemental: byKind("Elemental").map((f) => f.variable),
    Conditional: byKind("Conditional").map((f) => f.variable),
  };
  scalarNodalNames = byKind("Nodal")
    .filter((f) => f.components === 1)
    .map((f) => f.variable);

  const paths: string[] = [];
  const walk = (p: { path: string; children: unknown[] }): void => {
    paths.push(p.path);
    (p.children as { path: string; children: unknown[] }[]).forEach(walk);
  };
  parts.forEach(walk);
  smpPaths = paths;

  const pending = drainPendingFieldFire();
  const current = new Set(fields.map((f) => fieldInventoryKey(f.kind, f.variable)));
  for (const name of globalNames) current.add(`global:${name}`);
  const firstMessage = prevKeys === undefined;
  // Keys the user deleted come back only after vanishing + reappearing: a
  // dismissed key still present is not new, and a vanished one leaves the set.
  for (const key of [...dismissedKeys]) {
    if (!current.has(key)) dismissedKeys.delete(key);
  }
  let newFieldKeys: string[] = [];
  if (prevKeys !== undefined) {
    for (const key of current) {
      if (prevKeys.has(key) || dismissedKeys.has(key)) continue;
      // A row may already claim this key (user added it by hand, then
      // computed it from a Field form): reconcile, don't duplicate.
      if ([...variableRowKeys()].includes(key)) continue;
      newFieldKeys.push(key);
      addAutoRow(key, pending, firstMessage);
    }
  } else {
    // Very first message: every field came from the file; globals already
    // present (a Load-problem recipe, MCP-made) are tracked, not "file".
    for (const f of fields) {
      const key = fieldInventoryKey(f.kind, f.variable);
      if (!dismissedKeys.has(key)) addAutoRow(key, undefined, true);
    }
    for (const name of globalNames) {
      const key = `global:${name}`;
      if (!dismissedKeys.has(key) && ![...variableRowKeys()].includes(key)) {
        addAutoRow(key, undefined, false);
      }
    }
  }
  prevKeys = current;

  // A transfer row awaits its result: attribute this message's new field keys
  // to it (guarded by the in-flight flag — a watcher tick landing mid-run
  // must not settle it early; the op's own completion posts the next model).
  if (transferAwaiting !== undefined && !opRunning) {
    const row = rows[transferAwaiting];
    transferAwaiting = undefined;
    if (row && isTransferRow(row) && row.status === "running") {
      row.status = "done";
      row.message =
        newFieldKeys.length > 0
          ? `Transferred ${newFieldKeys.length} new field(s).`
          : "Transfer finished.";
      if (newFieldKeys.length > 0) pendingFocusKey = newFieldKeys[0];
    }
  }

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
    if (isTransferRow(row)) continue; // settled above, failed via opState
    const key = row.name.trim() ? rowKey(row) : "";
    if (row.status === "running") {
      // A running row's expected output is matched by exact key — fieldCalc
      // stores `output` verbatim, sdfDistance's own sanitizeVariable is a
      // no-op for any name that was already a valid identifier, and
      // reduceField records the spec under the exact output name — which
      // every reasonable variable name already is.
      const found =
        key &&
        (key.startsWith("global:")
          ? current.has(key)
          : fields.find((f) => fieldInventoryKey(f.kind, f.variable) === key));
      if (found) {
        row.status = "done";
        if (isGlobalRow(row)) {
          row.message = "Computed.";
        } else {
          const components = (found as FieldData).components;
          row.message = components > 1 ? `Computed (${components} components).` : "Computed.";
          pendingFocusKey = key;
        }
      }
    } else if (row.status === "done") {
      // The output this row produced is gone from the mesh — a timeline step
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
  key: string,
  pending: ReturnType<typeof drainPendingFieldFire>,
  firstMessage: boolean
): void {
  const origin = firstMessage ? "file" : pending?.origin ?? "mesh";
  const def = pending?.definition;
  const expected = pending && pending.expectedKeys.length > 0 ? pending.expectedKeys.includes(key) : true;
  if (key.startsWith("global:")) {
    const name = key.slice("global:".length);
    if (!firstMessage && def?.method === "global") {
      const row = blankRow();
      row.name = name;
      row.method = "global";
      row.kind = (def.kind as FieldKind) || "Nodal";
      row.variable = def.variable ?? "";
      row.reduction = (def.reduction as GlobalReduction) || "mean";
      row.origin = origin;
      row.status = "done";
      row.message = "Computed.";
      rows.push(row);
      return;
    }
    rows.push({
      ...blankRow(),
      name,
      method: "global",
      kind: (liveGlobals[name]?.kind as FieldKind) || "Nodal",
      variable: liveGlobals[name]?.variable ?? "",
      reduction: (liveGlobals[name]?.reduction as GlobalReduction) || "mean",
      origin,
      locked: true,
      status: "done",
      message: origin === "file" ? "From file" : origin === "mesh" ? "On the mesh" : `From ${origin}`,
    });
    return;
  }
  if (!firstMessage && def && (pending?.expectedKeys.length === 0 || expected)) {
    // The firing form's inputs fully define this computation: a real
    // definition row, prefilled, already computed. Transfer definitions have
    // no single output — the transfer ROW (nameless launcher) already exists
    // and settles itself; its arrivals fall through to tracking rows below.
    if (def.method !== "transfer") {
      const built = buildDefinitionRow(def, key, origin);
      if (built) {
        rows.push(built);
        return;
      }
    }
  }
  // No reconstructible definition (file field, remesh-carried, MCP-made, an
  // op with no Variables method, or a transfer arrival): a locked tracking
  // row. Never running, never settled, never focused — it only mirrors the
  // inventory.
  const [kind, ...rest] = key.split(":");
  rows.push({
    ...blankRow(),
    name: rest.join(":"),
    kind: (kind as FieldKind) || "Nodal",
    origin,
    locked: true,
    status: "done",
    message: firstMessage || origin === "file" ? "From file" : origin === "mesh" ? "On the mesh" : `From ${origin}`,
  });
}

/** Builds a prefilled definition row from a firing form's inputs. */
function buildDefinitionRow(def: FieldDefinition, key: string, origin: string): VarRow | undefined {
  const row = blankRow();
  row.origin = origin;
  row.status = "done";
  row.message = "Computed.";
  const fieldName = key.split(":").slice(1).join(":");
  switch (def.method) {
    case "formula":
      row.method = "formula";
      row.name = fieldName;
      // The location rides the already-built message, but only our own three
      // spellings are addressable as row kinds — anything else is Nodal.
      row.kind = KIND_OPTIONS.includes(def.location as FieldKind)
        ? (def.location as FieldKind)
        : "Nodal";
      row.expr = def.expr ?? "";
      return row;
    case "distanceFile":
    case "distancePart":
      row.method = def.method;
      row.name = fieldName;
      row.kind = "Nodal";
      row.path = def.path ?? "";
      row.part = def.part ?? "";
      row.sign = def.sign ?? "pseudonormal";
      row.band = def.band ?? "";
      return row;
    case "average":
    case "gradient":
    case "hessian":
    case "error":
      row.method = def.method;
      row.name = fieldName;
      row.kind = key.startsWith("Conditional:")
        ? "Conditional"
        : key.startsWith("Elemental:")
          ? "Elemental"
          : "Nodal";
      row.variable = def.variable ?? "";
      row.direction = def.direction ?? "nodalToElemental";
      row.target = def.target ?? "Elements";
      row.operator = def.operator ?? "gradient";
      row.opMethod = def.opMethod ?? "green-gauss";
      row.marking = def.marking ?? "none";
      row.markingValue = def.markingValue ?? "";
      return row;
    default:
      return undefined;
  }
}

/** One-shot: the field key a just-finished row produced, or undefined. Consumed by main.ts. */
export function consumePendingFocus(): string | undefined {
  const key = pendingFocusKey;
  pendingFocusKey = undefined;
  return key;
}

/**
 * Reflects the host's `opProgress` running flag (wired in main.ts next to
 * `setMeshModProgress`). Async ops (sdfDistance, transfer, gradient, …)
 * bracket their run with running:true/false; sync ops (fieldCalc, average,
 * reduceField) send none and settle via `opState`.
 */
export function setVariablesProgress(running: boolean): void {
  opRunning = running;
  if (!running) settleVariableRows();
}

/**
 * Fails every row still marked running once its op has finished without
 * producing the expected output — a noop (e.g. sdfDistance over an empty
 * surface, or a part that no longer exists) posts no model, so without this
 * the row reads "Computing…" forever and only a host toast says why. Called
 * from main.ts on every `opState` (which the host now posts even for noops —
 * see opApply.ts) and from `setVariablesProgress(false)`. Never fires while
 * an op is still in flight. Tracking rows never run, so only definition
 * rows can land here. Transfer rows report their own shape (nameless).
 */
export function settleVariableRows(): void {
  if (opRunning) return;
  let changed = false;
  for (const row of rows) {
    if (row.status !== "running") continue;
    row.status = "error";
    if (isTransferRow(row)) {
      row.message = "The transfer produced no field — see the notification.";
    } else {
      row.message = row.name.trim()
        ? `Did not produce "${isGlobalRow(row) ? "global:" : ""}${row.name.trim()}" — see the notification.`
        : "The operation produced no field — see the notification.";
    }
    changed = true;
  }
  if (changed) render();
}

/** Reply to a row's `pickMeshFile` request (distanceFile or transfer source). */
function setPickedPath(paths: string[], target: "variableDistance" | "variableTransfer"): void {
  const clean = paths.filter((p) => typeof p === "string" && p.length > 0);
  if (awaitingPickRow === undefined || awaitingPickRow.target !== target) return;
  const row = rows[awaitingPickRow.index];
  awaitingPickRow = undefined;
  if (!row || !clean[0]) {
    render();
    return;
  }
  // Distance and transfer rows each hold a single picked path; a distance
  // pick additionally clears the mutually-exclusive SubModelPart.
  row.path = clean[0];
  if (target === "variableDistance" && !isTransferRow(row)) row.part = "";
  render();
}

/** Reply to a distance row's `pickMeshFile{target:"variableDistance"}` request. */
export function setVariableDistancePath(paths: string[]): void {
  setPickedPath(paths, "variableDistance");
}

/** Reply to a transfer row's `pickMeshFile{target:"variableTransfer"}` request. */
export function setVariableTransferPath(paths: string[]): void {
  setPickedPath(paths, "variableTransfer");
}

/**
 * The Boundary-layer remesh preset's dependencies: a Nodal distance field
 * `d` plus four globals of the mesh-size field. Picking the preset calls
 * this: whatever is missing is ADDED to the panel, and whatever can run
 * without further input is COMPUTED immediately.
 *
 * `d` is the deliberate exception — a distance needs a user-chosen surface,
 * so its row is added idle (distance-to-part, for the user to complete) and
 * never auto-fired. The globals (and the `NODAL_H` field sourcing them, via
 * one `writeMeshSizeFields` step when absent) fire as a single `applyBatch`:
 * `applyMany` runs sequentially on the evolving model, so the write commits
 * before the reductions read it — one round trip, one progress bracket, one
 * pending provenance slot. A batch that applies nothing reports through the
 * normal noop path, and the rows settle to error naming the missing output.
 * In queue mode nothing fires (rows are added idle for manual Play instead).
 */
const BOUNDARY_DISTANCE = "d";
const BOUNDARY_SIZE_SOURCE = "NODAL_H";
const BOUNDARY_GLOBALS: { name: string; reduction: GlobalReduction }[] = [
  { name: "mean_h", reduction: "mean" },
  { name: "maxabs_h", reduction: "maxAbs" },
  { name: "min_h", reduction: "min" },
  { name: "max_h", reduction: "max" },
];

export function ensureBoundaryLayerVariables(): void {
  const claimed = variableRowKeys();
  let changed = false;
  // d — idle row only; its surface is the user's call.
  if (!claimed.has(`Nodal:${BOUNDARY_DISTANCE}`)) {
    const row = blankRow();
    row.name = BOUNDARY_DISTANCE;
    row.method = "distancePart";
    row.kind = "Nodal";
    row.origin = "user";
    row.status = "idle";
    rows.push(row);
    changed = true;
  }
  // Globals — definition rows, then fired as one batch.
  const created: VarRow[] = [];
  for (const g of BOUNDARY_GLOBALS) {
    const key = `global:${g.name}`;
    if (claimed.has(key)) continue;
    dismissedKeys.delete(key);
    const row = blankRow();
    row.name = g.name;
    row.method = "global";
    row.kind = "Nodal";
    row.variable = BOUNDARY_SIZE_SOURCE;
    row.reduction = g.reduction;
    row.origin = "user";
    row.status = "idle";
    rows.push(row);
    created.push(row);
    changed = true;
  }
  if (created.length === 0) {
    if (changed) render();
    return;
  }
  if (isQueueMode()) {
    if (changed) render();
    return;
  }
  const ops: Record<string, unknown>[] = [];
  if (!fieldNamesByKind.Nodal.includes(BOUNDARY_SIZE_SOURCE)) {
    ops.push({ op: "writeMeshSizeFields", target: "both" });
  }
  for (const row of created) {
    ops.push({
      op: "reduceField",
      variable: row.variable,
      kind: row.kind,
      reduction: row.reduction,
      output: row.name,
    });
  }
  for (const row of created) {
    row.status = "running";
    row.message = undefined;
  }
  render();
  // Provenance for the upsert: the write step's own fields (NODAL_H and
  // friends) arrive unattributed by key, so the diff labels them with this.
  noteFieldFire({
    origin: "Global reduction",
    expectedKeys: created.map((r) => `global:${r.name}`),
  });
  post({ type: "applyBatch", ops });
}

/**
 * Host default output for a blank row name, mirroring each op's own default
 * (the forms show it as an "auto" placeholder): gradient
 * `<VARIABLE>_<OPERATOR>` (gradientField.ts), Hessian `<VARIABLE>_HESSIAN`
 * (hessianField.ts), error `ERROR_INDICATOR` (errorEstimate.ts), average and
 * global after their source (`fieldCalc.ts`, `operations.ts`). Formula and
 * distance rows have no default to adopt — the name stays required there.
 */
function defaultOutputFor(row: VarRow): string | undefined {
  switch (row.method) {
    case "gradient":
      return row.variable.trim() ? `${row.variable.trim()}_${row.operator.toUpperCase()}` : undefined;
    case "hessian":
      return row.variable.trim() ? `${row.variable.trim()}_HESSIAN` : undefined;
    case "error":
      return "ERROR_INDICATOR";
    case "average":
      return row.variable.trim() || undefined;
    case "global":
      return row.variable.trim() ? defaultGlobalName(row.variable.trim(), row.reduction) : undefined;
    default:
      return undefined;
  }
}

/** Placeholder for the name input: the adopted default, or the fixed prompt. */
function namePlaceholder(row: VarRow): string {
  if (row.method === "formula" || row.method === "distanceFile" || row.method === "distancePart") {
    return "d";
  }
  if (row.method === "error") return "auto (ERROR_INDICATOR)";
  if (row.method === "global" && row.variable.trim()) {
    return `auto (${defaultGlobalName(row.variable.trim(), row.reduction)})`;
  }
  if ((row.method === "gradient" || row.method === "hessian" || row.method === "average") && row.variable.trim()) {
    return `auto (${defaultOutputFor(row) ?? ""})`;
  }
  return "auto";
}

function validateRow(row: VarRow): string | undefined {
  if (isTransferRow(row)) return row.path ? undefined : "Choose a source mesh.";
  // Formula and distance rows have no host default to adopt, so the name
  // stays required there; every other method adopts its default on Play.
  const needsName =
    row.method === "formula" || row.method === "distanceFile" || row.method === "distancePart";
  if (needsName && !row.name.trim()) return "Name the variable.";
  switch (row.method) {
    case "formula": {
      if (!row.expr.trim()) return "Enter a formula.";
      return validateSizeExpr(row.expr.trim(), formulaScopes[outputKindOf(row)]);
    }
    case "distanceFile":
      return row.path ? undefined : "Choose a surface file.";
    case "distancePart":
      return row.part ? undefined : "Choose a SubModelPart.";
    case "average":
      return row.variable.trim() ? undefined : "Enter the source field.";
    case "gradient":
    case "hessian":
    case "error":
    case "global":
      return row.variable.trim() ? undefined : "Pick a source field.";
    case "transfer":
      return row.path ? undefined : "Choose a source mesh.";
  }
}

function methodLabel(row: VarRow): string {
  return METHOD_LABELS[row.method];
}

function buildOpMessage(row: VarRow): Record<string, unknown> {
  // A blank name adopts the host default (the forms show it as "auto"), so
  // the row tracks the exact key the host will produce.
  if (!row.name.trim()) {
    const adopted = defaultOutputFor(row);
    if (adopted) row.name = adopted;
  }
  const output = row.name.trim();
  switch (row.method) {
    case "formula":
      return { type: "applyOp", op: "fieldCalc", location: outputKindOf(row), output, expr: row.expr.trim() };
    case "distanceFile":
    case "distancePart": {
      // Same options as the Signed-distance form (meshMod.ts): sign always
      // rides (its default is pseudonormal), band only when positive.
      const msg: Record<string, unknown> = { type: "applyOp", op: "sdfDistance", output };
      if (row.method === "distanceFile") msg.path = row.path;
      else msg.part = row.part;
      if (row.sign) msg.sign = row.sign;
      const band = Number(row.band);
      if (row.band.trim() !== "" && Number.isFinite(band) && band > 0) msg.band = band;
      return msg;
    }
    case "average": {
      const msg: Record<string, unknown> = {
        type: "applyOp",
        op: "averageField",
        variable: row.variable.trim(),
        direction: row.direction,
      };
      if (row.target) msg.target = row.target;
      // The host names the output after the variable when blank; the row
      // always sends its (possibly adopted) name so tracking is exact.
      msg.output = output;
      return msg;
    }
    case "gradient": {
      const msg: Record<string, unknown> = {
        type: "applyOp",
        op: "fieldGradient",
        variable: row.variable.trim(),
      };
      if (row.operator) msg.operator = row.operator;
      if (row.opMethod) msg.method = row.opMethod;
      msg.output = output;
      return msg;
    }
    case "hessian": {
      const msg: Record<string, unknown> = {
        type: "applyOp",
        op: "fieldHessian",
        variable: row.variable.trim(),
      };
      if (row.opMethod) msg.method = row.opMethod;
      msg.output = output;
      return msg;
    }
    case "error": {
      const msg: Record<string, unknown> = {
        type: "applyOp",
        op: "estimateError",
        variable: row.variable.trim(),
      };
      if (row.marking) msg.marking = row.marking;
      // The marking value only means something for a policy that reads one —
      // the same rule the form follows (meshMod.ts).
      if (row.marking && row.marking !== "none") {
        const v = Number(row.markingValue);
        if (Number.isFinite(v)) msg.markingValue = v;
      }
      msg.output = output;
      return msg;
    }
    case "transfer": {
      const msg: Record<string, unknown> = { type: "applyOp", op: "transferField", path: row.path };
      if (row.arrays.trim()) msg.arrays = row.arrays.trim();
      if (row.onConflict) msg.onConflict = row.onConflict;
      return msg;
    }
    case "global":
      return {
        type: "applyOp",
        op: "reduceField",
        variable: row.variable.trim(),
        kind: row.kind,
        reduction: row.reduction,
        output,
      };
  }
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
  wrap.id = rowDomId(row, index);

  const line = document.createElement("div");
  line.className = "edit-form-row";
  const name = document.createElement("span");
  name.className = "var-track-name";
  name.textContent = row.name;
  name.title = isGlobalRow(row) ? "Global variable" : `${outputKindOf(row)} field`;
  const kind = document.createElement("span");
  kind.className = "var-track-kind";
  kind.textContent = isGlobalRow(row) ? "global" : outputKindOf(row);
  const origin = document.createElement("span");
  origin.className = "var-status";
  // Globals show their live scalar value where a field row shows nothing —
  // there is no geometry to display, only the number.
  origin.textContent = isGlobalRow(row)
    ? `= ${fmtGlobal(globalRowValue(row))}`
    : (row.message ?? "");
  origin.title = row.message ?? "";
  if (!isGlobalRow(row)) {
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
    line.append(name, kind, origin, show);
  } else {
    line.append(name, kind, origin);
  }
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
  line.appendChild(del);
  wrap.appendChild(line);
  return wrap;
}

/** Small labeled wrapper, matching the Field forms' label style. */
function labeled(label: string, control: HTMLElement, title = ""): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "edit-field";
  if (title) wrap.title = title;
  const span = document.createElement("span");
  span.textContent = label;
  wrap.append(span, control);
  return wrap;
}

function textInput(
  value: string,
  placeholder: string,
  title: string,
  className: string,
  onInput: (v: string) => void
): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.className = className;
  input.spellcheck = false;
  input.placeholder = placeholder;
  input.value = value;
  if (title) input.title = title;
  input.addEventListener("input", () => onInput(input.value));
  return input;
}

function selectInput(
  options: readonly string[],
  value: string,
  title: string,
  className: string,
  onChange: (v: string) => void
): HTMLSelectElement {
  const select = document.createElement("select");
  select.className = className;
  if (title) select.title = title;
  const list = options.includes(value) || !value ? [...options] : [value, ...options];
  for (const o of list) {
    const opt = document.createElement("option");
    opt.value = o;
    opt.textContent = o;
    select.appendChild(opt);
  }
  // Keep a stale value visible (flagged by title) when the model no longer
  // offers it — the same pattern meshMod.ts uses for its part selects.
  select.value = value;
  if (select.value !== value && value) select.title = `${title} (not on the mesh: ${value})`;
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

/** A field/variable select with an explicit empty ("—") option. */
function fieldSelect(
  names: readonly string[],
  value: string,
  title: string,
  emptyLabel: string,
  onChange: (v: string) => void
): HTMLSelectElement {
  const select = document.createElement("select");
  select.className = "edit-sel edit-sel-grow";
  if (title) select.title = title;
  const none = document.createElement("option");
  none.value = "";
  none.textContent = emptyLabel;
  select.appendChild(none);
  const list = names.includes(value) || !value ? [...names] : [value, ...names];
  for (const n of list) {
    const opt = document.createElement("option");
    opt.value = n;
    opt.textContent = n;
    select.appendChild(opt);
  }
  select.value = value;
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

function renderDefinitionRow(row: VarRow, index: number): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "var-row";
  wrap.id = rowDomId(row, index);
  const refresh = (): void => {
    wrap.id = rowDomId(row, index);
    revalidateStatus(wrap, row);
  };

  // Row 1: name + method icon + method + delete. Transfer rows are nameless
  // (they produce many fields), so the name input is replaced by a label.
  const line1 = document.createElement("div");
  line1.className = "edit-form-row";
  if (!isTransferRow(row)) {
    const nameInput = textInput(
      row.name,
      namePlaceholder(row),
      "Variable / field name (blank = host default, shown as auto)",
      "edit-text",
      (v) => {
        row.name = v;
        refresh();
      }
    );
    line1.appendChild(nameInput);
  } else {
    const label = document.createElement("span");
    label.className = "var-track-name";
    label.textContent = "Transfer fields";
    line1.appendChild(label);
  }
  const icon = document.createElement("span");
  icon.className = "toolbar-icon";
  icon.title = METHOD_LABELS[row.method];
  icon.innerHTML = TOOLBAR_ICONS[METHOD_ICONS[row.method]];
  line1.appendChild(icon);
  const methodSelect = document.createElement("select");
  methodSelect.className = "edit-sel edit-sel-grow";
  methodSelect.title = "How this variable is computed — every Fields operation";
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
  line1.appendChild(methodSelect);
  const del = document.createElement("button");
  del.type = "button";
  del.className = "var-row-del";
  del.title = "Remove this variable";
  del.innerHTML = `<span class="toolbar-icon">${TOOLBAR_ICONS.close}</span>`;
  del.addEventListener("click", () => {
    if (row.name.trim() && !isTransferRow(row)) dismissedKeys.add(rowKey(row));
    rows.splice(index, 1);
    render();
  });
  line1.appendChild(del);
  wrap.appendChild(line1);

  // Row 2: method-specific source.
  const line2 = document.createElement("div");
  line2.className = "edit-form-row";
  switch (row.method) {
    case "formula": {
      const locSelect = selectInput(
        KIND_OPTIONS,
        row.kind,
        "Where the new field lives — same locations the Field calculator offers",
        "edit-sel edit-sel-mid",
        (v) => {
          row.kind = v as VarRow["kind"];
          refresh();
        }
      );
      const exprInput = textInput(
        row.expr,
        "sqrt(VELOCITY_X^2+VELOCITY_Y^2)",
        `Variables (${outputKindOf(row)}): ${(formulaScopes[outputKindOf(row)] ?? []).join(", ")}. Functions: min max clamp abs sqrt sin cos tan exp log pow floor ceil round; constants pi e.`,
        "edit-expr-input",
        (v) => {
          row.expr = v;
          revalidateStatus(wrap, row);
        }
      );
      const field = document.createElement("label");
      field.className = "edit-expr-field edit-field-grow";
      field.append(document.createElement("span"));
      field.appendChild(exprInput);
      line2.append(locSelect, field);
      break;
    }
    case "distanceFile": {
      const pathInput = textInput(row.path ? baseName(row.path) : "", "Choose a surface mesh…", row.path, "edit-text edit-field-grow", () => {});
      pathInput.readOnly = true;
      const browse = document.createElement("button");
      browse.type = "button";
      browse.title = "Choose the surface mesh to measure distance to";
      browse.innerHTML = `<span class="toolbar-icon">${TOOLBAR_ICONS.open}</span>`;
      browse.addEventListener("click", () => {
        awaitingPickRow = { index, target: "variableDistance" };
        post({ type: "pickMeshFile", target: "variableDistance" });
      });
      const field = document.createElement("label");
      field.className = "edit-field edit-field-grow";
      field.appendChild(pathInput);
      line2.append(field, browse);
      break;
    }
    case "distancePart": {
      const partSelect = fieldSelect(
        smpPaths,
        row.part,
        "SubModelPart to measure distance to",
        smpPaths.length === 0 ? "no SubModelParts" : "— choose —",
        (v) => {
          row.part = v;
          revalidateStatus(wrap, row);
        }
      );
      if (smpPaths.length === 0) partSelect.disabled = true;
      const field = document.createElement("label");
      field.className = "edit-field edit-field-grow";
      field.appendChild(partSelect);
      line2.appendChild(field);
      break;
    }
    case "average": {
      const varInput = textInput(
        row.variable,
        "TEMPERATURE",
        "Source field to average (free text, like the form)",
        "edit-text edit-field-grow",
        (v) => {
          row.variable = v;
          refresh();
        }
      );
      line2.appendChild(varInput);
      break;
    }
    case "gradient":
    case "hessian":
    case "error": {
      const names = row.method === "hessian" ? scalarNodalNames : fieldNamesByKind.Nodal;
      const varSelect = fieldSelect(
        names,
        row.variable,
        row.method === "hessian" ? "Scalar nodal field" : "Nodal field",
        names.length === 0 ? "no nodal fields" : "— choose —",
        (v) => {
          row.variable = v;
          refresh();
        }
      );
      if (names.length === 0) varSelect.disabled = true;
      const field = document.createElement("label");
      field.className = "edit-field edit-field-grow";
      field.appendChild(varSelect);
      line2.appendChild(field);
      break;
    }
    case "transfer": {
      const pathInput = textInput(row.path ? baseName(row.path) : "", "Choose the source mesh…", row.path, "edit-text edit-field-grow", () => {});
      pathInput.readOnly = true;
      const browse = document.createElement("button");
      browse.type = "button";
      browse.title = "Choose the mesh whose fields are transferred onto this one";
      browse.innerHTML = `<span class="toolbar-icon">${TOOLBAR_ICONS.open}</span>`;
      browse.addEventListener("click", () => {
        awaitingPickRow = { index, target: "variableTransfer" };
        post({ type: "pickMeshFile", target: "variableTransfer" });
      });
      const field = document.createElement("label");
      field.className = "edit-field edit-field-grow";
      field.appendChild(pathInput);
      line2.append(field, browse);
      break;
    }
    case "global": {
      const kindSelect = selectInput(
        KIND_OPTIONS,
        row.kind,
        "Source field location",
        "edit-sel edit-sel-mid",
        (v) => {
          row.kind = v as VarRow["kind"];
          row.variable = "";
          refresh();
          render();
        }
      );
      const varSelect = fieldSelect(
        fieldNamesByKind[row.kind] ?? [],
        row.variable,
        "Source field to reduce",
        (fieldNamesByKind[row.kind] ?? []).length === 0 ? "no fields" : "— choose —",
        (v) => {
          row.variable = v;
          refresh();
        }
      );
      if ((fieldNamesByKind[row.kind] ?? []).length === 0) varSelect.disabled = true;
      const redSelect = selectInput(
        GLOBAL_REDUCTIONS,
        row.reduction,
        "Reduction: min / max / mean / std / median / sum / count / quartiles",
        "edit-sel edit-sel-mid",
        (v) => {
          row.reduction = v as GlobalReduction;
          refresh();
        }
      );
      line2.append(
        labeled("of", kindSelect),
        varSelect,
        labeled("as", redSelect)
      );
      break;
    }
  }
  wrap.appendChild(line2);

  // Row 2b: per-method options (same controls as the Field forms).
  const opts = document.createElement("div");
  opts.className = "edit-form-row";
  let hasOpts = true;
  const numInput = (
    value: string,
    placeholder: string,
    title: string,
    onInput: (v: string) => void
  ): HTMLInputElement => {
    const input = document.createElement("input");
    input.type = "number";
    input.className = "edit-num";
    input.step = "any";
    input.value = value;
    input.placeholder = placeholder;
    if (title) input.title = title;
    input.addEventListener("input", () => onInput(input.value));
    return input;
  };
  switch (row.method) {
    case "distanceFile":
    case "distancePart": {
      const signSelect = selectInput(
        SIGN_OPTIONS,
        row.sign,
        "How inside/outside is decided (pseudonormal is the fast default)",
        "edit-sel edit-sel-mid",
        (v) => {
          row.sign = v;
          revalidateStatus(wrap, row);
        }
      );
      const bandInput = numInput(row.band, "band", "Exact values only within this distance; 0/empty = no band", (v) => {
        row.band = v;
        revalidateStatus(wrap, row);
      });
      bandInput.min = "0";
      bandInput.step = "0.1";
      opts.append(
        labeled("sign", signSelect),
        labeled("band", bandInput)
      );
      break;
    }
    case "average": {
      // Human labels ("nodal → elemental") rather than the raw enum values —
      // the form's own option text, so the two cannot disagree.
      const dirSelect = document.createElement("select");
      dirSelect.className = "edit-sel edit-sel-grow";
      dirSelect.title = "Averaging direction";
      for (const [v, label] of [
        ["nodalToElemental", "nodal → elemental"],
        ["elementalToNodal", "elemental → nodal"],
      ] as const) {
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = label;
        dirSelect.appendChild(opt);
      }
      dirSelect.value = row.direction;
      dirSelect.addEventListener("change", () => {
        row.direction = dirSelect.value;
        refresh();
      });
      const targetSelect = selectInput(
        TARGET_OPTIONS,
        row.target,
        "Cell kind (nodal → elemental only)",
        "edit-sel edit-sel-mid",
        (v) => {
          row.target = v;
          refresh();
        }
      );
      targetSelect.disabled = row.direction !== "nodalToElemental";
      opts.append(labeled("direction", dirSelect), labeled("on", targetSelect));
      break;
    }
    case "gradient": {
      const opSelect = selectInput(
        OPERATOR_OPTIONS,
        row.operator,
        "Derivative operator",
        "edit-sel edit-sel-mid",
        (v) => {
          row.operator = v;
          refresh();
        }
      );
      const methodSelect = selectInput(
        OPMETHOD_OPTIONS,
        row.opMethod,
        "Green-Gauss is exact for a linear field; least-squares is smoother on irregular meshes",
        "edit-sel edit-sel-grow",
        (v) => {
          row.opMethod = v;
          revalidateStatus(wrap, row);
        }
      );
      opts.append(
        labeled("operator", opSelect),
        labeled("method", methodSelect)
      );
      break;
    }
    case "hessian": {
      const methodSelect = selectInput(
        OPMETHOD_OPTIONS,
        row.opMethod,
        "Forwarded to BOTH internal gradient passes",
        "edit-sel edit-sel-grow",
        (v) => {
          row.opMethod = v;
          revalidateStatus(wrap, row);
        }
      );
      opts.append(labeled("method", methodSelect));
      break;
    }
    case "error": {
      const markingSelect = selectInput(
        MARKING_OPTIONS,
        row.marking,
        "How to turn the indicator into a 0/1 refine-me flag",
        "edit-sel edit-sel-mid",
        (v) => {
          row.marking = v;
          revalidateStatus(wrap, row);
        }
      );
      opts.append(labeled("marking", markingSelect));
      if (row.marking !== "none") {
        const valueInput = numInput(row.markingValue, "value", "Threshold for absolute; fraction in (0, 1] for fraction/dorfler", (v) => {
          row.markingValue = v;
          revalidateStatus(wrap, row);
        });
        opts.append(labeled("value", valueInput));
      }
      break;
    }
    case "transfer": {
      const arraysInput = textInput(
        row.arrays,
        "all",
        "Comma-separated. Leave empty to transfer every field the source carries.",
        "edit-text edit-field-grow",
        (v) => {
          row.arrays = v;
          revalidateStatus(wrap, row);
        }
      );
      const conflictSelect = selectInput(
        CONFLICT_OPTIONS,
        row.onConflict,
        "What happens to a name that already exists here",
        "edit-sel edit-sel-mid",
        (v) => {
          row.onConflict = v;
          revalidateStatus(wrap, row);
        }
      );
      opts.append(
        labeled("fields", arraysInput),
        labeled("on clash", conflictSelect)
      );
      break;
    }
    default:
      hasOpts = false;
      break;
  }
  if (hasOpts) wrap.appendChild(opts);

  // Row 3: play + status (+ live value for globals).
  const line3 = document.createElement("div");
  line3.className = "edit-form-row";
  const play = document.createElement("button");
  play.type = "button";
  play.className = "edit-apply edit-apply-mmg";
  play.title = isTransferRow(row)
    ? "Transfer the source mesh's fields onto this one"
    : "Compute this variable and show it on the mesh";
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
    const msg = buildOpMessage(row);
    row.status = "running";
    row.message = undefined;
    if (isTransferRow(row)) transferAwaiting = index;
    render();
    fire(msg, methodLabel(row));
  });
  line3.appendChild(play);
  wrap.appendChild(line3);

  const status = document.createElement("div");
  status.className = "var-status";
  if (isGlobalRow(row) && row.variable.trim()) {
    const value = document.createElement("span");
    value.className = "var-global-value";
    value.title = `${row.reduction} of ${row.kind} ${row.variable}`;
    value.textContent = `= ${fmtGlobal(globalRowValue(row))}`;
    status.appendChild(value);
  }
  const message = document.createElement("span");
  message.className = "var-status-text";
  status.appendChild(message);
  line3.appendChild(status);
  displayStatus(wrap, row);

  return wrap;
}

/** Paints a row's inline status line from its CURRENT (unmodified) status/message. */
function displayStatus(wrap: HTMLElement, row: VarRow): void {
  const status = wrap.querySelector<HTMLDivElement>(".var-status");
  if (!status) return;
  // The message lives in `.var-status-text`, so a global row's prepended
  // value span is never clobbered by a repaint.
  const text = status.querySelector<HTMLSpanElement>(".var-status-text");
  if (text) text.textContent = row.status === "running" ? "Computing…" : row.message ?? "";
  else status.textContent = row.status === "running" ? "Computing…" : row.message ?? "";
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
