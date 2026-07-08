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

type PostMessage = (msg: unknown) => void;

/** Wires the Mesh Modification buttons. Safe to call once after the DOM is ready. */
export function initMeshMod(postMessage: PostMessage): void {
  const quadratic = document.getElementById("mesh-mod-quadratic");
  quadratic?.addEventListener("click", () => {
    postMessage({ type: "applyOp", op: "linearToQuadratic" });
  });

  // The remesh value field means "factor" or "size" depending on the mode and
  // is meaningless for the optimize-only pass.
  const mode = document.getElementById("remesh-mode") as HTMLSelectElement | null;
  const value = document.getElementById("remesh-value") as HTMLInputElement | null;
  const valueLabel = document.getElementById("remesh-value-label");
  mode?.addEventListener("change", () => {
    const m = mode.value;
    if (valueLabel) valueLabel.textContent = m === "hsiz" ? "size" : "factor";
    if (value) value.disabled = m === "optimize";
  });

  // The MMG apply buttons run the op (play) or cancel the in-flight run (stop).
  document
    .querySelector<HTMLButtonElement>('.edit-apply[data-op="remesh"]')
    ?.addEventListener("click", () => {
      if (mmgRunning) postMessage({ type: "opCancel" });
      else postMessage(buildRemeshMsg());
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

function buildRemeshMsg(): Record<string, unknown> {
  const mode =
    (document.getElementById("remesh-mode") as HTMLSelectElement | null)?.value ?? "factor";
  const msg: Record<string, unknown> = { type: "applyOp", op: "remesh", mode };
  const value = optNum("remesh-value");
  if (mode === "factor") msg.factor = value ?? 1;
  if (mode === "hsiz") msg.hsiz = value;
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
