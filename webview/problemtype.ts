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
  CollectionEntry,
  CollectionSpec,
  ConditionSpec,
  FieldSpec,
  JsonValue,
  MaterialAssignment,
  MaterialLawSpec,
  ProblemtypeDeclaration,
} from "../src/problemtype/types";
import { defaultCaseState, fieldDefault, flattenValues } from "../src/problemtype/api";
import {
  collectionProblems,
  entriesOf,
  entryTypeOf,
  formatListValue,
  isValidEntryName,
  newEntry,
  parseListText,
  renameEntry,
  uniqueEntryName,
} from "../src/problemtype/collections";
import { caseValueAddresses } from "../src/problemtype/caseAddress";
import {
  catalogGroups,
  countByCategory,
  groupConditions,
  groupSectionFields,
  isFieldVisible,
  partsConditions,
  summaryChips,
} from "../src/problemtype/layout";
import {
  MaterialPreset,
  describeReference,
  findPreset,
  presetDrift,
  presetsForLaw,
  resolvePresetValues,
  snapshotOf,
  validateMaterialAssignment,
} from "../src/problemtype/materialCatalog";
import { hideFlowgraphPane } from "./flowgraphPane";
import {
  cardBlock,
  groupBlock,
  headerCard,
  iconSpan,
  isIconId,
  stageCaption,
} from "./problemtypeUi";

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
/** The material preset catalog, posted by the host (`ptPresets`). */
let presets: MaterialPreset[] = [];
/** Library files that could not be read — reported, never silently dropped. */
let presetProblems: { file: string; message: string }[] = [];
/** The Materials form's preset search text, kept across re-renders. */
let presetFilter = "";
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
  // Run doubles as Stop, so its message depends on the current mode.
  el("pt-run")?.addEventListener("click", () => {
    const mode = (el("pt-run") as HTMLElement | null)?.dataset.mode;
    if (mode === "stop") {
      post({ type: "ptStop" });
      return;
    }
    sendStateNow();
    post({ type: "ptRun" });
  });
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
  const optionFor = (e: CatalogEntry): HTMLOptionElement => {
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
    return opt;
  };
  // One <optgroup> per family (solids, fluids, coupled…), so a catalog of a
  // dozen problemtypes reads as groups rather than one undifferentiated list.
  for (const group of catalogGroups(entries)) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.label;
    for (const i of group.indices) optgroup.appendChild(optionFor(entries[i]));
    select.appendChild(optgroup);
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

// --- material presets ---------------------------------------------------------

/** The host's `ptPresets`: the shipped rows plus every library file. */
export function setMaterialPresets(msg: {
  presets: MaterialPreset[];
  problems?: { file: string; message: string }[];
}): void {
  presets = (msg.presets ?? []).filter((p) => !p.error);
  presetProblems = msg.problems ?? [];
  render();
}

/** Presets whose text matches the filter box, for the selected law. */
function matchingPresets(lawId: string, filter: string): MaterialPreset[] {
  const needle = filter.trim().toLowerCase();
  return presetsForLaw(presets, lawId).filter((p) => {
    if (needle.length === 0) return true;
    return [p.id, p.name, p.source.name, p.reference?.note ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  });
}

/**
 * A `<select>` of presets for one law, or a disabled one saying why it is
 * empty. Options carry an index rather than the id, because a workspace file
 * may reuse a shipped id and BOTH rows must stay individually selectable.
 */
function presetSelect(lawId: string, filter: string, onPick: (preset: MaterialPreset) => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "pt-preset-row";
  const select = document.createElement("select");
  select.className = "edit-sel pt-preset-select";
  const found = matchingPresets(lawId, filter);
  const none = document.createElement("option");
  none.value = "";
  none.textContent = found.length === 0 ? "— no preset —" : "— no preset (keep current values) —";
  select.appendChild(none);
  found.forEach((p, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    // A user file reusing a shipped id would otherwise be two identical rows.
    const suffix = p.file ? ` (${p.file.split(/[\\/]/).pop()})` : p.origin === "user" ? " (user)" : "";
    opt.textContent = `${p.name}${suffix}`;
    const reference = describeReference(p.reference);
    opt.title = [p.source.name, p.version, reference].filter(Boolean).join(" · ");
    select.appendChild(opt);
  });
  select.addEventListener("change", () => {
    const picked = found[Number(select.value)];
    if (picked) onPick(picked);
  });
  row.appendChild(select);
  return row;
}

/**
 * The material row's provenance line: which catalog row it came from, at which
 * reference conditions, and — when the library has since changed — an explicit
 * re-apply. Never updated on its own; the case keeps the values it was given.
 */
function presetBadge(
  m: MaterialAssignment,
  law: MaterialLawSpec | undefined,
  onReapply: () => void
): HTMLElement {
  const line = document.createElement("div");
  line.className = "pt-preset-badge";
  const snapshot = m.preset;
  if (!snapshot) {
    const hint = document.createElement("span");
    hint.className = "pt-preset-hint";
    hint.textContent = "typed by hand";
    line.appendChild(hint);
  } else {
    const label = document.createElement("span");
    const reference = describeReference(snapshot.reference);
    label.textContent = `${snapshot.name} · ${snapshot.source.name}${reference ? ` · ${reference}` : ""}`;
    label.title = `Values snapshotted from the catalog on this case. Editing the library does not change them.${snapshot.version ? ` Version ${snapshot.version}.` : ""}`;
    line.appendChild(label);
    const current = law ? findPreset(presets, snapshot.id) : undefined;
    const drift = law ? presetDrift(snapshot, current, law) : undefined;
    if (drift && drift.variables.length > 0) {
      const note = document.createElement("span");
      note.className = "pt-preset-hint";
      note.textContent = `library now differs in ${drift.variables.join(", ")}`;
      line.appendChild(note);
      const reapply = document.createElement("button");
      reapply.type = "button";
      reapply.className = "pt-preset-link";
      reapply.textContent = "re-apply";
      reapply.title = "Take the library's current values for this preset. Nothing else about the material changes.";
      reapply.addEventListener("click", onReapply);
      line.appendChild(reapply);
    }
  }
  const save = document.createElement("button");
  save.type = "button";
  save.className = "pt-preset-link";
  save.textContent = "save as preset";
  save.title = "Add these values to the workspace material library, with a source to fill in";
  // The same no-native-prompts convention as the outline's inline rename: the
  // name is typed into an input that replaces the link, Enter commits, Escape
  // cancels. window.prompt would block the whole webview behind a native dialog.
  save.addEventListener("click", () => {
    if (line.querySelector(".pt-preset-name")) return;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "edit-text pt-preset-name";
    input.placeholder = "preset name…";
    input.setAttribute("aria-label", "Name for the material preset");
    input.value = snapshot?.name ?? defaultPresetName(m);
    const commit = (): void => {
      const name = input.value.trim();
      input.remove();
      if (name) post({ type: "ptPresetSave", lawId: m.lawId, name, values: { ...m.values } as Record<string, number> });
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
      else if (e.key === "Escape") input.remove();
      e.stopPropagation();
    });
    input.addEventListener("click", (e) => e.stopPropagation());
    save.replaceWith(input);
    setTimeout(() => input.focus(), 0);
  });
  line.appendChild(save);
  return line;
}

/** A default name for a hand-typed material being saved. */
function defaultPresetName(m: MaterialAssignment): string {
  return `${m.smpPath.split("/").pop() ?? "material"} material`;
}

/**
 * Applies a catalog row to one material assignment, in place. Returns the line
 * the status bar should show, or undefined when the preset does not fit — in
 * which case the material is left exactly as it was.
 */
function resolveInto(m: MaterialAssignment, law: MaterialLawSpec, preset: MaterialPreset): string | undefined {
  const resolved = resolvePresetValues(law, preset, m.values);
  if (resolved.problems.length > 0) return undefined;
  m.values = resolved.values;
  m.preset = snapshotOf(preset, resolved.values);
  return [
    `Applied "${preset.name}" to ${m.smpPath}.`,
    ...resolved.derived.map((d) => `${d.formula} = ${d.inputs.map((i) => `${i.id} ${i.value}`).join(" × ")}`),
    ...resolved.conversions.map((c) => `${c.variable}: ${c.from} → ${c.to}`),
  ].join(" ");
}

/** `resolveInto` plus the post + re-render, for a row already in the case. */
function applyPresetTo(m: MaterialAssignment, law: MaterialLawSpec, preset: MaterialPreset): void {
  const before = { ...m.values };
  const message = resolveInto(m, law, preset);
  if (message === undefined) {
    const tried = resolvePresetValues(law, preset, before);
    m.values = before;
    post({ type: "ptStatus", kind: "error", message: tried.problems.join(" ") });
    return;
  }
  post({ type: "ptStatus", kind: "idle", message });
  scheduleSend();
  render();
}

/** The inline material issues — the same rulebook the generator refuses on. */
function issueLine(issues: ReturnType<typeof validateMaterialAssignment>): HTMLElement {
  const line = document.createElement("div");
  line.className = "pt-issues";
  for (const issue of issues) {
    const row = document.createElement("div");
    row.className = issue.severity === "error" ? "pt-issue error" : "pt-issue";
    row.textContent = issue.message;
    line.appendChild(row);
  }
  return line;
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
  // The mesh (or its edits) changed under the case: ask the host to re-check it.
  if (state) post({ type: "ptPreflightRequest" });
}

/**
 * Renders the host's `ptStatus` feedback under the action buttons.
 *
 * `kind` is stringly-typed on both sides with an `else` that clears the line,
 * so the run-status kinds below are additive: an older webview paired with a
 * newer host shows nothing rather than breaking.
 *
 * The Run button doubles as Stop while a run for THIS mesh is live — a run
 * started from another mesh in the same folder is not this panel's to stop, and
 * shows up in the Kratos Runs view instead.
 */
export function setProblemtypeStatus(status: {
  kind: string;
  files?: string[];
  message?: string;
  running?: boolean;
  step?: string;
  exitCode?: number | null;
}): void {
  const box = el("pt-status");
  if (!box) return;
  box.classList.remove("error");
  if (status.kind === "generated") {
    box.textContent = `Generated ${status.files?.join(", ") ?? "case files"}.`;
  } else if (status.kind === "starting") {
    box.textContent = "Starting…";
  } else if (status.kind === "running") {
    box.textContent = status.step ? `Running — step ${status.step}…` : "Running…";
  } else if (status.kind === "finished") {
    box.textContent = "Finished.";
  } else if (status.kind === "cancelled") {
    box.textContent = status.message ?? "Stopped.";
  } else if (status.kind === "detached") {
    box.textContent = status.message ?? "Running (status not tracked).";
  } else if (status.kind === "orphaned") {
    box.textContent = status.message ?? "This run ended without recording a result.";
  } else if (status.kind === "failed" || status.kind === "error") {
    box.textContent = status.message ?? "Failed.";
    box.classList.add("error");
  } else {
    box.textContent = "";
  }
  setRunButtonMode(status.running === true);
}

let runCapability: { allowed: boolean; checking: boolean; reason?: string } = { allowed: true, checking: false };
let runIsActive = false;

export function setProblemtypeCapability(status: { allowed?: boolean; checking?: boolean; reason?: string }): void {
  runCapability = {
    allowed: status.allowed ?? runCapability.allowed,
    checking: status.checking === true,
    reason: status.reason,
  };
  const box = el("pt-status");
  if (box && (box.textContent.startsWith("Run unavailable:") || !box.textContent)) {
    if (runCapability.checking) {
      box.textContent = "Checking the configured simulation environment…";
      box.classList.remove("error");
    } else if (!runCapability.allowed && runCapability.reason) {
      box.textContent = `Run unavailable: ${runCapability.reason}`;
      box.classList.add("error");
    } else {
      box.textContent = "";
      box.classList.remove("error");
    }
  }
  setRunButtonMode(runIsActive);
}

/**
 * Flips the Run action between Run and Stop.
 *
 * Only the label span is touched: the button also holds an inline SVG icon, and
 * setting textContent on the button would delete it.
 */
function setRunButtonMode(running: boolean): void {
  const btn = el("pt-run") as HTMLButtonElement | null;
  if (!btn) return;
  runIsActive = running;
  const label = btn.querySelector("span:not(.toolbar-icon)");
  if (label) label.textContent = running ? "Stop run" : "Run case";
  btn.title = running
    ? "Stop the running solver — results already written are kept"
    : runCapability.checking
      ? "Checking the configured simulation environment…"
      : runCapability.allowed
        ? "Generate the case files and run MainKratos.py"
        : runCapability.reason ?? "The configured simulation environment is unavailable";
  btn.disabled = !running && (runCapability.checking || !runCapability.allowed);
  btn.setAttribute("aria-disabled", String(btn.disabled));
  btn.dataset.mode = running ? "stop" : "run";
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
  renderHeader(decl);
  renderParts(decl);
  renderMaterials(decl);
  renderAssignments(decl);
  renderCollections(decl);
  renderSections(decl);
  renderOutput(decl);
}

/** The logo tile, name, description and summary chips above the stages. */
function renderHeader(decl: ProblemtypeDeclaration): void {
  const host = el("pt-header");
  if (!host || !state) return;
  const entry = catalog.find((e) => e.decl?.id === decl.id);
  host.textContent = "";
  host.appendChild(
    headerCard({
      name: decl.name,
      description: decl.description,
      icon: decl.icon,
      origin: entry && entry.source !== "builtin" ? `workspace · ${entry.source}` : undefined,
      chips: summaryChips(decl, state),
    })
  );
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
  } else if (f.type === "ref") {
    wrap.appendChild(refSelect(f, value, onChange));
  } else if (f.type === "smp") {
    wrap.appendChild(smpSelect(typeof value === "string" ? value : "", (v) => onChange(v)));
  } else if (f.type === "smpList") {
    wrap.className = "edit-field pt-field pt-field-list";
    wrap.appendChild(smpChips(Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [], (v) => onChange(v)));
  } else if (f.type === "numberList" || f.type === "stringList") {
    const input = document.createElement("input");
    input.className = "edit-num edit-num-wide";
    input.type = "text";
    input.placeholder = f.type === "numberList" ? "e.g. 0.1, 0.2" : "e.g. A, B";
    input.value = formatListValue(value);
    input.addEventListener("change", () => {
      const list = parseListText(input.value, f.type as "numberList" | "stringList");
      input.value = formatListValue(list);
      onChange(list);
    });
    wrap.appendChild(input);
  } else if (f.type === "caseValue") {
    wrap.appendChild(caseValueSelect(typeof value === "string" ? value : "", onChange));
  } else {
    const input = document.createElement("input");
    input.className = "edit-num edit-num-wide";
    input.type = f.type === "string" ? "text" : "number";
    if (f.type === "int") input.step = "1";
    // Advisory bounds from the declaration: they steer the spinner and the
    // browser's own validity state, but nothing clamps what the user types.
    if (f.type !== "string") {
      if (f.step !== undefined) input.step = String(f.step);
      if (f.min !== undefined) input.min = String(f.min);
      if (f.max !== undefined) input.max = String(f.max);
    }
    input.value = String(value ?? "");
    input.addEventListener("change", () => {
      onChange(f.type === "string" ? input.value : Number(input.value) || 0);
    });
    wrap.appendChild(input);
  }
  // The declared unit, unless the label already carries one in brackets.
  if (f.unit && f.type !== "bool" && !f.label.includes("[")) {
    const unit = document.createElement("span");
    unit.className = "pt-unit";
    unit.textContent = f.unit;
    wrap.appendChild(unit);
  }
  return wrap;
}

/** Applies visibleWhen rules within one form body, hiding groups left with no visible field. */
function applyVisibility(body: HTMLElement, fields: FieldSpec[], values: Record<string, JsonValue>): void {
  for (const f of fields) {
    if (!f.visibleWhen) continue;
    const row = body.querySelector<HTMLElement>(`[data-field="${f.id}"]`);
    if (row) row.style.display = isFieldVisible(f, values) ? "" : "none";
  }
  const groups = Array.from(body.querySelectorAll(".pt-group")) as HTMLElement[];
  for (const group of groups) {
    const rows = Array.from(group.querySelectorAll(".pt-field")) as HTMLElement[];
    group.style.display = rows.length > 0 && rows.every((r) => r.style.display === "none") ? "none" : "";
  }
}

function renderSections(decl: ProblemtypeDeclaration): void {
  const host = el("pt-forms");
  if (!host || !state) return;
  host.textContent = "";
  host.appendChild(stageCaption("Solution", "ptSolver"));
  // The problemtype's own logo unless the section names a known icon.
  const logo = isIconId(decl.icon) ? decl.icon : "problemtype";
  decl.sections.forEach((s, si) => {
    const { form, body } = cardBlock({
      key: `${decl.id}:section:${s.id}`,
      title: s.label,
      collapsed: si > 0,
      icon: isIconId(s.icon) ? s.icon : logo,
    });
    const values = (state!.values[s.id] ??= {});
    const addField = (target: HTMLElement, f: FieldSpec): void => {
      if (values[f.id] === undefined) values[f.id] = fieldDefault(f);
      target.appendChild(
        fieldInput(f, values[f.id], (v) => {
          values[f.id] = v;
          applyVisibility(body, s.fields, values);
          scheduleSend();
        })
      );
    };
    const layout = groupSectionFields(s);
    for (const f of layout.loose) addField(body, f);
    for (const g of layout.groups) {
      const { group, body: gbody } = groupBlock({
        key: `${decl.id}:section:${s.id}:group:${g.spec.id}`,
        title: g.spec.label,
        collapsed: g.spec.collapsed === true,
        icon: g.spec.icon,
      });
      for (const f of g.fields) addField(gbody, f);
      body.appendChild(group);
    }
    if (layout.advanced.length > 0) {
      const { group, body: gbody } = groupBlock({
        key: `${decl.id}:section:${s.id}:advanced`,
        title: "Advanced",
        collapsed: true,
        icon: "ptSolver",
      });
      for (const f of layout.advanced) addField(gbody, f);
      body.appendChild(group);
    }
    applyVisibility(body, s.fields, values);
    host.appendChild(form);
  });
}

/** An `<option>` with text set safely. */
function optionEl(value: string, text: string): HTMLOptionElement {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = text;
  return opt;
}

/**
 * A `ref` field: the names of the referenced collection's entries. A value that
 * names no entry (deleted, or never chosen) stays selected and shows red, so
 * the dangling reference is visible rather than silently replaced.
 */
function refSelect(f: FieldSpec, value: JsonValue, onChange: (v: JsonValue) => void): HTMLSelectElement {
  const select = document.createElement("select");
  select.className = "edit-sel edit-sel-grow";
  const names = state ? entriesOf(state, f.refCollection ?? "").map((e) => e.name) : [];
  const current = typeof value === "string" ? value : "";
  if (!names.includes(current)) {
    select.appendChild(optionEl(current, current ? `${current} (missing)` : "— choose —"));
    select.classList.add("pt-invalid");
  }
  for (const n of names) select.appendChild(optionEl(n, n));
  select.value = current;
  select.addEventListener("change", () => {
    onChange(select.value);
    render();
  });
  return select;
}

/** One SubModelPart path; an unknown path stays visible and marked. */
function smpSelect(value: string, onChange: (v: string) => void): HTMLSelectElement {
  const select = document.createElement("select");
  select.className = "edit-sel edit-sel-grow";
  select.appendChild(optionEl("", "— none —"));
  if (value && !smpPaths.includes(value)) {
    select.appendChild(optionEl(value, `${value} (not in mesh)`));
    select.classList.add("pt-invalid");
  }
  for (const p of smpPaths) select.appendChild(optionEl(p, p));
  select.value = value;
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

/** Several SubModelPart paths: removable chips plus an "add" dropdown. */
function smpChips(paths: string[], onChange: (v: string[]) => void): HTMLElement {
  const box = document.createElement("div");
  box.className = "pt-chips";
  const current = [...paths];
  for (const p of current) {
    const chip = document.createElement("span");
    chip.className = "pt-chip";
    if (smpPaths.length > 0 && !smpPaths.includes(p)) {
      chip.classList.add("missing");
      chip.title = `${p} — not in the current mesh`;
    } else chip.title = p;
    const text = document.createElement("span");
    text.textContent = p;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "pt-chip-del";
    del.textContent = "×";
    del.title = `Remove ${p}`;
    del.addEventListener("click", () => {
      onChange(current.filter((x) => x !== p));
      render();
    });
    chip.append(text, del);
    box.appendChild(chip);
  }
  const add = document.createElement("select");
  add.className = "edit-sel pt-chip-add";
  add.appendChild(optionEl("", smpPaths.length === 0 ? "no SubModelParts" : "+ add SubModelPart"));
  for (const p of smpPaths) if (!current.includes(p)) add.appendChild(optionEl(p, p));
  add.disabled = smpPaths.length === 0;
  add.addEventListener("change", () => {
    if (!add.value) return;
    onChange([...current, add.value]);
    render();
  });
  box.appendChild(add);
  return box;
}

/** A `caseValue` field: every numeric value of the case, grouped as the sidebar groups it. */
function caseValueSelect(value: string, onChange: (v: JsonValue) => void): HTMLSelectElement {
  const select = document.createElement("select");
  select.className = "edit-sel edit-sel-grow";
  const decl = currentDecl();
  const options = decl && state ? caseValueAddresses(decl, state) : [];
  if (!options.some((o) => o.address === value)) {
    select.appendChild(optionEl(value, value ? `${value} (not in this case)` : "— choose a value —"));
    select.classList.add("pt-invalid");
  }
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const o of options) {
    let og = groups.get(o.group);
    if (!og) {
      og = document.createElement("optgroup");
      og.label = o.group;
      groups.set(o.group, og);
      select.appendChild(og);
    }
    const opt = optionEl(o.address, `${o.label} = ${o.value}`);
    opt.title = o.address;
    og.appendChild(opt);
  }
  select.value = value;
  select.addEventListener("change", () => {
    onChange(select.value);
    render();
  });
  return select;
}

/**
 * The Setup stage: one card per declared collection (an optimization's
 * responses, controls and constraints; a ROM's parameters). Each entry is a
 * named box with its type, its SubModelParts and its own fields; renaming goes
 * through `renameEntry`, so every reference follows the new name.
 */
function renderCollections(decl: ProblemtypeDeclaration): void {
  const host = el("pt-collections");
  if (!host || !state) return;
  host.textContent = "";
  const specs = decl.collections ?? [];
  if (specs.length === 0) return;
  host.appendChild(stageCaption("Setup", "problemtype"));
  state.collections ??= {};
  const problems = collectionProblems(decl, state, smpPaths.length > 0 ? smpPaths : undefined);
  // Section values let an entry field's visibleWhen depend on the setup (an
  // algorithm type) as well as on the entry's own fields.
  const sectionValues = flattenValues(decl, state);
  for (const spec of specs) {
    const list = (state.collections[spec.id] ??= []);
    const { form, body } = cardBlock({
      key: `${decl.id}:collection:${spec.id}`,
      title: spec.label,
      icon: spec.icon ?? "problemtype",
      count: list.length,
    });
    form.dataset.collection = spec.id;
    if (spec.help) {
      const hint = document.createElement("div");
      hint.className = "pt-empty";
      hint.textContent = spec.help;
      body.appendChild(hint);
    }
    body.appendChild(collectionAddRow(spec));
    const general = problems.filter((p) => p.collectionId === spec.id && p.entry === undefined);
    if (general.length > 0) body.appendChild(issueLines(general.map((p) => p.message)));
    list.forEach((entry, index) => {
      body.appendChild(
        entryBox(decl, spec, entry, index, problems.filter((p) => p.collectionId === spec.id && p.entry === entry.name), sectionValues)
      );
    });
    if (list.length === 0) {
      const hint = document.createElement("div");
      hint.className = "pt-empty";
      hint.textContent = `No ${spec.label.toLowerCase()} yet — pick a type above and add one.`;
      body.appendChild(hint);
    }
    host.appendChild(form);
  }
}

function issueLines(messages: string[]): HTMLElement {
  const box = document.createElement("div");
  box.className = "pt-issues";
  for (const m of messages) {
    const row = document.createElement("div");
    row.className = "pt-issue error";
    row.textContent = m;
    box.appendChild(row);
  }
  return box;
}

/** Type × name × "+" for one collection; the name defaults to a free one derived from the type. */
function collectionAddRow(spec: CollectionSpec): HTMLElement {
  const row = document.createElement("div");
  row.className = "pt-add-row";
  const type = document.createElement("select");
  type.className = "edit-sel pt-add-what";
  for (const t of spec.entryTypes) type.appendChild(optionEl(t.id, t.label));
  const name = document.createElement("input");
  name.type = "text";
  name.className = "edit-num pt-add-name";
  name.placeholder = "name";
  name.title = "Letters, digits and _ (not starting with a digit)";
  const refreshPlaceholder = (): void => {
    if (state) name.placeholder = uniqueEntryName(state, spec.id, type.value);
  };
  refreshPlaceholder();
  type.addEventListener("change", refreshPlaceholder);
  const add = document.createElement("button");
  add.type = "button";
  add.className = "edit-apply";
  add.textContent = "+";
  add.title = `Add to ${spec.label.toLowerCase()}`;
  const commit = (): void => {
    if (!state) return;
    const wanted = name.value.trim() || uniqueEntryName(state, spec.id, type.value);
    const list = (state.collections![spec.id] ??= []);
    if (!isValidEntryName(wanted) || list.some((e) => e.name === wanted)) {
      name.classList.add("pt-invalid");
      name.title = !isValidEntryName(wanted)
        ? `"${wanted}" is not a valid name (letters, digits and _; not starting with a digit)`
        : `"${wanted}" is already used`;
      return;
    }
    list.push(newEntry(spec, type.value, wanted));
    scheduleSend();
    render();
  };
  add.addEventListener("click", commit);
  name.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
  });
  row.append(type, name, add);
  return row;
}

/** One collection entry: head (icon · name · type · ✎ ↑ ↓ ×), issues, parts and fields. */
function entryBox(
  decl: ProblemtypeDeclaration,
  spec: CollectionSpec,
  entry: CollectionEntry,
  index: number,
  problems: { message: string }[],
  sectionValues: Record<string, JsonValue>
): HTMLElement {
  const type = entryTypeOf(spec, entry.type);
  const box = document.createElement("div");
  box.className = "pt-assign pt-entry";
  box.dataset.entry = entry.name;
  const head = document.createElement("div");
  head.className = "pt-assign-head";
  const glyph = iconSpan(type?.icon ?? spec.icon, "toolbar-icon pt-assign-icon");
  if (glyph) head.appendChild(glyph);
  const label = document.createElement("span");
  label.className = "pt-assign-label pt-entry-name";
  label.textContent = entry.name;
  label.title = "Double-click to rename";
  const kind = document.createElement("span");
  kind.className = "pt-assign-path";
  kind.textContent = type?.label ?? `${entry.type} (unknown type)`;
  if (!type) kind.classList.add("missing");
  const button = (text: string, title: string, onClick: () => void, disabled = false): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pt-assign-del";
    b.textContent = text;
    b.title = title;
    b.disabled = disabled;
    b.addEventListener("click", onClick);
    return b;
  };
  const list = state!.collections![spec.id];
  const startRename = (): void => {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "edit-num pt-entry-rename";
    input.value = entry.name;
    let done = false;
    const finish = (save: boolean): void => {
      if (done) return;
      done = true;
      if (save && state) {
        const next = renameEntry(decl, state, spec.id, entry.name, input.value.trim());
        if (next && next !== state) {
          state = next;
          scheduleSend();
        }
      }
      render();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    label.replaceWith(input);
    input.focus();
    input.select();
  };
  label.addEventListener("dblclick", startRename);
  const move = (delta: number): void => {
    const j = index + delta;
    if (j < 0 || j >= list.length) return;
    [list[index], list[j]] = [list[j], list[index]];
    scheduleSend();
    render();
  };
  head.append(
    label,
    kind,
    button("✎", "Rename (references follow)", startRename),
    button("↑", "Move up", () => move(-1), index === 0),
    button("↓", "Move down", () => move(1), index === list.length - 1),
    button("×", "Remove", () => {
      list.splice(index, 1);
      scheduleSend();
      render();
    })
  );
  box.appendChild(head);
  if (problems.length > 0) box.appendChild(issueLines(problems.map((p) => p.message)));
  if (type?.parts) {
    const parts = document.createElement("label");
    parts.className = "edit-field pt-field pt-field-list";
    const caption = document.createElement("span");
    caption.textContent = type.parts.label;
    parts.appendChild(caption);
    parts.appendChild(
      smpChips(entry.parts, (v) => {
        entry.parts = v;
        scheduleSend();
      })
    );
    box.appendChild(parts);
  }
  const fields = type?.fields ?? [];
  const merged = (): Record<string, JsonValue> => ({ ...sectionValues, ...entry.values });
  for (const f of fields) {
    if (entry.values[f.id] === undefined) entry.values[f.id] = fieldDefault(f);
    box.appendChild(
      fieldInput(f, entry.values[f.id], (v) => {
        entry.values[f.id] = v;
        applyVisibility(box, fields, merged());
        scheduleSend();
      })
    );
  }
  applyVisibility(box, fields, merged());
  return box;
}

/** One entry of an add-row's first dropdown: a lone choice or a labelled group of them. */
type AddChoice = { value: string; label: string } | { group: string; choices: { value: string; label: string }[] };

/** The "condition × SubModelPart" add-row shared by assignments and parts. */
function addRow(choices: AddChoice[], buttonTitle: string, onAdd: (choice: string, smpPath: string) => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "pt-add-row";
  const what = document.createElement("select");
  what.className = "edit-sel pt-add-what";
  const option = (c: { value: string; label: string }): HTMLOptionElement => {
    const opt = document.createElement("option");
    opt.value = c.value;
    opt.textContent = c.label;
    return opt;
  };
  let total = 0;
  for (const c of choices) {
    if ("group" in c) {
      const og = document.createElement("optgroup");
      og.label = c.group;
      for (const inner of c.choices) og.appendChild(option(inner));
      total += c.choices.length;
      what.appendChild(og);
    } else {
      what.appendChild(option(c));
      total += 1;
    }
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
  add.disabled = smpPaths.length === 0 || total === 0;
  add.addEventListener("click", () => {
    if (what.value !== undefined && where.value) onAdd(what.value, where.value);
  });
  row.append(what, where, add);
  return row;
}

/** One applied assignment/material row: header (icon · label · path · ×) + its fields. */
function appliedRow(
  title: string,
  smpPath: string,
  fields: FieldSpec[],
  values: Record<string, JsonValue>,
  onDelete: () => void,
  icon?: string,
  onEdit?: () => void
): HTMLElement {
  const box = document.createElement("div");
  box.className = "pt-assign";
  const head = document.createElement("div");
  head.className = "pt-assign-head";
  const glyph = iconSpan(icon, "toolbar-icon pt-assign-icon");
  if (glyph) head.appendChild(glyph);
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
        onEdit?.();
      })
    );
  }
  return box;
}

/**
 * The Parts pseudo-condition(s): which SubModelParts are the computing domain.
 * A coupled problemtype has one per physics domain (Fluid body, Structure body…).
 */
function renderParts(decl: ProblemtypeDeclaration): void {
  const host = el("pt-parts");
  if (!host || !state) return;
  host.textContent = "";
  const entries = decl.domains && decl.domains.length > 0
    ? decl.domains.map((d) => ({ conditionId: d.partsCondition, key: d.id, domainLabel: d.label }))
    : decl.partsCondition ? [{ conditionId: decl.partsCondition, key: "parts", domainLabel: undefined as string | undefined }] : [];
  if (entries.length === 0) return;
  host.appendChild(stageCaption("Domain", "ptParts"));
  for (const entry of entries) {
    const cond = decl.conditions.find((c) => c.id === entry.conditionId);
    if (!cond) continue;
    const mine = state.assignments.filter((a) => a.conditionId === entry.conditionId);
    const { form, body } = cardBlock({
      key: `${decl.id}:parts:${entry.key}`,
      title: entry.domainLabel ? `${entry.domainLabel} · ${cond.label}` : cond.label,
      icon: cond.icon ?? "ptParts",
      count: mine.length,
    });
    body.appendChild(
      addRow([{ value: entry.conditionId, label: cond.label }], "Mark the SubModelPart as part of the computing domain", (conditionId, smpPath) => {
        state!.assignments.push({ conditionId, smpPath, values: {} });
        scheduleSend();
        render();
      })
    );
    state.assignments.forEach((a: Assignment, i: number) => {
      if (a.conditionId !== entry.conditionId) return;
      body.appendChild(
        appliedRow(cond.label, a.smpPath, cond.fields, a.values, () => {
          state!.assignments.splice(i, 1);
          scheduleSend();
          render();
        }, cond.icon ?? "ptParts")
      );
    });
    host.appendChild(form);
  }
}

/**
 * The Conditions card: one add-row whose condition dropdown is grouped by tree
 * branch, then the applied rows filed under collapsible branches (Initial
 * conditions, Boundary conditions, Loads, Other processes) with a count each.
 */
function renderAssignments(decl: ProblemtypeDeclaration): void {
  const host = el("pt-assignments");
  if (!host || !state) return;
  host.textContent = "";
  const branches = groupConditions(decl);
  if (branches.length === 0) return;
  host.appendChild(stageCaption("Conditions", "condition"));
  const counts = countByCategory(decl, state.assignments);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const { form, body } = cardBlock({
    key: `${decl.id}:conditions`,
    title: "Conditions",
    icon: "condition",
    count: total,
  });
  body.appendChild(
    addRow(
      branches.map((b) => ({
        group: b.label,
        choices: b.conditions.map((c) => ({ value: c.id, label: c.label })),
      })),
      "Assign the condition to the SubModelPart",
      (conditionId, smpPath) => {
        state!.assignments.push({ conditionId, smpPath, values: {} });
        scheduleSend();
        render();
      }
    )
  );
  let shown = 0;
  for (const branch of branches) {
    const rows = state.assignments
      .map((a: Assignment, i: number) => ({ a, i, cond: branch.conditions.find((c) => c.id === a.conditionId) }))
      .filter((r) => r.cond !== undefined);
    if (rows.length === 0) continue;
    shown += rows.length;
    const { group, body: gbody } = groupBlock({
      key: `${decl.id}:conditions:${branch.domain?.id ?? ""}:${branch.category}`,
      title: branch.label,
      icon: branch.icon,
      count: rows.length,
    });
    for (const { a, i, cond } of rows) {
      gbody.appendChild(
        appliedRow(cond!.label, a.smpPath, cond!.fields, a.values, () => {
          state!.assignments.splice(i, 1);
          scheduleSend();
          render();
        }, cond!.icon ?? branch.icon)
      );
    }
    body.appendChild(group);
  }
  // Assignments naming a condition the declaration no longer has (a hand-edited
  // or older case): still listed, so they can be removed rather than lingering.
  const known = new Set([...partsConditions(decl), ...branches.flatMap((b) => b.conditions.map((c) => c.id))]);
  state.assignments.forEach((a: Assignment, i: number) => {
    if (known.has(a.conditionId)) return;
    shown += 1;
    body.appendChild(
      appliedRow(`${a.conditionId} (unknown)`, a.smpPath, [], a.values, () => {
        state!.assignments.splice(i, 1);
        scheduleSend();
        render();
      })
    );
  });
  if (shown === 0) {
    const hint = document.createElement("div");
    hint.className = "pt-empty";
    hint.textContent = "No conditions yet — pick one above and a SubModelPart to apply it to.";
    body.appendChild(hint);
  }
  host.appendChild(form);
}

/**
 * The Materials form. The law dropdown decides the variable set; the preset
 * dropdown is a filterable catalog of parameter values with a source, and
 * choosing one seeds the NEW row from it. Each applied row then carries the
 * snapshot it was given, so the case keeps saying where its numbers came from.
 */
function renderMaterials(decl: ProblemtypeDeclaration): void {
  const host = el("pt-materials");
  if (!host || !state) return;
  host.textContent = "";
  if (decl.materialLaws.length === 0) return;
  const { form, body } = cardBlock({
    key: `${decl.id}:materials`,
    title: "Materials",
    icon: "material",
    count: state.materials.length,
  });

  const filter = document.createElement("input");
  filter.type = "text";
  filter.className = "edit-text pt-preset-filter";
  filter.placeholder = "Search material presets…";
  filter.value = presetFilter;
  filter.setAttribute("aria-label", "Search material presets by name or source");
  filter.addEventListener("input", () => {
    presetFilter = filter.value;
    const caret = filter.selectionStart ?? filter.value.length;
    render();
    // render() rebuilds the card, so give the new input the typing focus back.
    const next = document.querySelector<HTMLInputElement>(".pt-preset-filter");
    if (next) {
      next.focus();
      next.setSelectionRange(caret, caret);
    }
  });
  body.appendChild(filter);

  const tools = document.createElement("div");
  tools.className = "pt-preset-tools";
  const importBtn = document.createElement("button");
  importBtn.type = "button";
  importBtn.className = "pt-preset-link";
  importBtn.textContent = "import presets…";
  importBtn.title = "Add a JSON preset file to this workspace's material library";
  importBtn.addEventListener("click", () => post({ type: "ptPresetImport" }));
  tools.appendChild(importBtn);
  for (const problem of presetProblems) {
    const note = document.createElement("span");
    note.className = "pt-preset-problem";
    note.textContent = `${problem.file}: ${problem.message}`;
    tools.appendChild(note);
  }
  body.appendChild(tools);

  // The add row: law × SubModelPart, optionally seeded from a preset.
  const addHost = document.createElement("div");
  body.appendChild(addHost);
  const lawSelect = document.createElement("select");
  lawSelect.className = "edit-sel pt-add-what";
  for (const l of decl.materialLaws) {
    const opt = document.createElement("option");
    opt.value = l.id;
    const owner = decl.domains?.find((d) => d.id === l.domain);
    opt.textContent = `${owner ? `${owner.label} · ` : ""}${l.name || l.id}`;
    lawSelect.appendChild(opt);
  }
  const whereSelect = document.createElement("select");
  whereSelect.className = "edit-sel pt-add-where";
  if (smpPaths.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "no SubModelParts";
    whereSelect.appendChild(opt);
    whereSelect.disabled = true;
  }
  for (const p of smpPaths) {
    const opt = document.createElement("option");
    opt.value = p;
    opt.textContent = p;
    whereSelect.appendChild(opt);
  }
  let chosenPreset: MaterialPreset | undefined;
  const addRow = document.createElement("div");
  addRow.className = "pt-add-row";
  const add = document.createElement("button");
  add.type = "button";
  add.className = "edit-apply";
  add.textContent = "+";
  add.title = "Assign the material to the SubModelPart";
  add.disabled = smpPaths.length === 0 || decl.materialLaws.length === 0;
  add.addEventListener("click", () => {
    const lawId = lawSelect.value;
    const smpPath = whereSelect.value;
    if (!smpPath) return;
    const law = decl.materialLaws.find((l) => l.id === lawId);
    const material: MaterialAssignment = { smpPath, lawId, values: {} };
    if (law) {
      // A preset seeds the new row; without one the law's own defaults stand.
      for (const f of law.variables) material.values[f.id] = fieldDefault(f);
      const preset = chosenPreset;
      if (preset) {
        const message = resolveInto(material, law, preset);
        if (message === undefined) {
          const tried = resolvePresetValues(law, preset, material.values);
          post({ type: "ptStatus", kind: "error", message: tried.problems.join(" ") });
          render();
          return;
        }
        post({ type: "ptStatus", kind: "idle", message });
      }
    }
    state!.materials.push(material);
    scheduleSend();
    render();
  });
  addRow.append(lawSelect, whereSelect, add);
  addHost.appendChild(addRow);
  // The preset dropdown follows the chosen law, so it only ever offers rows
  // that declare compatibility with it. It starts on the first match, because
  // "pick a fluid, then assign it" is the common single step.
  chosenPreset = matchingPresets(lawSelect.value, presetFilter)[0];
  const picker = presetSelect(lawSelect.value, presetFilter, (preset) => {
    chosenPreset = preset;
  });
  (picker.querySelector("select") as HTMLSelectElement).value = chosenPreset ? "0" : "";
  addHost.appendChild(picker);
  lawSelect.addEventListener("change", () => render());

  state.materials.forEach((m: MaterialAssignment, i: number) => {
    const law = decl.materialLaws.find((l) => l.id === m.lawId);
    // The provenance badge and the issue line are derived from the values, so an
    // edit refreshes just those two nodes — a full render() would rebuild the
    // card and drop the focus the user is tabbing through.
    let badge: HTMLElement | undefined;
    let issues: HTMLElement | undefined;
    const refreshDerived = (): void => {
      if (!law || !row) return;
      const snapshotPreset = findPreset(presets, m.preset?.id ?? "");
      const nextBadge = presetBadge(m, law, () => {
        if (snapshotPreset) applyPresetTo(m, law, snapshotPreset);
      });
      if (badge) badge.replaceWith(nextBadge);
      else row.appendChild(nextBadge);
      badge = nextBadge;
      const found = validateMaterialAssignment(law, m.values, m.preset);
      const nextIssues = found.length > 0 ? issueLine(found) : undefined;
      if (issues && nextIssues) issues.replaceWith(nextIssues);
      else if (issues) issues.remove();
      else if (nextIssues) row.appendChild(nextIssues);
      issues = nextIssues;
    };
    const row: HTMLElement = appliedRow(
      law?.name || m.lawId,
      m.smpPath,
      law?.variables ?? [],
      m.values,
      () => {
        state!.materials.splice(i, 1);
        scheduleSend();
        render();
      },
      "material",
      refreshDerived
    );
    refreshDerived();
    body.appendChild(row);
  });
  host.appendChild(form);
}

function renderOutput(decl: ProblemtypeDeclaration): void {
  const host = el("pt-output");
  if (!host || !state) return;
  host.textContent = "";
  host.appendChild(stageCaption("Results", "results"));
  const { form, body } = cardBlock({
    key: `${decl.id}:output`,
    title: "Output",
    icon: "field",
    collapsed: true,
  });
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
  body.appendChild(
    fieldInput(
      {
        id: "exportFormats",
        label: "also export as",
        type: "string",
        help: "Comma-separated formats (.xdmf, .pvd, .exo, .msh, .med, …) the finished run's VTK output is converted to with meshio++. .xdmf and .pvd pack the series into one file; the others write one file per step into converted/",
      },
      (out.exportFormats ?? []).join(", "),
      (v) => {
        const list = String(v)
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (list.length > 0) out.exportFormats = list;
        else delete out.exportFormats;
        scheduleSend();
      }
    )
  );
  host.appendChild(form);
}

/** Host-computed time-step guidance (fluid only); empty lines hides it. */
export function setProblemtypeEstimate(msg: { lines?: string[] }): void {
  const box = el("pt-estimate");
  if (!box) return;
  const lines = msg.lines ?? [];
  box.replaceChildren(
    ...lines.map((l) => {
      const p = document.createElement("div");
      p.textContent = l;
      return p;
    })
  );
  box.hidden = lines.length === 0;
}

/** One preflight finding as the host posts it (see src/problemtype/preflight.ts). */
interface PreflightFinding {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  target?: { smpPath?: string };
}

let preflightFrameHandler: (smpPath: string) => void = () => {};
/** The Preflight card starts open and remembers the user's choice across updates. */
let preflightOpen = true;
let lastPreflight: { counts: Record<string, number>; findings: PreflightFinding[] } | undefined;

/** Lets the host page decide what "show me that part" means (frame its outline layer). */
export function setPreflightFrameHandler(handler: (smpPath: string) => void): void {
  preflightFrameHandler = handler;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The case preflight: severity-grouped rows, a part-bearing row frames that part on click. */
export function setProblemtypePreflight(msg: {
  active?: boolean;
  counts?: Record<string, number>;
  findings?: PreflightFinding[];
}): void {
  const box = el("pt-preflight");
  if (!box) return;
  const findings = msg.findings ?? [];
  lastPreflight = msg.active ? { counts: msg.counts ?? {}, findings } : undefined;
  if (!msg.active) {
    box.replaceChildren();
    box.hidden = true;
    return;
  }
  const counts = msg.counts ?? {};
  const head = document.createElement("button");
  head.type = "button";
  head.className = "pt-preflight-head";
  head.setAttribute("aria-expanded", String(preflightOpen));
  const title = document.createElement("span");
  title.className = "pt-preflight-title";
  title.textContent = "Preflight";
  head.appendChild(title);
  const summary = document.createElement("span");
  summary.className = "pt-preflight-summary";
  const parts: string[] = [];
  if (counts.error) parts.push(plural(counts.error, "error"));
  if (counts.warning) parts.push(plural(counts.warning, "warning"));
  if (counts.info) parts.push(`${counts.info} note${counts.info === 1 ? "" : "s"}`);
  summary.textContent = parts.length > 0 ? parts.join(" · ") : "ready to generate";
  if (counts.error) summary.classList.add("error");
  head.appendChild(summary);
  head.addEventListener("click", () => {
    preflightOpen = !preflightOpen;
    if (lastPreflight) setProblemtypePreflight({ active: true, ...lastPreflight });
  });
  const rows = document.createElement("div");
  rows.className = "pt-preflight-rows";
  rows.hidden = !preflightOpen;
  for (const f of findings) {
    const row = document.createElement(f.target?.smpPath ? "button" : "div");
    row.className = `pt-preflight-row ${f.severity}`;
    row.title = f.code;
    const mark = document.createElement("span");
    mark.className = "pt-preflight-mark";
    mark.textContent = f.severity === "error" ? "!" : f.severity === "warning" ? "▲" : "i";
    mark.setAttribute("aria-label", f.severity);
    const text = document.createElement("span");
    text.textContent = f.message;
    row.append(mark, text);
    const smp = f.target?.smpPath;
    if (smp) {
      (row as HTMLButtonElement).type = "button";
      row.title = `${f.code} — show "${smp}"`;
      row.addEventListener("click", () => preflightFrameHandler(smp));
    }
    rows.appendChild(row);
  }
  box.replaceChildren(head, rows);
  box.hidden = false;
}
