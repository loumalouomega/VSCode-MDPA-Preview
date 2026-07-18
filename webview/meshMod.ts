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

  // The MMG apply buttons run the op (play) or cancel the in-flight run (stop).
  document
    .querySelector<HTMLButtonElement>('.edit-apply[data-op="remesh"]')
    ?.addEventListener("click", () => {
      if (mmgRunning) {
        postMessage({ type: "opCancel" });
        return;
      }
      const msg = buildRemeshMsg();
      if (msg) postMessage(msg);
    });
  document
    .querySelector<HTMLButtonElement>('.edit-apply[data-op="levelset"]')
    ?.addEventListener("click", () => {
      if (mmgRunning) {
        postMessage({ type: "opCancel" });
        return;
      }
      const msg = buildLevelsetMsg();
      if (msg) postMessage(msg);
    });
}

let mmgRunning = false;

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
  mmgRunning = state.running;
  const target = state.op === "levelset" ? "ls-progress" : "remesh-progress";
  for (const id of ["remesh-progress", "ls-progress"]) {
    const box = document.getElementById(id);
    if (!box) continue;
    const active = state.running && id === target;
    box.classList.toggle("hidden", !active);
    if (active && state.message) {
      const msg = box.querySelector<HTMLElement>(".edit-progress-msg");
      if (msg) {
        msg.textContent = state.message;
        msg.title = state.message;
      }
    }
  }
  for (const op of ["remesh", "levelset"]) {
    const btn = document.querySelector<HTMLButtonElement>(`.edit-apply[data-op="${op}"]`);
    if (!btn) continue;
    const isTrigger = state.running && state.op === op;
    btn.classList.toggle("running", isTrigger);
    btn.title = isTrigger
      ? "Cancel the running operation"
      : op === "remesh"
        ? "Run the MMG remesher"
        : "Discretize the isovalue as a mesh boundary";
    // The other MMG button is inert while a run is live (host guards too); at
    // rest the level-set button stays disabled when the model has no fields.
    const lsUnavailable =
      op === "levelset" &&
      (document.getElementById("ls-variable") as HTMLSelectElement | null)?.disabled === true;
    btn.disabled = state.running ? !isTrigger : lsUnavailable;
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
 * (Re)populates the level-set field select from the current model's nodal
 * fields and enables/disables the form accordingly. Called by main.ts on every
 * `model` / `vtkFrame` message.
 */
export function setMeshModFields(
  fields: { kind: string; variable: string; components: number }[]
): void {
  const select = document.getElementById("ls-variable") as HTMLSelectElement | null;
  const form = document.getElementById("ls-form");
  if (!select || !form) return;
  const nodal = fields.filter((f) => f.kind === "Nodal");
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
