/**
 * The video recorder panel.
 *
 * Pure DOM, the clear-and-rebuild shape of the other floating panels, reusing
 * their `.meshsize-*` chrome. It decides nothing: the frame plan comes from
 * `src/parser/recordPlan.ts` (which is unit-tested) and the capture from
 * `videoRecord.ts`.
 */

import {
  RecordFormat,
  RecordSettings,
  RecordSource,
  buildRecordPlan,
  describePlan,
} from "../src/parser/recordPlan";
import { TOOLBAR_ICONS } from "../src/toolbarIcons";

export interface RecordPanelState {
  settings: RecordSettings;
  /** Timeline length; 0 or 1 means there is nothing to play through. */
  availableFrames: number;
  /** Set while a recording is running. */
  progress?: { done: number; total: number };
  /** Whether this environment can encode video at all. */
  canEncode: boolean;
  message?: string;
}

export interface RecordPanelHandlers {
  onClose(): void;
  onSettings(next: RecordSettings): void;
  onStart(): void;
  onCancel(): void;
}

export function renderRecordPanel(
  container: HTMLElement,
  state: RecordPanelState,
  handlers: RecordPanelHandlers
): void {
  container.textContent = "";

  const header = document.createElement("div");
  header.className = "meshsize-header";
  const title = document.createElement("div");
  title.className = "meshsize-title";
  title.textContent = "Record";
  header.appendChild(title);
  const close = document.createElement("button");
  close.className = "meshsize-close";
  close.title = "Close";
  close.innerHTML = `<span class="toolbar-icon">${TOOLBAR_ICONS.close}</span>`;
  close.addEventListener("click", () => handlers.onClose());
  header.appendChild(close);
  container.appendChild(header);

  const running = state.progress !== undefined;
  const s = state.settings;
  const set = (next: Partial<RecordSettings>): void =>
    handlers.onSettings({ ...s, ...next });

  // --- source
  const sources = document.createElement("div");
  sources.className = "meshsize-modes";
  const timelineDisabled = state.availableFrames < 2;
  for (const [id, label] of [
    ["turntable", "Turntable"],
    ["timeline", "Time series"],
  ] as [RecordSource, string][]) {
    const btn = document.createElement("button");
    btn.className = "meshsize-mode-btn";
    if (s.source === id) btn.classList.add("active");
    btn.textContent = label;
    btn.disabled = running || (id === "timeline" && timelineDisabled);
    if (id === "timeline" && timelineDisabled) {
      btn.title = "This preview has no time series to play through.";
    }
    btn.addEventListener("click", () => set({ source: id }));
    sources.appendChild(btn);
  }
  container.appendChild(sources);

  const numberRow = (
    label: string,
    value: number,
    min: number,
    max: number,
    apply: (n: number) => void
  ): HTMLElement => {
    const row = document.createElement("div");
    row.className = "field-row";
    const l = document.createElement("label");
    l.className = "field-label";
    l.textContent = label;
    row.appendChild(l);
    const input = document.createElement("input");
    input.type = "number";
    input.className = "field-select";
    input.value = String(value);
    input.min = String(min);
    input.max = String(max);
    input.disabled = running;
    input.addEventListener("change", () => apply(Number(input.value)));
    row.appendChild(input);
    return row;
  };

  container.appendChild(numberRow("FPS", s.fps, 1, 60, (n) => set({ fps: n })));
  if (s.source === "turntable") {
    container.appendChild(
      numberRow("Frames", s.turntableFrames, 2, 720, (n) => set({ turntableFrames: n }))
    );
  }

  // --- format
  const formats = document.createElement("div");
  formats.className = "meshsize-modes";
  for (const [id, label] of [
    ["webm", "WebM video"],
    ["png", "PNG frames"],
  ] as [RecordFormat, string][]) {
    const btn = document.createElement("button");
    btn.className = "meshsize-mode-btn";
    if (s.format === id) btn.classList.add("active");
    btn.textContent = label;
    btn.disabled = running || (id === "webm" && !state.canEncode);
    if (id === "webm" && !state.canEncode) {
      btn.title = "This environment cannot encode video; record PNG frames instead.";
    }
    if (id === "png") {
      btn.title = "One numbered PNG per frame — the route to mp4 via ffmpeg.";
    }
    btn.addEventListener("click", () => set({ format: id }));
    formats.appendChild(btn);
  }
  container.appendChild(formats);

  const plan = buildRecordPlan(s, state.availableFrames);
  const summary = document.createElement("div");
  summary.className = "meshsize-summary";
  summary.textContent = state.message ?? describePlan(plan);
  container.appendChild(summary);

  if (s.source === "turntable") {
    const note = document.createElement("div");
    note.className = "meshsize-summary";
    // Every other camera action in the app targets the focused pane; spinning
    // all of them would destroy the comparison a split view exists for.
    note.textContent = "The turntable spins the focused pane.";
    container.appendChild(note);
  }

  if (running) {
    const p = state.progress!;
    const bar = document.createElement("div");
    bar.className = "series-bar";
    const fill = document.createElement("div");
    fill.className = "series-bar-fill";
    fill.style.width = `${p.total > 0 ? Math.round((p.done / p.total) * 100) : 0}%`;
    bar.appendChild(fill);
    container.appendChild(bar);
    const count = document.createElement("div");
    count.className = "meshsize-summary";
    count.textContent = `Frame ${p.done} / ${p.total}…`;
    container.appendChild(count);
  }

  const actions = document.createElement("div");
  actions.className = "meshsize-modes";
  const go = document.createElement("button");
  go.className = "meshsize-mode-btn";
  go.textContent = running ? "Cancel" : "Record";
  go.disabled = !running && plan.steps.length === 0;
  go.addEventListener("click", () => (running ? handlers.onCancel() : handlers.onStart()));
  actions.appendChild(go);
  container.appendChild(actions);
}
