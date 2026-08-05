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

import { validateSizeExpr } from "../src/parser/sizeExpr";

type PostMessage = (msg: unknown) => void;

/** Current model's SubModelPart paths (for the per-part sizing dropdowns). */
let smpPaths: string[] = [];
/** The per-SubModelPart sizing overrides currently entered in the form. */
let sizeParts: { path: string; expr: string }[] = [];

/** Wires the Mesh Modification buttons. Safe to call once after the DOM is ready. */
export function initMeshMod(postMessage: PostMessage): void {
  const quadratic = document.getElementById("mesh-mod-quadratic");
  quadratic?.addEventListener("click", () => {
    postMessage({ type: "applyOp", op: "linearToQuadratic" });
  });
  document.getElementById("mesh-mod-linearize")?.addEventListener("click", () => {
    postMessage({ type: "applyOp", op: "linearize" });
  });
  document.getElementById("mesh-mod-simplexify")?.addEventListener("click", () => {
    postMessage({ type: "applyOp", op: "simplexify" });
  });

  // Crop: the box/plane input rows toggle with the "by" select.
  const cropKind = document.getElementById("crop-kind") as HTMLSelectElement | null;
  cropKind?.addEventListener("change", updateCropKindUI);
  updateCropKindUI();

  // Every plain (synchronous) apply button not covered by a dedicated
  // handler above/below: read its form's inputs, post if valid.
  const SYNC_BUILDERS: Record<string, () => Record<string, unknown> | undefined> = {
    setElementRadius: buildRadiusMsg,
    renumber: buildRenumberMsg,
    refine: buildRefineMsg,
    crop: buildCropMsg,
    fieldCalc: buildFieldCalcMsg,
    averageField: buildAverageFieldMsg,
  };
  for (const [op, build] of Object.entries(SYNC_BUILDERS)) {
    document.querySelector<HTMLButtonElement>(`.edit-apply[data-op="${op}"]`)?.addEventListener(
      "click",
      () => {
        const msg = build();
        if (msg) postMessage(msg);
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
  document.getElementById("merge-browse")?.addEventListener("click", () => {
    postMessage({ type: "pickMeshFile" });
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

  // Async apply buttons run the op (play) or cancel the in-flight run (stop).
  // Wired from the DOM + ASYNC_BUILDERS rather than one hand-written listener
  // per op, so adding an async operation is a markup line plus a builder entry.
  for (const btn of asyncApplyButtons()) {
    const op = btn.dataset.op;
    const build = op ? ASYNC_BUILDERS[op] : undefined;
    if (!build) continue;
    btn.addEventListener("click", () => {
      if (opRunning) {
        postMessage({ type: "opCancel" });
        return;
      }
      const msg = build();
      if (msg) postMessage(msg);
    });
  }

  // Set element radius — a plain synchronous op, so an ordinary apply button
  // (no play/stop, no progress bar).
  const applyRadius = (): void => {
    const msg = buildRadiusMsg();
    if (msg) postMessage(msg);
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
  smooth: buildSmoothMsg,
  reorder: buildReorderMsg,
  partition: buildPartitionMsg,
  mergeMesh: buildMergeMeshMsg,
  fieldGradient: buildFieldGradientMsg,
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

/** Shows/hides the numeric value field, the expression block, and the value label per mode. */
function updateRemeshModeUI(): void {
  const m = (document.getElementById("remesh-mode") as HTMLSelectElement | null)?.value ?? "factor";
  const valueField = document.getElementById("remesh-value-field");
  const valueLabel = document.getElementById("remesh-value-label");
  const exprBlock = document.getElementById("remesh-expr-block");
  if (valueLabel) valueLabel.textContent = m === "hsiz" ? "size" : "factor";
  // The numeric value only matters for factor/hsiz; expr and optimize hide it.
  valueField?.classList.toggle("hidden", m === "optimize" || m === "expr");
  exprBlock?.classList.toggle("hidden", m !== "expr");
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
  const global = document.getElementById("remesh-sizeexpr") as HTMLInputElement | null;
  const errBox = document.getElementById("remesh-sizeexpr-error");
  const globalErr = global ? validateSizeExpr(global.value.trim() || "0.5*h") : undefined;
  global?.classList.toggle("invalid", globalErr !== undefined);
  if (errBox) {
    errBox.textContent = globalErr ?? "";
    errBox.classList.toggle("hidden", globalErr === undefined);
  }
  if (globalErr) ok = false;
  document.querySelectorAll<HTMLInputElement>(".edit-sizepart-expr").forEach((input) => {
    const err = validateSizeExpr(input.value.trim());
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

function buildLevelsetMsg(): Record<string, unknown> | undefined {
  const variable = (document.getElementById("ls-variable") as HTMLSelectElement | null)?.value;
  if (!variable) return undefined;
  const msg: Record<string, unknown> = { type: "applyOp", op: "levelset", variable };
  const iso = optNum("ls-isovalue");
  if (iso !== undefined && iso !== 0) msg.isovalue = iso;
  if (checked("ls-isosurf")) msg.isosurf = true;
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
  fields: { kind: string; variable: string; components: number }[]
): void {
  const nodal = fields.filter((f) => f.kind === "Nodal");
  fillNodalSelect("grad-variable", nodal, (f) =>
    f.components > 1 ? `${f.variable} (${f.components})` : f.variable
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
 */
function fillNodalSelect(
  id: string,
  nodal: { variable: string; components: number }[],
  label: (f: { variable: string; components: number }) => string
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
  select
    .closest(".edit-form")
    ?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
      "input, select, .edit-apply"
    )
    .forEach((el) => {
      if (el !== select) el.disabled = empty;
    });
}

// --- refine / crop / field calculator / average / gradient ------------------

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
  return levels > 0 ? { type: "applyOp", op: "refine", levels: Math.floor(levels) } : undefined;
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
export function setMergeMeshPaths(paths: string[]): void {
  mergePaths = paths.filter((p) => typeof p === "string" && p.length > 0);
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
