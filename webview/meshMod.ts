/**
 * Mesh Modification sidebar wiring for the webview.  The section markup lives in
 * `src/webviewChrome.ts` (SIDEBAR_HTML); this module forwards the modifier
 * clicks to the extension host, which runs the transform on its loaded model and
 * re-posts the result so the preview rebuilds.
 *
 * Owns: the Linear → Quadratic button, the MMG remesh form (mode + value +
 * Advanced tuning) and the MMG level-set form (nodal-field select populated by
 * `setMeshModFields` on every model/frame message). Collapse/Enter behaviour of
 * the `.edit-form` blocks comes for free from `initEditHistory`'s generic wiring.
 */

import { validateSizeExpr, remeshSizeExprVars, describeUnknownRemeshVar } from "../src/parser/sizeExpr";
import { noteFieldFire, noteFieldFireFromMessage } from "./fieldRegistry";
import { ensureBoundaryLayerVariables } from "./variablesPanel";
import { scopeVariables as fieldScopeVariables } from "../src/parser/fieldCalc";
import { FieldData } from "../src/parser/types";
import { isQueueMode, stageOp, buildApplyBatchMsg } from "./opQueue";

type PostMessage = (msg: unknown) => void;

/** Current model's SubModelPart paths (for the per-part sizing dropdowns). */
let smpPaths: string[] = [];
/**
 * The surface / source mesh picked for the two-mesh field ops (transferField,
 * and the standalone Signed-distance form's own file alternative). Like
 * mergePaths, the readonly input is only a DISPLAY (it shows the base name);
 * these module variables are the storage the message is built from.
 */
let sdfPath = "";
let swPath = "";
let cmpPath = "";
/** #sdf-part's sentinel for "the mesh's own exterior skin" — never a real SubModelPart path. */
const SDF_SKIN = "@skin";
let xferPath = "";

/**
 * Every existing Nodal field's variable name(s), in `fieldCalc.ts`'s own
 * scalar/`_x`/`_y`/`_z` convention — the remesh `expr` mode's formula scope
 * widens with these (see `remeshSizeExprVars`), which is what lets a formula
 * here reference a variable computed in the Variables sidebar section (e.g.
 * a `d` from Distance-to-surface) by name, with no picker of its own left in
 * THIS form. Recomputed by `setMeshModFields` on every model/frame message so
 * inline validation here agrees with what the host will actually accept.
 */
let remeshFieldVars: string[] = [];
/** Global variable names for the same scope (recomputed alongside the above). */
let remeshGlobalVars: string[] = [];

/** The per-SubModelPart sizing overrides currently entered in the form. */
let sizeParts: { path: string; expr: string }[] = [];
/** The per-block / per-part local size bounds (raw input strings; parsed on build). */
let localSizes: { kind: string; target: string; hmin: string; hmax: string; hausd: string }[] = [];

/** Wires the Mesh Modification buttons. Safe to call once after the DOM is ready. */
export function initMeshMod(postMessage: PostMessage): void {
  // Posts immediately, or stages into the operation queue when queue mode is
  // on — every op-firing button in this module goes through this helper so
  // none of them is a silent exception to "queue operations for one apply".
  // Provenance for the Variables panel's auto-row upsert is noted on actual
  // post only (staging runs nothing yet; the batch post notes "Queued steps").
  const fire = (msg: Record<string, unknown>): void => {
    if (isQueueMode()) {
      stageOp(msg);
      return;
    }
    noteFieldFireFromMessage(msg);
    postMessage(msg);
  };

  const quadratic = document.getElementById("mesh-mod-quadratic");
  quadratic?.addEventListener("click", () => {
    fire({ type: "applyOp", op: "linearToQuadratic" });
  });
  document.getElementById("mesh-mod-linearize")?.addEventListener("click", () => {
    fire({ type: "applyOp", op: "linearize" });
  });
  document.getElementById("mesh-mod-simplexify")?.addEventListener("click", () => {
    fire({ type: "applyOp", op: "simplexify" });
  });

  // Crop: the box/plane input rows toggle with the "by" select.
  const cropKind = document.getElementById("crop-kind") as HTMLSelectElement | null;
  cropKind?.addEventListener("change", updateCropKindUI);
  updateCropKindUI();

  // Refine: the field/part rows follow the "where" select, same pattern.
  document.getElementById("refine-select")?.addEventListener("change", updateRefineSelectUI);
  updateRefineSelectUI();

  // Error estimate: the marking value only means something for a policy that
  // reads one, so it follows the marking select the way crop's rows follow "by".
  document
    .getElementById("errest-marking")
    ?.addEventListener("change", updateErrorMarkingUI);
  updateErrorMarkingUI();

  document.getElementById("sr-metric")?.addEventListener("change", updateSurfaceRemeshUI);
  updateSurfaceRemeshUI();

  // Condition field: lo/hi mean nothing to standardize, and the NaN value only
  // to the "replace" policy — the same "don't show an input nothing reads" rule.
  document.getElementById("cond-mode")?.addEventListener("change", updateConditionUI);
  document.getElementById("cond-nan")?.addEventListener("change", updateConditionUI);
  updateConditionUI();

  // Every plain (synchronous) apply button not covered by a dedicated
  // handler above/below: read its form's inputs, post if valid.
  const SYNC_BUILDERS: Record<string, () => Record<string, unknown> | undefined> = {
    setElementRadius: buildRadiusMsg,
    renumber: buildRenumberMsg,
    refine: buildRefineMsg,
    crop: buildCropMsg,
    fieldCalc: buildFieldCalcMsg,
    averageField: buildAverageFieldMsg,
    renameField: buildRenameFieldMsg,
    dropFields: () => buildFieldSelectMsg("dropFields"),
    keepFields: () => buildFieldSelectMsg("keepFields"),
    conditionField: buildConditionFieldMsg,
  };
  for (const [op, build] of Object.entries(SYNC_BUILDERS)) {
    document.querySelector<HTMLButtonElement>(`.edit-apply[data-op="${op}"]`)?.addEventListener(
      "click",
      () => {
        const msg = build();
        if (msg) fire(msg);
      }
    );
  }

  // Field calculator: live-validate the expression against the fields
  // actually available at the chosen location (recomputed on every change,
  // since the allowed variable set depends on it).
  const calcLocation = document.getElementById("calc-location") as HTMLSelectElement | null;
  const calcExpr = document.getElementById("calc-expr");
  calcLocation?.addEventListener("change", () => validateCalcExpr());
  calcExpr?.addEventListener("input", () => validateCalcExpr());

  // Merge mesh: "Browse…" asks the host for a file; the host replies with
  // `mergeMeshPicked` (wired in setMergeMeshPath below).
  // Merge mesh / SDF / transfer: "Browse…" asks the host for a file, naming
  // WHICH form asked. The host echoes `target` back on `mergeMeshPicked`, so
  // two forms' Browse buttons cannot cross-contaminate each other's field.
  for (const [id, target] of [
    ["merge-browse", "mergeMesh"],
    ["sdf-browse", "sdfDistance"],
    ["sw-browse", "shrinkwrap"],
    ["cmp-browse", "compareField"],
    ["xfer-browse", "transferField"],
  ] as const) {
    document.getElementById(id)?.addEventListener("click", () => {
      postMessage({ type: "pickMeshFile", target });
    });
  }

  // Remesh presets: fills the formula box with a starting point (always
  // overwrites — picking a preset IS the user's explicit request, unlike the
  // old "only fill an untouched default" auto-fill this replaces). Picking
  // one also switches the mode to `expr`: the formula only means something
  // there, and filling the box while factor/hsiz/optimize is selected would
  // run that mode instead — the preset "not working".
  const remeshPreset = document.getElementById("remesh-preset") as HTMLSelectElement | null;
  remeshPreset?.addEventListener("change", () => {
    if (!remeshPreset.value) return;
    const autoVars =
      remeshPreset.selectedOptions[0]?.dataset.autoVars === "1";
    const autoCurvature =
      remeshPreset.selectedOptions[0]?.dataset.autoCurvature === "1";
    const mode = document.getElementById("remesh-mode") as HTMLSelectElement | null;
    if (mode && mode.value !== "expr") {
      mode.value = "expr";
      updateRemeshModeUI();
    }
    const expr = document.getElementById("remesh-sizeexpr") as HTMLInputElement | null;
    if (expr) expr.value = remeshPreset.value;
    remeshPreset.value = "";
    validateExprInputs();
    // The Boundary-layer preset names variables the mesh may not have yet
    // (d, mean_h, …): add the missing ones to the Variables section and
    // compute whatever needs no further input (globals + NODAL_H; d's
    // surface stays the user's call and its row is added idle).
    if (autoVars) ensureBoundaryLayerVariables();
    // The curvature preset reads CURVATURE_MEAN: compute it when absent (a
    // surface mesh only — on a solid the host says so). fieldScopeVariables
    // lowercases names, so that is the spelling to look for.
    if (autoCurvature && !remeshFieldVars.includes("curvature_mean")) {
      fire({ type: "applyOp", op: "curvature", mean: true, gaussian: false });
    }
  });

  // Signed distance: same mutual-exclusion shape as remesh's own pair —
  // picking a SubModelPart clears the browsed file, and setMergeMeshPaths'
  // sdfDistance branch does the reverse when a file is actually picked.
  const sdfPart = document.getElementById("sdf-part") as HTMLSelectElement | null;
  sdfPart?.addEventListener("change", () => {
    if (sdfPart.value) {
      sdfPath = "";
      const pathInput = document.getElementById("sdf-path") as HTMLInputElement | null;
      if (pathInput) {
        pathInput.value = "";
        pathInput.title = "";
      }
    }
  });

  // Shrinkwrap: the same file-or-part exclusivity as the signed-distance form.
  const swTarget = document.getElementById("sw-target") as HTMLSelectElement | null;
  swTarget?.addEventListener("change", () => {
    if (swTarget.value) {
      swPath = "";
      const pathInput = document.getElementById("sw-path") as HTMLInputElement | null;
      if (pathInput) {
        pathInput.value = "";
        pathInput.title = "";
      }
    }
  });

  // The remesh mode drives which inputs are relevant: a numeric factor/size, an
  // expression (`expr`), or nothing at all (`optimize`).
  const mode = document.getElementById("remesh-mode") as HTMLSelectElement | null;
  mode?.addEventListener("change", updateRemeshModeUI);
  updateRemeshModeUI();

  // Live-validate the global expression and reflect parse errors inline.
  document
    .getElementById("remesh-sizeexpr")
    ?.addEventListener("input", () => validateExprInputs());

  // Per-part sizing: add a fresh override row.
  document.getElementById("remesh-sizeparts-add")?.addEventListener("click", () => {
    sizeParts.push({ path: smpPaths[0] ?? "", expr: "0.25*h" });
    renderSizeParts();
  });

  // Local size bounds: add a fresh row (part or block + three bounds).
  document.getElementById("remesh-localsizes-add")?.addEventListener("click", () => {
    localSizes.push({ kind: "part", target: smpPaths[0] ?? "", hmin: "", hmax: "", hausd: "" });
    renderLocalSizes();
  });

  // Async apply buttons run the op (play) or cancel the in-flight run (stop).
  // Wired from the DOM + ASYNC_BUILDERS rather than one hand-written listener
  // per op, so adding an async operation is a markup line plus a builder entry.
  for (const btn of asyncApplyButtons()) {
    const op = btn.dataset.op;
    const build = op ? ASYNC_BUILDERS[op] : undefined;
    if (!build) continue;
    btn.addEventListener("click", () => {
      // Queueing stages the built message and returns — nothing is running for
      // THIS button, so the play/stop toggle stays idle; "Apply queued steps"
      // (itself an ASYNC_BUILDERS entry, see buildApplyBatchMsg) is what runs it.
      if (isQueueMode() && op !== "batch") {
        const msg = build();
        if (msg) stageOp(msg);
        return;
      }
      if (opRunning) {
        postMessage({ type: "opCancel" });
        return;
      }
      const msg = build();
      if (!msg) return;
      // A queued batch carries unknown steps — attribute whatever new fields
      // arrive to it wholesale. Single ops derive precise provenance (and a
      // re-runnable definition where one exists) from the message itself.
      if (op === "batch") noteFieldFire({ origin: "Queued steps", expectedKeys: [] });
      else noteFieldFireFromMessage(msg);
      postMessage(msg);
    });
  }

  // Set element radius — a plain synchronous op, so an ordinary apply button
  // (no play/stop, no progress bar).
  const applyRadius = (): void => {
    const msg = buildRadiusMsg();
    if (msg) fire(msg);
  };
  document
    .querySelector<HTMLButtonElement>('.edit-apply[data-op="setElementRadius"]')
    ?.addEventListener("click", applyRadius);
  document.getElementById("radius-value")?.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") applyRadius();
  });
}

/**
 * Message builders for the long-running, cancellable operations — the ones
 * whose apply button is a play/stop toggle with an inline progress bar.
 * Keyed by the button's `data-op`; a builder returning undefined means the form
 * is invalid and has already shown why.
 */
const ASYNC_BUILDERS: Record<string, () => Record<string, unknown> | undefined> = {
  remesh: buildRemeshMsg,
  levelset: buildLevelsetMsg,
  repairSurface: buildRepairSurfaceMsg,
  surfaceRemesh: buildSurfaceRemeshMsg,
  volumeMesh: buildVolumeMeshMsg,
  optimizeVolume: buildOptimizeVolumeMsg,
  curvature: buildCurvatureMsg,
  shrinkwrap: buildShrinkwrapMsg,
  compareField: buildCompareFieldMsg,
  sobolevDeform: buildSobolevMsg,
  smooth: buildSmoothMsg,
  reorder: buildReorderMsg,
  partition: buildPartitionMsg,
  mergeMesh: buildMergeMeshMsg,
  fieldGradient: buildFieldGradientMsg,
  fieldHessian: buildFieldHessianMsg,
  estimateError: buildEstimateErrorMsg,
  sdfDistance: buildSdfDistanceMsg,
  transferField: buildTransferFieldMsg,
  // "Apply queued steps" — folds the operation queue into one applyBatch
  // message, reusing this same play/stop + progress-bar machinery.
  batch: buildApplyBatchMsg,
};

/** Every async apply button currently in the sidebar. */
function asyncApplyButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>(".edit-apply-mmg[data-op]"));
}

function buildRadiusMsg(): Record<string, unknown> | undefined {
  const mode =
    (document.getElementById("radius-mode") as HTMLSelectElement | null)?.value ?? "absolute";
  const value = optNum("radius-value");
  // A zero/negative radius (or factor) would be rejected by the host anyway;
  // dropping it here keeps a stray keystroke from looking like a silent failure.
  if (value === undefined || !(value > 0)) return undefined;
  const msg: Record<string, unknown> = { type: "applyOp", op: "setElementRadius", mode, value };
  const target = (document.getElementById("radius-target") as HTMLSelectElement | null)?.value;
  if (target) msg.target = target; // "" = whole mesh
  return msg;
}

/** True while any long-running operation is in flight. */
let opRunning = false;

/**
 * Reflects the host's `opProgress` messages into the Mesh Modification section:
 * shows/hides the inline loading bar under the form that triggered the MMG run,
 * streams the latest log line into it, and flips that form's play button to a
 * stop (cancel) button while the run is live.
 */
export function setMeshModProgress(state: {
  running: boolean;
  op?: string;
  message?: string;
}): void {
  opRunning = state.running;
  for (const btn of asyncApplyButtons()) {
    const op = btn.dataset.op;
    const isTrigger = state.running && state.op === op;

    // The progress box is the one inside the button's OWN form — found by
    // walking up rather than by a table of ids, so a new async form needs no
    // change here. Nested sub-forms (Advanced, per-part sizing) carry no
    // `.edit-progress`, so the lookup cannot pick the wrong one.
    const box = btn.closest(".edit-form")?.querySelector<HTMLElement>(".edit-progress");
    box?.classList.toggle("hidden", !isTrigger);
    if (isTrigger && state.message) {
      const msg = box?.querySelector<HTMLElement>(".edit-progress-msg");
      if (msg) {
        msg.textContent = state.message;
        msg.title = state.message;
      }
    }

    btn.classList.toggle("running", isTrigger);
    btn.title = isTrigger ? "Cancel the running operation" : (btn.dataset.runTitle ?? "");

    // Every other async button is inert while a run is live (the host guards
    // too). At rest a form may still be unavailable — `data-gate` names an
    // input whose disabled state stands for "this op does not apply here".
    const gate = btn.dataset.gate;
    const gated =
      gate !== undefined &&
      (document.getElementById(gate) as HTMLInputElement | HTMLSelectElement | null)?.disabled ===
        true;
    btn.disabled = state.running ? !isTrigger : gated;
  }
}

/** Reads a numeric input by id; undefined when empty or not a number. */
function optNum(id: string): number | undefined {
  const raw = (document.getElementById(id) as HTMLInputElement | null)?.value.trim();
  if (!raw) return undefined;
  const v = Number(raw);
  return Number.isFinite(v) ? v : undefined;
}

function checked(id: string): boolean {
  return (document.getElementById(id) as HTMLInputElement | null)?.checked === true;
}

/** Shows/hides the numeric value field, the expression block, the aniso block, and the value label per mode. */
function updateRemeshModeUI(): void {
  const m = (document.getElementById("remesh-mode") as HTMLSelectElement | null)?.value ?? "factor";
  const valueField = document.getElementById("remesh-value-field");
  const valueLabel = document.getElementById("remesh-value-label");
  const exprBlock = document.getElementById("remesh-expr-block");
  const anisoBlock = document.getElementById("remesh-aniso-block");
  if (valueLabel) valueLabel.textContent = m === "hsiz" ? "size" : "factor";
  // The numeric value only matters for factor/hsiz; the other modes hide it.
  valueField?.classList.toggle("hidden", m === "optimize" || m === "expr" || m === "aniso");
  exprBlock?.classList.toggle("hidden", m !== "expr");
  anisoBlock?.classList.toggle("hidden", m !== "aniso");
  if (m === "expr") validateExprInputs();
}

/** Reads a trimmed string input by id; empty string when blank/absent. */
function optStr(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | null)?.value.trim() ?? "";
}

/**
 * Validates the global expression + every per-part expression, marking invalid
 * inputs and filling the error line. Returns true when all parse.
 */
function validateExprInputs(): boolean {
  let ok = true;
  // No distance-surface picker lives in this form any more — a variable
  // named `d` is just another Nodal field, in `remeshFieldVars` like any
  // other, so `hasDistanceSurface` is always false here.
  const allowedVars = remeshSizeExprVars(false, remeshFieldVars, remeshGlobalVars);
  const global = document.getElementById("remesh-sizeexpr") as HTMLInputElement | null;
  const errBox = document.getElementById("remesh-sizeexpr-error");
  // A bare `Unknown name "d"` misleads: the spelling is right, the variable
  // just isn't on the mesh yet (this only fires when no field named `d`
  // exists — otherwise it would be in scope). Say where to compute one.
  const rawErr = global ? validateSizeExpr(global.value.trim() || "0.5*h", allowedVars) : undefined;
  const globalErr = rawErr ? describeUnknownRemeshVar(rawErr) : undefined;
  global?.classList.toggle("invalid", globalErr !== undefined);
  if (errBox) {
    errBox.textContent = globalErr ?? "";
    errBox.classList.toggle("hidden", globalErr === undefined);
  }
  if (globalErr) ok = false;
  document.querySelectorAll<HTMLInputElement>(".edit-sizepart-expr").forEach((input) => {
    const err = validateSizeExpr(input.value.trim(), allowedVars);
    input.classList.toggle("invalid", err !== undefined);
    input.title = err ?? "";
    if (err) ok = false;
  });
  return ok;
}

/** Rebuilds the per-part override rows from the `sizeParts` state. */
function renderSizeParts(): void {
  const host = document.getElementById("remesh-sizeparts");
  const addBtn = document.getElementById("remesh-sizeparts-add") as HTMLButtonElement | null;
  if (!host) return;
  host.textContent = "";
  if (addBtn) addBtn.disabled = smpPaths.length === 0;
  sizeParts.forEach((part, index) => {
    const row = document.createElement("div");
    row.className = "edit-sizepart-row";

    const select = document.createElement("select");
    select.className = "edit-sel";
    if (smpPaths.length === 0) {
      const opt = document.createElement("option");
      opt.value = part.path;
      opt.textContent = part.path || "no SubModelParts";
      select.appendChild(opt);
      select.disabled = true;
    } else {
      // Keep a stale path visible (flagged) if the model no longer has it.
      const options = smpPaths.includes(part.path) || !part.path ? smpPaths : [part.path, ...smpPaths];
      for (const p of options) {
        const opt = document.createElement("option");
        opt.value = p;
        opt.textContent = p;
        select.appendChild(opt);
      }
      select.value = part.path || smpPaths[0];
      sizeParts[index].path = select.value;
    }
    select.addEventListener("change", () => {
      sizeParts[index].path = select.value;
    });

    const expr = document.createElement("input");
    expr.type = "text";
    expr.className = "edit-sizepart-expr";
    expr.spellcheck = false;
    expr.value = part.expr;
    expr.placeholder = "0.25*h";
    expr.addEventListener("input", () => {
      sizeParts[index].expr = expr.value;
      validateExprInputs();
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "edit-sizepart-del";
    del.textContent = "✕";
    del.title = "Remove this override";
    del.addEventListener("click", () => {
      sizeParts.splice(index, 1);
      renderSizeParts();
    });

    row.append(select, expr, del);
    host.appendChild(row);
  });
  validateExprInputs();
}

/** Rebuilds the local-bound rows from the `localSizes` state. */
function renderLocalSizes(): void {
  const host = document.getElementById("remesh-localsizes");
  if (!host) return;
  host.textContent = "";
  localSizes.forEach((row_state, index) => {
    const row = document.createElement("div");
    row.className = "edit-sizepart-row";
    row.title = "Per-block / per-part hmin/hmax/hausd bound (all three required)";

    const kind = document.createElement("select");
    kind.className = "edit-sel";
    for (const k of ["part", "block"]) {
      const opt = document.createElement("option");
      opt.value = k;
      opt.textContent = k;
      kind.appendChild(opt);
    }
    kind.value = row_state.kind;
    kind.title = "part = SubModelPart path (subtree included); block = EntityBlock name";
    kind.addEventListener("change", () => {
      localSizes[index].kind = kind.value;
    });

    const target = document.createElement("input");
    target.type = "text";
    target.className = "edit-text";
    target.spellcheck = false;
    target.value = row_state.target;
    target.placeholder = row_state.kind === "block" ? "Block name" : "Part/path";
    target.title = "Block name or SubModelPart path — unknown targets warn and are skipped";
    target.addEventListener("input", () => {
      localSizes[index].target = target.value;
    });

    const nums: Array<[key: "hmin" | "hmax" | "hausd", ph: string]> = [
      ["hmin", "hmin"],
      ["hmax", "hmax"],
      ["hausd", "hausd"],
    ];
    const numInputs = nums.map(([key, ph]) => {
      const input = document.createElement("input");
      input.type = "number";
      input.className = "edit-num";
      input.step = "any";
      input.min = "0";
      input.value = row_state[key];
      input.placeholder = ph;
      input.title = ph;
      input.addEventListener("input", () => {
        localSizes[index][key] = input.value;
      });
      return input;
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "edit-sizepart-del";
    del.textContent = "✕";
    del.title = "Remove this bound";
    del.addEventListener("click", () => {
      localSizes.splice(index, 1);
      renderLocalSizes();
    });

    row.append(kind, target, ...numInputs, del);
    host.appendChild(row);
  });
}

/**
 * (Re)populates the per-part SubModelPart selects from the current model. Called
 * by main.ts on every `model` / `vtkFrame` message (like `setMeshModFields`).
 */
export function setMeshModParts(parts: { path: string; children: unknown[] }[]): void {
  const paths: string[] = [];
  const walk = (p: { path: string; children: unknown[] }): void => {
    paths.push(p.path);
    (p.children as { path: string; children: unknown[] }[]).forEach(walk);
  };
  parts.forEach(walk);
  smpPaths = paths;
  renderSizeParts();

  // The radius form's optional scope. The empty first option is "whole mesh";
  // it is what makes `target` absent on the message rather than a real filter.
  const target = document.getElementById("radius-target") as HTMLSelectElement | null;
  if (target) {
    const previous = target.value;
    target.textContent = "";
    const all = document.createElement("option");
    all.value = "";
    all.textContent = "whole mesh";
    target.appendChild(all);
    for (const p of paths) {
      const opt = document.createElement("option");
      opt.value = p;
      opt.textContent = p;
      target.appendChild(opt);
    }
    if (paths.includes(previous)) target.value = previous;
  }

  // The refine form's part selector. No "whole mesh" entry here: the mode
  // select above it already says whether a part is being used at all, so an
  // empty option would be a second way to say the same thing.
  const refinePart = document.getElementById("refine-part") as HTMLSelectElement | null;
  if (refinePart) {
    const prev = refinePart.value;
    refinePart.textContent = "";
    for (const p of paths) {
      const opt = document.createElement("option");
      opt.value = p;
      opt.textContent = p;
      refinePart.appendChild(opt);
    }
    if (paths.length === 0) {
      const none = document.createElement("option");
      none.value = "";
      none.textContent = "no SubModelParts";
      refinePart.appendChild(none);
    } else if (paths.includes(prev)) {
      refinePart.value = prev;
    }
  }

  // The signed-distance form's own part selector.
  const sdfPart = document.getElementById("sdf-part") as HTMLSelectElement | null;
  if (sdfPart) {
    const prev = sdfPart.value;
    sdfPart.textContent = "";
    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "— none —";
    sdfPart.appendChild(noneOpt);
    // Not a SubModelPart: the mesh's own exterior skin (what Export skin…
    // writes). A sentinel value rather than a checkbox so the file / part /
    // skin exclusivity stays a single control.
    const skinOpt = document.createElement("option");
    skinOpt.value = SDF_SKIN;
    skinOpt.textContent = "◆ mesh skin (exterior boundary)";
    sdfPart.appendChild(skinOpt);
    for (const p of paths) {
      const opt = document.createElement("option");
      opt.value = p;
      opt.textContent = p;
      sdfPart.appendChild(opt);
    }
    if (prev === SDF_SKIN || paths.includes(prev)) sdfPart.value = prev;
    // sdfPath/sdf-part have no module-level "part" variable to reset —
    // buildSdfDistanceMsg reads the select's value fresh every time, so a
    // stale selection simply falls back to its own "none" option here with
    // nothing else to keep in sync.
  }

  // Shrinkwrap's target (parts + skin) and the part pickers of the two
  // deformation forms. Each keeps its own previous selection when it still exists.
  fillPartSelect("sw-target", paths, "— none —", true);
  fillPartSelect("sw-move", paths, "— all nodes —", false);
  fillPartSelect("sw-pin", paths, "— none —", false);
  fillPartSelect("sob-fixed", paths, "— none —", false);
}

/** (Re)fills a SubModelPart `<select>`, optionally with the exterior-skin sentinel, keeping a still-valid selection. */
function fillPartSelect(id: string, paths: string[], noneLabel: string, withSkin: boolean): void {
  const select = document.getElementById(id) as HTMLSelectElement | null;
  if (!select) return;
  const prev = select.value;
  select.textContent = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = noneLabel;
  select.appendChild(none);
  if (withSkin) {
    const skin = document.createElement("option");
    skin.value = SDF_SKIN;
    skin.textContent = "◆ mesh skin (exterior boundary)";
    select.appendChild(skin);
  }
  for (const p of paths) {
    const opt = document.createElement("option");
    opt.value = p;
    opt.textContent = p;
    select.appendChild(opt);
  }
  if ((withSkin && prev === SDF_SKIN) || paths.includes(prev)) select.value = prev;
}

/**
 * Fills a per-CELL field select.
 *
 * Deliberately not `fillNodalSelect`: that one offers Nodal fields (every other
 * consumer wants a gradient source) and DISABLES its whole form when there are
 * none. Refine must stay usable with no fields at all — "whole mesh" is its
 * default mode — so an empty list only empties this one control.
 */
function fillCellSelect(
  id: string,
  cell: { variable: string; components: number }[],
  preferred: string
): void {
  const select = document.getElementById(id) as HTMLSelectElement | null;
  if (!select) return;
  const previous = select.value;
  select.textContent = "";
  for (const f of cell) {
    const opt = document.createElement("option");
    opt.value = f.variable;
    opt.textContent = f.components > 1 ? `${f.variable} (${f.components})` : f.variable;
    select.appendChild(opt);
  }
  if (cell.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "no per-cell fields";
    select.appendChild(opt);
    return;
  }
  if (cell.some((f) => f.variable === previous)) select.value = previous;
  else if (cell.some((f) => f.variable === preferred)) select.value = preferred;
}

/**
 * Enables/disables the Set-element-radius form. Called by main.ts on every
 * `model` / `vtkFrame`: a mesh with no one-node cells has nothing to set.
 */
export function setMeshModSpheres(hasParticles: boolean): void {
  const form = document.getElementById("radius-form");
  if (!form) return;
  form
    .querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
      "input, select, .edit-apply"
    )
    .forEach((el) => {
      el.disabled = !hasParticles;
    });
}

function buildRemeshMsg(): Record<string, unknown> | undefined {
  const mode =
    (document.getElementById("remesh-mode") as HTMLSelectElement | null)?.value ?? "factor";
  const msg: Record<string, unknown> = { type: "applyOp", op: "remesh", mode };
  const value = optNum("remesh-value");
  if (mode === "factor") msg.factor = value ?? 1;
  if (mode === "hsiz") msg.hsiz = value;
  if (mode === "expr") {
    if (!validateExprInputs()) return undefined; // inline errors already shown
    msg.sizeExpr = optStr("remesh-sizeexpr") || "0.5*h";
    const parts = sizeParts
      .map((p) => ({ path: p.path.trim(), expr: p.expr.trim() }))
      .filter((p) => p.path && p.expr);
    if (parts.length) msg.sizeParts = parts;
  }
  if (mode === "aniso") {
    const variable = (
      document.getElementById("remesh-aniso-variable") as HTMLSelectElement | null
    )?.value;
    if (!variable) return undefined;
    msg.variable = variable;
    const method = (
      document.getElementById("remesh-aniso-method") as HTMLSelectElement | null
    )?.value;
    if (method) msg.method = method;
  }
  // Frozen entities: comma-separated names → {kind, target} rows; blanks dropped.
  const frozen = selectorRows("remesh-frozen-blocks", "remesh-frozen-parts");
  if (frozen.length) msg.frozen = frozen;
  // Local bounds: incomplete rows (empty target / non-positive bound) are
  // dropped here — the host rejects the whole message on a bad row, so a
  // half-filled row must never be posted.
  const locals = localSizes
    .map((r) => ({
      kind: r.kind.trim(),
      target: r.target.trim(),
      hmin: Number(r.hmin),
      hmax: Number(r.hmax),
      hausd: Number(r.hausd),
    }))
    .filter((r) => r.target && r.hmin > 0 && r.hmax > 0 && r.hausd > 0);
  if (locals.length) msg.localSizes = locals;
  for (const k of ["hmin", "hmax", "hausd", "hgrad"]) {
    const v = optNum(`remesh-${k}`);
    if (v !== undefined) msg[k] = v;
  }
  const angle = optNum("remesh-angle");
  if (angle !== undefined) msg.angleDetection = angle;
  const module = (document.getElementById("remesh-module") as HTMLSelectElement | null)?.value;
  if (module && module !== "auto") msg.module = module;
  for (const k of ["nosurf", "noinsert", "noswap", "nomove"]) {
    if (checked(`remesh-${k}`)) msg[k] = true;
  }
  return msg;
}

/**
 * Reads a pair of comma-separated block/part inputs into `{kind, target}` rows.
 * Empty tokens are dropped here rather than posted: the host rejects the whole
 * message on a bad row, so a stray comma must not fail the run.
 */
function selectorRows(blockId: string, partId: string): { kind: string; target: string }[] {
  const read = (id: string, kind: string) =>
    ((document.getElementById(id) as HTMLInputElement | null)?.value ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .map((target) => ({ kind, target }));
  return [...read(blockId, "block"), ...read(partId, "part")];
}

function buildLevelsetMsg(): Record<string, unknown> | undefined {
  const variable = (document.getElementById("ls-variable") as HTMLSelectElement | null)?.value;
  if (!variable) return undefined;
  const msg: Record<string, unknown> = { type: "applyOp", op: "levelset", variable };
  const iso = optNum("ls-isovalue");
  if (iso !== undefined && iso !== 0) msg.isovalue = iso;
  if (checked("ls-isosurf")) msg.isosurf = true;
  const rmc = optNum("ls-rmc");
  if (rmc !== undefined) msg.rmc = rmc;
  if (checked("ls-keep-materials")) msg.keepMaterials = true;
  const noSplit = selectorRows("ls-nosplit-blocks", "ls-nosplit-parts");
  if (noSplit.length) msg.noSplit = noSplit;
  const baseRefs = selectorRows("ls-baseref-blocks", "ls-baseref-parts");
  if (baseRefs.length) msg.baseRefs = baseRefs;
  for (const k of ["hmin", "hmax", "hausd", "hgrad"]) {
    const v = optNum(`ls-${k}`);
    if (v !== undefined) msg[k] = v;
  }
  const module = (document.getElementById("ls-module") as HTMLSelectElement | null)?.value;
  if (module && module !== "auto") msg.module = module;
  return msg;
}

/**
 * (Re)populates the nodal-field selects — the level-set variable and the field
 * gradient's source — from the current model, enabling/disabling each form
 * accordingly. Called by main.ts on every `model` / `vtkFrame` message.
 */
export function setMeshModFields(
  fields: FieldData[],
  globals?: Record<string, { variable: string; kind: string; reduction: string }>
): void {
  const nodal = fields.filter((f) => f.kind === "Nodal");
  // Field-derived remesh variables (see remeshFieldVars' doc comment). Wrong
  // formula validation here would be worse than none: this must track
  // exactly what operations.ts's own model-aware widening will accept.
  remeshFieldVars = fieldScopeVariables(nodal, false);
  remeshGlobalVars = Object.keys(globals ?? {});
  validateExprInputs();
  // A displacement is a 2- or 3-component nodal field.
  fillNodalSelect(
    "sob-variable",
    nodal.filter((f) => f.components === 2 || f.components === 3),
    (f) => `${f.variable} (${f.components})`
  );
  fillAnyFieldSelect("fm-field", fields);
  fillAnyFieldSelect("cmp-field", fields);
  fillAnyFieldSelect("cond-field", fields);
  fillNodalSelect("grad-variable", nodal, (f) =>
    f.components > 1 ? `${f.variable} (${f.components})` : f.variable
  );
  // The Hessian is defined for a SCALAR field only, so the select offers just
  // those rather than letting a vector be picked and then rejected by the host.
  fillNodalSelect(
    "hess-variable",
    nodal.filter((f) => f.components === 1),
    (f) => f.variable
  );
  // Same scalar restriction for the anisotropic remesh, which differentiates
  // the field twice inline. Scoped to JUST #remesh-aniso-block (not the
  // default `.closest(".edit-form")`) — the aniso select lives inside the
  // SAME outer Remesh form as the mode selector, the `expr`-mode formula box
  // and its preset dropdown, and the Apply button they all share.
  // Left at the default scope, "no nodal fields" (the ordinary case for a
  // freshly-opened mesh) disabled that ENTIRE form — including expr mode,
  // which needs no nodal field at all — making Remesh appear completely dead
  // regardless of which mode was selected. Only the aniso sub-block's own
  // controls should go inert when there is nothing for it to differentiate.
  fillNodalSelect(
    "remesh-aniso-variable",
    nodal.filter((f) => f.components === 1),
    (f) => f.variable,
    document.getElementById("remesh-aniso-block")
  );
  fillNodalSelect("errest-variable", nodal, (f) =>
    f.components > 1 ? `${f.variable} (${f.components})` : f.variable
  );
  // Refine selects by a PER-CELL field, and defaults to the one estimateError
  // writes — the pairing this whole feature exists for.
  fillCellSelect(
    "refine-variable",
    fields.filter((f) => f.kind === "Elemental" || f.kind === "Conditional"),
    "ERROR_MARKED"
  );

  const select = document.getElementById("ls-variable") as HTMLSelectElement | null;
  const form = document.getElementById("ls-form");
  if (!select || !form) return;
  const previous = select.value;
  select.textContent = "";
  for (const f of nodal) {
    const opt = document.createElement("option");
    opt.value = f.variable;
    opt.textContent = f.components > 1 ? `${f.variable} (|v|)` : f.variable;
    select.appendChild(opt);
  }
  if (nodal.some((f) => f.variable === previous)) select.value = previous;
  const empty = nodal.length === 0;
  if (empty) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "no nodal fields";
    select.appendChild(opt);
  }
  select.disabled = empty;
  form
    .querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
      "input, select, .edit-apply"
    )
    .forEach((el) => {
      if (el !== select) el.disabled = empty;
    });
}

/**
 * Fills a nodal-field `<select>`, keeping the current pick when it survives,
 * and disables the whole enclosing form when the model has no nodal field.
 *
 * `scope` overrides the disable boundary from the default `.closest(".edit-form")`
 * to an explicit element — needed wherever the select shares its outer `.edit-form`
 * with SIBLING controls that do not depend on it (see the `remesh-aniso-variable`
 * call site: aniso lives inside the same form as the `expr` mode, which needs no
 * nodal field at all, so the default scope would disable that mode's Apply button
 * too whenever the mesh simply has none).
 */
function fillNodalSelect(
  id: string,
  nodal: { variable: string; components: number }[],
  label: (f: { variable: string; components: number }) => string,
  scope?: HTMLElement | null
): void {
  const select = document.getElementById(id) as HTMLSelectElement | null;
  if (!select) return;
  const previous = select.value;
  select.textContent = "";
  for (const f of nodal) {
    const opt = document.createElement("option");
    opt.value = f.variable;
    opt.textContent = label(f);
    select.appendChild(opt);
  }
  const empty = nodal.length === 0;
  if (empty) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "no nodal fields";
    select.appendChild(opt);
  } else if (nodal.some((f) => f.variable === previous)) {
    select.value = previous;
  }
  select.disabled = empty;
  (scope ?? select.closest(".edit-form"))
    ?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
      "input, select, .edit-apply"
    )
    .forEach((el) => {
      if (el !== select) el.disabled = empty;
    });
}

/**
 * A select listing EVERY field, value `Kind:variable` (a field is identified by
 * location AND name — TEMP can exist at two of them). Same disable-the-form rule
 * as `fillNodalSelect` when the mesh has none.
 */
function fillAnyFieldSelect(id: string, fields: FieldData[]): void {
  const select = document.getElementById(id) as HTMLSelectElement | null;
  if (!select) return;
  const previous = select.value;
  select.textContent = "";
  for (const f of fields) {
    const opt = document.createElement("option");
    opt.value = `${f.kind}:${f.variable}`;
    opt.textContent = `${f.variable} (${f.kind.toLowerCase()}${f.components > 1 ? `, ${f.components}` : ""})`;
    select.appendChild(opt);
  }
  const empty = fields.length === 0;
  if (empty) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "no fields";
    select.appendChild(opt);
  } else if (fields.some((f) => `${f.kind}:${f.variable}` === previous)) {
    select.value = previous;
  }
  select.disabled = empty;
  select
    .closest(".edit-form")
    ?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input, select, .edit-apply")
    .forEach((el) => {
      if (el !== select) el.disabled = empty;
    });
}

/** Splits a `Kind:variable` option value back into its parts. */
function selectedField(id: string): { kind: string; variable: string } | undefined {
  const v = (document.getElementById(id) as HTMLSelectElement | null)?.value ?? "";
  const i = v.indexOf(":");
  return i > 0 ? { kind: v.slice(0, i), variable: v.slice(i + 1) } : undefined;
}

function buildRenameFieldMsg(): Record<string, unknown> | undefined {
  const f = selectedField("fm-field");
  const newName = optStr("fm-newname");
  if (!f || !newName) return undefined;
  const msg: Record<string, unknown> = { type: "applyOp", op: "renameField", kind: f.kind, variable: f.variable, newName };
  if (checked("fm-overwrite")) msg.onConflict = "overwrite";
  return msg;
}

function buildFieldSelectMsg(op: "dropFields" | "keepFields"): Record<string, unknown> | undefined {
  const f = selectedField("fm-field");
  if (!f) return undefined;
  return { type: "applyOp", op, kind: f.kind, variables: [f.variable] };
}

function buildConditionFieldMsg(): Record<string, unknown> | undefined {
  const f = selectedField("cond-field");
  if (!f) return undefined;
  const mode = (document.getElementById("cond-mode") as HTMLSelectElement | null)?.value ?? "normalize";
  const msg: Record<string, unknown> = { type: "applyOp", op: "conditionField", kind: f.kind, variable: f.variable, mode };
  if (mode !== "standardize") {
    const lo = optNum("cond-lo");
    const hi = optNum("cond-hi");
    if (lo === undefined || hi === undefined) return undefined;
    msg.lo = lo;
    msg.hi = hi;
  }
  msg.scope = (document.getElementById("cond-scope") as HTMLSelectElement | null)?.value ?? "component";
  const nan = (document.getElementById("cond-nan") as HTMLSelectElement | null)?.value ?? "ignore";
  msg.nanPolicy = nan;
  if (nan === "replace") msg.nanReplacement = optNum("cond-nanvalue") ?? 0;
  const output = optStr("cond-output");
  if (output) msg.output = output;
  return msg;
}

/** Hides the lo/hi inputs standardize ignores and the NaN value unless "replace". */
function updateConditionUI(): void {
  const mode = (document.getElementById("cond-mode") as HTMLSelectElement | null)?.value ?? "normalize";
  const nan = (document.getElementById("cond-nan") as HTMLSelectElement | null)?.value ?? "ignore";
  document.getElementById("cond-lo-field")?.classList.toggle("hidden", mode === "standardize");
  document.getElementById("cond-hi-field")?.classList.toggle("hidden", mode === "standardize");
  document.getElementById("cond-nanvalue-field")?.classList.toggle("hidden", nan !== "replace");
}

// --- refine / crop / field calculator / average / gradient ------------------

/**
 * Field Hessian. The select is filtered to SCALAR nodal fields by
 * setMeshModFields, since that is the only shape the operation accepts.
 */
function buildFieldHessianMsg(): Record<string, unknown> | undefined {
  const variable = (document.getElementById("hess-variable") as HTMLSelectElement | null)?.value;
  if (!variable) return undefined;
  const msg: Record<string, unknown> = { type: "applyOp", op: "fieldHessian", variable };
  const method = (document.getElementById("hess-method") as HTMLSelectElement | null)?.value;
  if (method) msg.method = method;
  const output = (document.getElementById("hess-output") as HTMLInputElement | null)?.value.trim();
  if (output) msg.output = output;
  return msg;
}

/**
 * Zienkiewicz-Zhu error estimate. `value` is only sent when a marking policy
 * actually reads one — sending it with `marking: "none"` would suggest it does
 * something.
 */
function buildEstimateErrorMsg(): Record<string, unknown> | undefined {
  const variable = (document.getElementById("errest-variable") as HTMLSelectElement | null)?.value;
  if (!variable) return undefined;
  const msg: Record<string, unknown> = { type: "applyOp", op: "estimateError", variable };
  const marking = (document.getElementById("errest-marking") as HTMLSelectElement | null)?.value;
  if (marking) msg.marking = marking;
  if (marking && marking !== "none") {
    const raw = (document.getElementById("errest-value") as HTMLInputElement | null)?.value;
    const v = Number(raw);
    if (!Number.isFinite(v)) return undefined;
    msg.markingValue = v;
  }
  const output = (document.getElementById("errest-output") as HTMLInputElement | null)?.value.trim();
  if (output) msg.output = output;
  return msg;
}

/** Signed distance to an imported surface, a SubModelPart or the skin of this mesh, as a nodal field. */
function buildSdfDistanceMsg(): Record<string, unknown> | undefined {
  const part = (document.getElementById("sdf-part") as HTMLSelectElement | null)?.value ?? "";
  if (!sdfPath && !part) return undefined;
  const msg: Record<string, unknown> = sdfPath
    ? { type: "applyOp", op: "sdfDistance", path: sdfPath }
    : part === SDF_SKIN
      ? { type: "applyOp", op: "sdfDistance", skin: true }
      : { type: "applyOp", op: "sdfDistance", part };
  const sign = (document.getElementById("sdf-sign") as HTMLSelectElement | null)?.value;
  if (sign) msg.sign = sign;
  const band = optNum("sdf-band");
  if (band !== undefined && band > 0) msg.band = band;
  const output = (document.getElementById("sdf-output") as HTMLInputElement | null)?.value.trim();
  if (output) msg.output = output;
  return msg;
}

/** Conservative field transfer from another mesh. */
function buildTransferFieldMsg(): Record<string, unknown> | undefined {
  if (!xferPath) return undefined;
  const msg: Record<string, unknown> = { type: "applyOp", op: "transferField", path: xferPath };
  // Empty means "every field the source carries" — upstream's own default, so
  // the common case needs no typing.
  const arrays = (document.getElementById("xfer-arrays") as HTMLInputElement | null)?.value.trim();
  if (arrays) msg.arrays = arrays;
  const onConflict = (document.getElementById("xfer-conflict") as HTMLSelectElement | null)?.value;
  if (onConflict) msg.onConflict = onConflict;
  return msg;
}

/** Hide the marking value when no policy reads it. */
function updateErrorMarkingUI(): void {
  const marking = (document.getElementById("errest-marking") as HTMLSelectElement | null)?.value;
  const field = document.getElementById("errest-value-field");
  field?.classList.toggle("hidden", !marking || marking === "none");
}

/**
 * Field gradient / divergence / curl. The field select is populated by
 * setMeshModFields, so only a nodal field can ever be picked — an elemental one
 * is piecewise constant and has no derivative.
 */
function buildFieldGradientMsg(): Record<string, unknown> | undefined {
  const variable = (document.getElementById("grad-variable") as HTMLSelectElement | null)?.value;
  if (!variable) return undefined;
  const msg: Record<string, unknown> = { type: "applyOp", op: "fieldGradient", variable };
  const operator = (document.getElementById("grad-operator") as HTMLSelectElement | null)?.value;
  if (operator) msg.operator = operator;
  const method = (document.getElementById("grad-method") as HTMLSelectElement | null)?.value;
  if (method) msg.method = method;
  const output = (document.getElementById("grad-output") as HTMLInputElement | null)?.value.trim();
  if (output) msg.output = output;
  return msg;
}


function buildRefineMsg(): Record<string, unknown> | undefined {
  const levels = optNum("refine-levels") ?? 1;
  if (levels <= 0) return undefined;
  const msg: Record<string, unknown> = {
    type: "applyOp",
    op: "refine",
    levels: Math.floor(levels),
  };
  const mode =
    (document.getElementById("refine-select") as HTMLSelectElement | null)?.value ?? "all";
  if (mode === "field") {
    const variable = (document.getElementById("refine-variable") as HTMLSelectElement | null)?.value;
    if (!variable) return undefined; // no per-cell field to select by
    msg.select = {
      by: "field",
      variable,
      compare:
        (document.getElementById("refine-compare") as HTMLSelectElement | null)?.value ?? ">",
      value: optNum("refine-value") ?? 0.5,
    };
  } else if (mode === "part") {
    const path = (document.getElementById("refine-part") as HTMLSelectElement | null)?.value;
    if (!path) return undefined;
    msg.select = { by: "part", path };
  }
  return msg;
}

/** Shows only the rows the chosen mode reads — the updateCropKindUI pattern. */
function updateRefineSelectUI(): void {
  const mode =
    (document.getElementById("refine-select") as HTMLSelectElement | null)?.value ?? "all";
  document.getElementById("refine-field-row")?.classList.toggle("hidden", mode !== "field");
  document.getElementById("refine-part-row")?.classList.toggle("hidden", mode !== "part");
}

/** Shows the box (lo/hi) or plane (point/normal) input rows to match `#crop-kind`. */
function updateCropKindUI(): void {
  const kind = (document.getElementById("crop-kind") as HTMLSelectElement | null)?.value ?? "bbox";
  const isBox = kind === "bbox";
  document.getElementById("crop-bbox-row")?.classList.toggle("hidden", !isBox);
  document.getElementById("crop-bbox-row2")?.classList.toggle("hidden", !isBox);
  document.getElementById("crop-plane-row")?.classList.toggle("hidden", isBox);
  document.getElementById("crop-plane-row2")?.classList.toggle("hidden", isBox);
}

function buildCropMsg(): Record<string, unknown> | undefined {
  const kind = (document.getElementById("crop-kind") as HTMLSelectElement | null)?.value ?? "bbox";
  const mode = (document.getElementById("crop-mode") as HTMLSelectElement | null)?.value ?? "all";
  const vec3 = (prefix: string): [number, number, number] | undefined => {
    const x = optNum(`${prefix}-x`);
    const y = optNum(`${prefix}-y`);
    const z = optNum(`${prefix}-z`);
    return x !== undefined && y !== undefined && z !== undefined ? [x, y, z] : undefined;
  };
  if (kind === "bbox") {
    const lo = vec3("crop-lo");
    const hi = vec3("crop-hi");
    return lo && hi ? { type: "applyOp", op: "crop", kind, lo, hi, mode } : undefined;
  }
  const point = vec3("crop-point");
  const normal = vec3("crop-normal");
  return point && normal ? { type: "applyOp", op: "crop", kind, point, normal, mode } : undefined;
}

/** Re-validates the field-calculator expression inline; returns true when it compiles. */
function validateCalcExpr(): boolean {
  const input = document.getElementById("calc-expr") as HTMLInputElement | null;
  const errEl = document.getElementById("calc-expr-error");
  if (!input || !errEl) return false;
  // The allowed variable set depends on the location AND the current model's
  // fields there, which this module does not track — the host is the
  // authority on both, so a syntax slip is caught here, but an unknown field
  // name still surfaces from the host's rejection message rather than inline.
  const err = input.value.trim().length === 0 ? "Enter an expression." : undefined;
  errEl.textContent = err ?? "";
  errEl.classList.toggle("hidden", !err);
  return !err;
}

function buildFieldCalcMsg(): Record<string, unknown> | undefined {
  const expr = optStr("calc-expr");
  const output = optStr("calc-output");
  const location =
    (document.getElementById("calc-location") as HTMLSelectElement | null)?.value ?? "Nodal";
  if (!expr || !output) {
    validateCalcExpr();
    return undefined;
  }
  return { type: "applyOp", op: "fieldCalc", expr, location, output };
}

function buildAverageFieldMsg(): Record<string, unknown> | undefined {
  const variable = optStr("avg-variable");
  if (!variable) return undefined;
  const direction =
    (document.getElementById("avg-direction") as HTMLSelectElement | null)?.value ??
    "nodalToElemental";
  const target = (document.getElementById("avg-target") as HTMLSelectElement | null)?.value;
  const msg: Record<string, unknown> = { type: "applyOp", op: "averageField", variable, direction };
  if (target) msg.target = target;
  return msg;
}

// --- compare a field with another mesh's -----------------------------------------

function buildCompareFieldMsg(): Record<string, unknown> | undefined {
  const f = selectedField("cmp-field");
  if (!cmpPath || !f) return undefined;
  const msg: Record<string, unknown> = {
    type: "applyOp",
    op: "compareField",
    path: cmpPath,
    kind: f.kind,
    variable: f.variable,
    correspondence: (document.getElementById("cmp-corr") as HTMLSelectElement | null)?.value ?? "id",
  };
  const source = optStr("cmp-source");
  if (source) msg.sourceVariable = source;
  const atol = optNum("cmp-atol");
  if (atol !== undefined && atol > 0) msg.atol = atol;
  const rtol = optNum("cmp-rtol");
  if (rtol !== undefined && rtol > 0) msg.rtol = rtol;
  const output = optStr("cmp-output");
  if (output) msg.output = output;
  return msg;
}

// --- shrinkwrap / Sobolev deformation (meshio++ coordinate oracles) ------------

function buildShrinkwrapMsg(): Record<string, unknown> | undefined {
  const part = (document.getElementById("sw-target") as HTMLSelectElement | null)?.value ?? "";
  if (!swPath && !part) return undefined;
  const msg: Record<string, unknown> = swPath
    ? { type: "applyOp", op: "shrinkwrap", path: swPath }
    : part === SDF_SKIN
      ? { type: "applyOp", op: "shrinkwrap", skin: true }
      : { type: "applyOp", op: "shrinkwrap", part };
  const offset = optNum("sw-offset");
  if (offset !== undefined && offset !== 0) msg.offset = offset;
  const maxDistance = optNum("sw-maxdist");
  if (maxDistance !== undefined && maxDistance > 0) msg.maxDistance = maxDistance;
  const blend = optNum("sw-blend");
  if (blend !== undefined && blend !== 1) msg.blend = blend;
  const move = (document.getElementById("sw-move") as HTMLSelectElement | null)?.value;
  if (move) msg.movePart = move;
  const pin = (document.getElementById("sw-pin") as HTMLSelectElement | null)?.value;
  if (pin) msg.pinPart = pin;
  if (checked("sw-record")) msg.recordDistance = true;
  return msg;
}

function buildSobolevMsg(): Record<string, unknown> | undefined {
  const variable = (document.getElementById("sob-variable") as HTMLSelectElement | null)?.value ?? "";
  const lengthScale = optNum("sob-length");
  if (!variable || lengthScale === undefined || lengthScale < 0) return undefined;
  const msg: Record<string, unknown> = { type: "applyOp", op: "sobolevDeform", variable, lengthScale };
  const fixed = (document.getElementById("sob-fixed") as HTMLSelectElement | null)?.value;
  if (fixed) msg.fixedPart = fixed;
  if (checked("sob-boundary")) msg.fixBoundary = true;
  const iter = optNum("sob-iter");
  if (iter !== undefined && iter >= 1) msg.maxIterations = Math.floor(iter);
  return msg;
}

// --- surface / volume meshing (meshio++ results, adopted) ------------------------

function buildSurfaceRemeshMsg(): Record<string, unknown> | undefined {
  const metric = (document.getElementById("sr-metric") as HTMLSelectElement | null)?.value ?? "isotropic";
  const msg: Record<string, unknown> = { type: "applyOp", op: "surfaceRemesh", metric, preserveBoundary: checked("sr-boundary") };
  const clusters = optNum("sr-clusters");
  if (clusters !== undefined) {
    if (!(clusters >= 4)) return undefined;
    msg.numClusters = Math.floor(clusters);
  }
  const gradation = optNum("sr-gradation");
  if (gradation !== undefined && gradation > 0) msg.gradation = gradation;
  if (metric === "anisotropic") {
    const stretch = optNum("sr-aniso");
    if (stretch !== undefined) msg.maxAnisotropy = stretch;
  }
  return msg;
}

function buildVolumeMeshMsg(): Record<string, unknown> | undefined {
  const cellSize = optNum("vm-cellsize");
  if (cellSize === undefined || !(cellSize > 0)) return undefined;
  const msg: Record<string, unknown> = { type: "applyOp", op: "volumeMesh", cellSize, keepSurface: checked("vm-surface") };
  const warp = optNum("vm-warp");
  if (warp !== undefined) msg.warpFraction = warp;
  return msg;
}

function buildOptimizeVolumeMsg(): Record<string, unknown> | undefined {
  const iter = optNum("ov-iter") ?? 10;
  if (!(iter >= 1)) return undefined;
  return {
    type: "applyOp",
    op: "optimizeVolume",
    flip: checked("ov-flip"),
    relocate: checked("ov-relocate"),
    preserveBoundary: checked("ov-boundary"),
    maxIterations: Math.floor(iter),
  };
}

/** The anisotropic stretch limit only means something for the anisotropic metric. */
function updateSurfaceRemeshUI(): void {
  const metric = (document.getElementById("sr-metric") as HTMLSelectElement | null)?.value ?? "isotropic";
  document.getElementById("sr-aniso-field")?.classList.toggle("hidden", metric !== "anisotropic");
}

// --- surface curvature (meshio++ oracle) --------------------------------------

function buildCurvatureMsg(): Record<string, unknown> | undefined {
  const mean = checked("curv-mean");
  const gaussian = checked("curv-gauss");
  const principal = checked("curv-principal");
  const area = checked("curv-area");
  if (!mean && !gaussian && !principal && !area) return undefined;
  const msg: Record<string, unknown> = {
    type: "applyOp",
    op: "curvature",
    mean,
    gaussian,
    principal,
    area,
    dualArea: (document.getElementById("curv-dual") as HTMLSelectElement | null)?.value ?? "mixed-voronoi",
    includeBoundary: checked("curv-boundary"),
  };
  const prefix = optStr("curv-prefix");
  if (prefix) msg.outputPrefix = prefix;
  return msg;
}

// --- repair surface (meshio++ result, adopted) -------------------------------

function buildRepairSurfaceMsg(): Record<string, unknown> | undefined {
  const maxHoleEdges = optNum("repair-maxhole") ?? 10;
  const weldTolerance = optNum("repair-weld") ?? 0;
  if (!(maxHoleEdges >= 3) || weldTolerance < 0) return undefined;
  return {
    type: "applyOp",
    op: "repairSurface",
    fixOrientation: checked("repair-orientation"),
    orientOutward: checked("repair-outward"),
    fillHoles: checked("repair-fill"),
    splitNonManifold: checked("repair-split"),
    maxHoleEdges: Math.floor(maxHoleEdges),
    weldTolerance,
  };
}

// --- smooth / reorder / partition (meshio++ oracle ops) ---------------------

function buildSmoothMsg(): Record<string, unknown> | undefined {
  const method =
    (document.getElementById("smooth-method") as HTMLSelectElement | null)?.value ?? "taubin";
  const iterations = optNum("smooth-iterations") ?? 10;
  if (!(iterations > 0)) return undefined;
  const msg: Record<string, unknown> = { type: "applyOp", op: "smooth", method, iterations };
  const lambda = optNum("smooth-lambda");
  if (lambda !== undefined) msg.lambda = lambda;
  const mu = optNum("smooth-mu");
  if (mu !== undefined) msg.mu = mu;
  const angle = optNum("smooth-angle");
  if (angle !== undefined) msg.featureAngle = angle;
  msg.fixBoundary = checked("smooth-fixboundary");
  msg.preserveFeatures = checked("smooth-features");
  msg.guardInversion = checked("smooth-guard");
  return msg;
}

function buildReorderMsg(): Record<string, unknown> | undefined {
  const method =
    (document.getElementById("reorder-method") as HTMLSelectElement | null)?.value ?? "rcm";
  return { type: "applyOp", op: "reorder", method };
}

function buildPartitionMsg(): Record<string, unknown> | undefined {
  const nparts = optNum("partition-nparts") ?? 2;
  if (!(nparts >= 1)) return undefined;
  const msg: Record<string, unknown> = {
    type: "applyOp",
    op: "partition",
    nparts: Math.floor(nparts),
  };
  if (checked("partition-createparts")) msg.createParts = true;
  return msg;
}

// --- merge mesh (async: reads other files, chosen via a host file dialog) ----

/**
 * The files the host's dialog returned. Held here rather than round-tripped
 * through the readonly text field, which is a DISPLAY of the selection (it
 * summarises when there are several) and not its storage.
 */
let mergePaths: string[] = [];

function buildMergeMeshMsg(): Record<string, unknown> | undefined {
  if (mergePaths.length === 0) return undefined;
  const msg: Record<string, unknown> = { type: "applyOp", op: "mergeMesh", paths: mergePaths };
  if (checked("merge-weld")) {
    msg.weld = true;
    const tol = optNum("merge-tolerance");
    if (tol !== undefined) msg.tolerance = tol;
  }
  const name = optStr("merge-name");
  if (name) msg.name = name;
  return msg;
}

/** Trailing path segment, for the summary line (the webview has no path module). */
function baseName(p: string): string {
  const cut = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return cut >= 0 ? p.slice(cut + 1) : p;
}

/**
 * Records the merge-mesh selection from the host's `mergeMeshPicked` reply to
 * this module's `pickMeshFile` request. Called from webview/main.ts's message
 * switch (mirroring how `ptStatus`/`opProgress` route a host message here).
 *
 * Several files merge in ONE operation, so the field summarises rather than
 * listing; the full selection stays one hover away in the tooltip.
 */
export function setMergeMeshPaths(paths: string[], target = "mergeMesh"): void {
  const clean = paths.filter((p) => typeof p === "string" && p.length > 0);
  // The three single-file forms store their own path and show its base name;
  // only the merge form has an N-file summary to render.
  if (target !== "mergeMesh") {
    const id =
      target === "sdfDistance" ? "sdf-path" : target === "shrinkwrap" ? "sw-path" : target === "compareField" ? "cmp-path" : "xfer-path";
    const single = document.getElementById(id) as HTMLInputElement | null;
    if (!single) return;
    if (target === "compareField") {
      cmpPath = clean[0] ?? "";
    } else if (target === "shrinkwrap") {
      swPath = clean[0] ?? "";
      if (swPath) {
        const partSelect = document.getElementById("sw-target") as HTMLSelectElement | null;
        if (partSelect) partSelect.value = "";
      }
    } else if (target === "sdfDistance") {
      sdfPath = clean[0] ?? "";
      // A file was actually picked — clear the mutually-exclusive
      // SubModelPart selection, the reverse of #sdf-part's own change handler.
      if (sdfPath) {
        const partSelect = document.getElementById("sdf-part") as HTMLSelectElement | null;
        if (partSelect) partSelect.value = "";
      }
    } else xferPath = clean[0] ?? "";
    single.value = clean[0] ? baseName(clean[0]) : "";
    single.title = clean[0] ?? "";
    return;
  }
  mergePaths = clean;
  const input = document.getElementById("merge-path") as HTMLInputElement | null;
  if (!input) return;
  if (mergePaths.length === 0) {
    input.value = "";
    input.title = "";
  } else if (mergePaths.length === 1) {
    input.value = baseName(mergePaths[0]);
    input.title = mergePaths[0];
  } else {
    const names = mergePaths.map(baseName);
    const shown = names.slice(0, 2).join(", ");
    input.value = `${mergePaths.length} files: ${shown}${names.length > 2 ? ", …" : ""}`;
    input.title = mergePaths.join("\n");
  }
}

// --- renumber (sync) --------------------------------------------------------

function buildRenumberMsg(): Record<string, unknown> | undefined {
  const target =
    (document.getElementById("renumber-target") as HTMLSelectElement | null)?.value ?? "all";
  const msg: Record<string, unknown> = { type: "applyOp", op: "renumber", target };
  const start = optNum("renumber-start");
  if (start !== undefined && Number.isInteger(start) && start >= 1) msg.start = start;
  return msg;
}
