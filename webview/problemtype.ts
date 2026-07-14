/**
 * Problemtype sidebar wiring for the webview. The static skeleton lives in
 * src/webviewChrome.ts (SIDEBAR_HTML, `#pt-*` ids); everything inside is built
 * dynamically from the declarative specs the host posts (`ptCatalog`), because
 * forms depend on which problemtype is selected.
 *
 * The module owns the working CaseState: every input change updates it and
 * posts a debounced `ptState` so the host persists `<stem>.kratoscase.json`.
 * Generate / Run / Open-results are plain command messages (`ptGenerate`,
 * `ptRun`, `ptOpenResults`); the host answers with `ptStatus`.
 *
 * All text from problemtype declarations is set via textContent — user
 * problemtypes are untrusted strings and must never reach innerHTML.
 */

import {
  Assignment,
  CaseState,
  ConditionSpec,
  FieldSpec,
  JsonValue,
  MaterialAssignment,
  ProblemtypeDeclaration,
} from "../src/problemtype/types";
import { defaultCaseState, fieldDefault } from "../src/problemtype/api";
import { TOOLBAR_ICONS, ToolbarIconId } from "../src/toolbarIcons";
import { hideFlowgraphPane } from "./flowgraphPane";

type PostMessage = (msg: unknown) => void;

interface CatalogEntry {
  decl?: ProblemtypeDeclaration;
  source: "builtin" | "js" | "py";
  error?: string;
  fileName?: string;
}

let post: PostMessage = () => {};
let catalog: CatalogEntry[] = [];
let state: CaseState | undefined;
let smpPaths: string[] = [];
let sendDebounce: ReturnType<typeof setTimeout> | undefined;
/** True while the Flowgraph view has taken over the viewport (see render()). */
let flowgraphActive = false;

const el = <T extends HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

function currentDecl(): ProblemtypeDeclaration | undefined {
  return catalog.find((e) => e.decl && e.decl.id === state?.problemtypeId)?.decl;
}

/** Posts the working state (debounced) so the host persists the case file. */
function scheduleSend(): void {
  if (sendDebounce) clearTimeout(sendDebounce);
  sendDebounce = setTimeout(sendStateNow, 300);
}

function sendStateNow(): void {
  if (sendDebounce) clearTimeout(sendDebounce);
  sendDebounce = undefined;
  if (state) post({ type: "ptState", state });
}

/** Wires the static skeleton. Safe to call once after the DOM is ready. */
export function initProblemtype(postMessage: PostMessage): void {
  post = postMessage;
  el<HTMLSelectElement>("pt-select")?.addEventListener("change", () => {
    const id = el<HTMLSelectElement>("pt-select")?.value ?? "";
    const decl = catalog.find((e) => e.decl?.id === id)?.decl;
    if (!decl) return;
    if (!state || state.problemtypeId !== decl.id) {
      state = defaultCaseState(decl);
      sendStateNow();
    }
    render();
  });
  const action = (id: string, type: string): void => {
    el(id)?.addEventListener("click", () => {
      sendStateNow(); // flush pending edits so the host generates what's on screen
      post({ type });
    });
  };
  action("pt-generate", "ptGenerate");
  action("pt-run", "ptRun");
  action("pt-open-results", "ptOpenResults");
}

/** Populates the problemtype dropdown from the host's `ptCatalog` message. */
export function setProblemtypeCatalog(entries: CatalogEntry[]): void {
  catalog = entries;
  const section = el("pt-section");
  if (section) section.hidden = false;
  const select = el<HTMLSelectElement>("pt-select");
  if (!select) return;
  select.textContent = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "— select a problemtype —";
  select.appendChild(placeholder);
  for (const e of entries) {
    const opt = document.createElement("option");
    if (e.decl) {
      opt.value = e.decl.id;
      opt.textContent = e.source === "builtin" ? e.decl.name : `${e.decl.name} (${e.source})`;
      if (e.decl.description) opt.title = e.decl.description;
    } else {
      opt.value = "";
      opt.disabled = true;
      opt.textContent = `${e.fileName ?? "?"}: failed to load`;
      if (e.error) opt.title = e.error;
    }
    select.appendChild(opt);
  }
  if (state && catalog.some((e) => e.decl?.id === state?.problemtypeId)) {
    select.value = state.problemtypeId;
  }
  render();
}

/** Adopts the saved case restored by the host (`ptCase`). */
export function setProblemtypeCase(saved: CaseState | undefined): void {
  if (!saved) return;
  state = saved;
  const select = el<HTMLSelectElement>("pt-select");
  if (select && catalog.some((e) => e.decl?.id === saved.problemtypeId)) {
    select.value = saved.problemtypeId;
  }
  render();
}

/** Refreshes the SubModelPart pickers from the current model's outline tree. */
export function setProblemtypeModel(parts: { path: string; children: unknown[] }[]): void {
  const paths: string[] = [];
  const walk = (p: { path: string; children: unknown[] }): void => {
    paths.push(p.path);
    (p.children as { path: string; children: unknown[] }[]).forEach(walk);
  };
  parts.forEach(walk);
  smpPaths = paths;
  render();
}

/** Renders the host's `ptStatus` feedback under the action buttons. */
export function setProblemtypeStatus(status: {
  kind: string;
  files?: string[];
  message?: string;
}): void {
  const box = el("pt-status");
  if (!box) return;
  box.classList.remove("error");
  if (status.kind === "generated") {
    box.textContent = `Generated ${status.files?.join(", ") ?? "case files"}.`;
  } else if (status.kind === "running") {
    box.textContent = `Running in terminal "${status.message ?? ""}"…`;
  } else if (status.kind === "error") {
    box.textContent = status.message ?? "Failed.";
    box.classList.add("error");
  } else {
    box.textContent = "";
  }
}

// --- rendering -------------------------------------------------------------

function render(): void {
  const body = el("pt-body");
  if (!body) return;
  const decl = currentDecl();
  // The Flowgraph problemtype has no forms: it embeds the node editor in a
  // split pane (see webview/flowgraphPane.ts). Request it once on entry and
  // release it when switching to any other problemtype.
  if (decl && state && decl.view === "flowgraph") {
    body.classList.add("hidden");
    if (!flowgraphActive) {
      flowgraphActive = true;
      post({ type: "flowgraphStart" });
    }
    return;
  }
  if (flowgraphActive) {
    flowgraphActive = false;
    hideFlowgraphPane();
  }
  body.classList.toggle("hidden", !decl || !state);
  if (!decl || !state) return;
  renderSections(decl);
  renderAssignments(decl);
  renderMaterials(decl);
  renderOutput();
}

/** A collapsible `.edit-form` block with a title row (same look as Edit forms). */
function formBlock(
  title: string,
  collapsed: boolean,
  icon?: ToolbarIconId
): { form: HTMLElement; body: HTMLElement } {
  const form = document.createElement("div");
  form.className = "edit-form" + (collapsed ? " collapsed" : "");
  const titleBtn = document.createElement("button");
  titleBtn.type = "button";
  titleBtn.className = "edit-form-title";
  const chevron = document.createElement("span");
  chevron.className = "sb-chevron";
  const label = document.createElement("span");
  label.textContent = title;
  if (icon) {
    // Generated, trusted markup (src/toolbarIcons.ts) — never user strings.
    const iconSpan = document.createElement("span");
    iconSpan.className = "toolbar-icon";
    iconSpan.innerHTML = TOOLBAR_ICONS[icon];
    titleBtn.append(chevron, iconSpan, label);
  } else {
    titleBtn.append(chevron, label);
  }
  titleBtn.addEventListener("click", () => form.classList.toggle("collapsed"));
  const body = document.createElement("div");
  body.className = "pt-form-body";
  form.append(titleBtn, body);
  return { form, body };
}

/** Builds the input element(s) for one field spec. */
function fieldInput(
  f: FieldSpec,
  value: JsonValue,
  onChange: (v: JsonValue) => void
): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "edit-field pt-field";
  wrap.dataset.field = f.id;
  if (f.help) wrap.title = f.help;
  const caption = document.createElement("span");
  caption.textContent = f.label;
  wrap.appendChild(caption);
  if (f.type === "enum") {
    const select = document.createElement("select");
    select.className = "edit-sel edit-sel-grow";
    for (const o of f.options ?? []) {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label ?? o.value;
      select.appendChild(opt);
    }
    select.value = String(value);
    select.addEventListener("change", () => onChange(select.value));
    wrap.appendChild(select);
  } else if (f.type === "bool") {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = value === true;
    input.addEventListener("change", () => onChange(input.checked));
    wrap.className = "edit-check pt-field";
    wrap.insertBefore(input, caption);
  } else if (f.type === "vector3") {
    const vec = Array.isArray(value) ? [...value] : [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const input = document.createElement("input");
      input.type = "number";
      input.className = "edit-num";
      input.step = "0.1";
      input.value = String(vec[i] ?? 0);
      input.addEventListener("change", () => {
        vec[i] = Number(input.value) || 0;
        onChange([...vec] as JsonValue);
      });
      wrap.appendChild(input);
    }
  } else {
    const input = document.createElement("input");
    input.className = "edit-num edit-num-wide";
    input.type = f.type === "string" ? "text" : "number";
    if (f.type === "int") input.step = "1";
    input.value = String(value ?? "");
    input.addEventListener("change", () => {
      onChange(f.type === "string" ? input.value : Number(input.value) || 0);
    });
    wrap.appendChild(input);
  }
  return wrap;
}

/** Applies visibleWhen rules within one form body. */
function applyVisibility(body: HTMLElement, fields: FieldSpec[], values: Record<string, JsonValue>): void {
  for (const f of fields) {
    if (!f.visibleWhen) continue;
    const row = body.querySelector<HTMLElement>(`[data-field="${f.id}"]`);
    if (row) row.style.display = values[f.visibleWhen.field] === f.visibleWhen.equals ? "" : "none";
  }
}

function renderSections(decl: ProblemtypeDeclaration): void {
  const host = el("pt-forms");
  if (!host || !state) return;
  host.textContent = "";
  // The problemtype's own logo when it names a known icon (e.g. ptStructural).
  const logo: ToolbarIconId =
    decl.icon && decl.icon in TOOLBAR_ICONS ? (decl.icon as ToolbarIconId) : "problemtype";
  decl.sections.forEach((s, si) => {
    const { form, body } = formBlock(s.label, si > 0, logo);
    const values = (state!.values[s.id] ??= {});
    for (const f of s.fields) {
      if (values[f.id] === undefined) values[f.id] = fieldDefault(f);
      body.appendChild(
        fieldInput(f, values[f.id], (v) => {
          values[f.id] = v;
          applyVisibility(body, s.fields, values);
          scheduleSend();
        })
      );
    }
    applyVisibility(body, s.fields, values);
    host.appendChild(form);
  });
}

/** The "condition × SubModelPart" add-row shared by assignments and materials. */
function addRow(
  choices: { value: string; label: string }[],
  buttonTitle: string,
  onAdd: (choice: string, smpPath: string) => void
): HTMLElement {
  const row = document.createElement("div");
  row.className = "pt-add-row";
  const what = document.createElement("select");
  what.className = "edit-sel pt-add-what";
  for (const c of choices) {
    const opt = document.createElement("option");
    opt.value = c.value;
    opt.textContent = c.label;
    what.appendChild(opt);
  }
  const where = document.createElement("select");
  where.className = "edit-sel pt-add-where";
  if (smpPaths.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "no SubModelParts";
    where.appendChild(opt);
    where.disabled = true;
  }
  for (const p of smpPaths) {
    const opt = document.createElement("option");
    opt.value = p;
    opt.textContent = p;
    where.appendChild(opt);
  }
  const add = document.createElement("button");
  add.type = "button";
  add.className = "edit-apply";
  add.textContent = "+";
  add.title = buttonTitle;
  add.disabled = smpPaths.length === 0 || choices.length === 0;
  add.addEventListener("click", () => {
    if (what.value !== undefined && where.value) onAdd(what.value, where.value);
  });
  row.append(what, where, add);
  return row;
}

/** One applied assignment/material row: header (label · path · ×) + its fields. */
function appliedRow(
  title: string,
  smpPath: string,
  fields: FieldSpec[],
  values: Record<string, JsonValue>,
  onDelete: () => void
): HTMLElement {
  const box = document.createElement("div");
  box.className = "pt-assign";
  const head = document.createElement("div");
  head.className = "pt-assign-head";
  const label = document.createElement("span");
  label.className = "pt-assign-label";
  label.textContent = title;
  const path = document.createElement("span");
  path.className = "pt-assign-path";
  path.textContent = smpPath;
  path.title = smpPath;
  if (smpPaths.length > 0 && !smpPaths.includes(smpPath)) {
    path.classList.add("missing");
    path.title = `${smpPath} — not in the current mesh`;
  }
  const del = document.createElement("button");
  del.type = "button";
  del.className = "pt-assign-del";
  del.textContent = "×";
  del.title = "Remove";
  del.addEventListener("click", onDelete);
  head.append(label, path, del);
  box.appendChild(head);
  for (const f of fields) {
    if (values[f.id] === undefined) values[f.id] = fieldDefault(f);
    box.appendChild(
      fieldInput(f, values[f.id], (v) => {
        values[f.id] = v;
        scheduleSend();
      })
    );
  }
  return box;
}

function renderAssignments(decl: ProblemtypeDeclaration): void {
  const host = el("pt-assignments");
  if (!host || !state) return;
  host.textContent = "";
  const { form, body } = formBlock("Conditions", false, "condition");
  body.appendChild(
    addRow(
      decl.conditions.map((c) => ({ value: c.id, label: c.label })),
      "Assign the condition to the SubModelPart",
      (conditionId, smpPath) => {
        state!.assignments.push({ conditionId, smpPath, values: {} });
        scheduleSend();
        render();
      }
    )
  );
  state.assignments.forEach((a: Assignment, i: number) => {
    const cond = decl.conditions.find((c) => c.id === a.conditionId);
    body.appendChild(
      appliedRow(cond?.label ?? a.conditionId, a.smpPath, cond?.fields ?? [], a.values, () => {
        state!.assignments.splice(i, 1);
        scheduleSend();
        render();
      })
    );
  });
  host.appendChild(form);
}

function renderMaterials(decl: ProblemtypeDeclaration): void {
  const host = el("pt-materials");
  if (!host || !state) return;
  host.textContent = "";
  if (decl.materialLaws.length === 0) return;
  const { form, body } = formBlock("Materials", false, "material");
  body.appendChild(
    addRow(
      decl.materialLaws.map((l) => ({ value: l.id, label: l.name || l.id })),
      "Assign the material to the SubModelPart",
      (lawId, smpPath) => {
        state!.materials.push({ smpPath, lawId, values: {} });
        scheduleSend();
        render();
      }
    )
  );
  state.materials.forEach((m: MaterialAssignment, i: number) => {
    const law = decl.materialLaws.find((l) => l.id === m.lawId);
    body.appendChild(
      appliedRow(law?.name || m.lawId, m.smpPath, law?.variables ?? [], m.values, () => {
        state!.materials.splice(i, 1);
        scheduleSend();
        render();
      })
    );
  });
  host.appendChild(form);
}

function renderOutput(): void {
  const host = el("pt-output");
  if (!host || !state) return;
  host.textContent = "";
  const { form, body } = formBlock("Output (VTK)", true, "field");
  const out = state.output;
  body.appendChild(
    fieldInput(
      {
        id: "format",
        label: "format",
        type: "enum",
        options: [{ value: "ascii" }, { value: "binary" }],
      },
      out.format,
      (v) => {
        out.format = v === "binary" ? "binary" : "ascii";
        scheduleSend();
      }
    )
  );
  body.appendChild(
    fieldInput(
      {
        id: "controlType",
        label: "control",
        type: "enum",
        options: [
          { value: "step", label: "every N steps" },
          { value: "time", label: "every Δt" },
        ],
      },
      out.controlType,
      (v) => {
        out.controlType = v === "time" ? "time" : "step";
        scheduleSend();
      }
    )
  );
  body.appendChild(
    fieldInput({ id: "interval", label: "interval", type: "number" }, out.interval, (v) => {
      out.interval = Number(v) > 0 ? Number(v) : 1;
      scheduleSend();
    })
  );
  body.appendChild(
    fieldInput(
      { id: "nodalVariables", label: "nodal vars", type: "string", help: "Comma-separated Kratos variable names written to vtk_output" },
      out.nodalVariables.join(", "),
      (v) => {
        out.nodalVariables = String(v)
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        scheduleSend();
      }
    )
  );
  host.appendChild(form);
}
