import { RecordFormat, RecordSettings, buildRecordPlan, describePlan } from "../src/parser/recordPlan";
import { CaptureSettings } from "../src/parser/capturePlan";
import { RecordManifest, RecordReview, includedFrames } from "../src/parser/recordSession";
import { renderCaptureControls } from "./screenshotPanel";

export interface RecordPanelState {
  settings: RecordSettings;
  capture: CaptureSettings;
  availableFrames: number;
  progress?: { done: number; total: number };
  canEncode: boolean;
  message?: string;
  draft?: RecordManifest;
  drafts: RecordManifest[];
  selected: number;
  image?: string;
  playing: boolean;
  phase: "Configure" | "Capture" | "Review" | "Export";
}
export interface RecordPanelHandlers {
  onClose(): void; onSettings(next: RecordSettings): void; onCapture(next: CaptureSettings): void;
  onImport(): void; onStart(): void; onCancel(): void;
  onDraft(id: string): void; onDiscard(): void; onSelect(index: number): void;
  onReview(review: RecordReview): void; onPlay(): void; onExport(): void;
}
export function renderRecordPanel(root: HTMLElement, state: RecordPanelState, h: RecordPanelHandlers): void {
  const focus = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement.dataset.recordControl : undefined;
  const captureOpen = root.querySelector("details")?.open ?? false;
  root.replaceChildren();
  const busy = !!state.progress;
  function button(label: string, action: () => void, disabled = false): HTMLButtonElement {
    const el = document.createElement("button"); el.type = "button"; el.textContent = label; el.disabled = disabled; el.className = "panel-btn"; el.dataset.recordControl = label; el.onclick = action; return el;
  }
  function row(label: string, el: HTMLElement): void { const l = document.createElement("label"); l.className = "screenshot-row"; l.append(document.createTextNode(label), el); root.append(l); el.dataset.recordControl = label; }
  function number(label: string, value: number, min: number, max: number, change: (n: number) => void): void {
    const el = document.createElement("input"); el.type = "number"; el.min = String(min); el.max = String(max); el.step = "1"; el.value = String(value); el.disabled = busy; el.onchange = () => change(Number(el.value)); row(label, el);
  }
  function select(label: string, value: string, choices: [string, string][], change: (value: string) => void): void {
    const el = document.createElement("select"); for (const [v, text] of choices) { const o = document.createElement("option"); o.value = v; o.textContent = text; el.append(o); } el.value = value; el.disabled = busy; el.onchange = () => change(el.value); row(label, el);
  }
  const header = document.createElement("div"); header.className = "meshsize-header";
  const title = document.createElement("strong"); title.textContent = `Record · ${state.phase}`; header.append(title, button("Close", h.onClose)); root.append(header);
  const s = state.settings, set = (patch: Partial<RecordSettings>): void => h.onSettings({ ...s, ...patch });
  select("Source", s.source, [["turntable", "Turntable"], ...(state.availableFrames > 1 ? [["timeline", "Time series"] as [string, string]] : [])], value => set({ source: value as RecordSettings["source"] }));
  if (s.source === "timeline") {
    number("First step", s.firstStep ?? 1, 1, state.availableFrames, firstStep => set({ firstStep }));
    number("Last step", s.lastStep ?? state.availableFrames, 1, state.availableFrames, lastStep => set({ lastStep }));
    number("Stride", s.stride ?? 1, 1, Math.max(1, state.availableFrames), stride => set({ stride }));
  } else number("Turntable frames", s.turntableFrames, 2, 720, turntableFrames => set({ turntableFrames }));
  const details = document.createElement("details"); details.open = captureOpen;
  const summary = document.createElement("summary"); summary.textContent = "Capture settings"; details.append(summary);
  details.append(button("Use screenshot settings", h.onImport, busy));
  renderCaptureControls(details, state.capture, busy, h.onCapture); root.append(details);
  let valid = true, description = "";
  try { const plan = buildRecordPlan(s, state.availableFrames); description = describePlan(plan); valid = plan.steps.length > 0; } catch (error) { valid = false; description = String(error); }
  const note = document.createElement("p"); note.textContent = description; root.append(note);
  root.append(button("Capture frames", h.onStart, busy || !valid));
  if (state.drafts.length) select("Saved draft", state.draft?.id ?? "", [["", "Choose a draft"], ...state.drafts.map(d => [d.id, `${d.created.slice(0, 19).replace("T", " ")} · ${d.frames.length} frames${d.status === "partial" ? " · partial" : ""}`] as [string, string])], h.onDraft);
  const d = state.draft;
  if (d?.frames.length) {
    const r = d.review, review = (patch: Partial<RecordReview>): void => h.onReview({ ...r, ...patch });
    const preview = document.createElement("div"); preview.className = "screenshot-preview";
    if (state.image) { const img = document.createElement("img"); img.src = state.image; img.alt = `Captured frame ${state.selected + 1}`; preview.append(img); } root.append(preview);
    const scrub = document.createElement("input"); scrub.type = "range"; scrub.min = "0"; scrub.max = String(d.frames.length - 1); scrub.value = String(state.selected); scrub.disabled = busy; scrub.oninput = () => h.onSelect(Number(scrub.value)); row("Review frame", scrub);
    const label = document.createElement("p"); const f = d.frames[state.selected]; label.textContent = `Frame ${state.selected + 1}: ${f?.labelKind === "time" ? "Time" : "Step"} ${f?.label ?? ""} ${f?.timeUnit ?? ""}`; root.append(label);
    number("Trim first frame", r.first + 1, 1, d.frames.length, value => review({ first: value - 1 }));
    number("Trim last frame", r.last + 1, 1, d.frames.length, value => review({ last: value - 1 }));
    const exclude = document.createElement("input"); exclude.type = "checkbox"; exclude.checked = r.excluded.includes(state.selected); exclude.disabled = busy; exclude.onchange = () => review({ excluded: exclude.checked ? [...r.excluded, state.selected] : r.excluded.filter(i => i !== state.selected) }); row("Exclude this frame", exclude);
    number("Playback FPS", r.fps, 1, s.format === "gif" ? 50 : 60, fps => review({ fps }));
    select("Loop (preview / GIF)", r.loop ? "forever" : "once", [["forever", "Forever"], ["once", "Once"]], value => review({ loop: value === "forever" }));
    const matte = document.createElement("input"); matte.type = "color"; matte.value = r.matte; matte.disabled = busy; matte.onchange = () => review({ matte: matte.value }); row("GIF / WebM matte", matte);
    select("Export format", s.format, [["png", "Numbered PNG frames"], ["gif", "GIF (256 colors)"], ...(state.canEncode ? [["webm", "WebM video"] as [string, string]] : [])], value => set({ format: value as RecordFormat }));
    if (!state.canEncode) { const reason = document.createElement("p"); reason.textContent = "WebM encoding is unavailable in this environment. GIF and PNG remain available."; root.append(reason); }
    const count = includedFrames(d).length; const timing = document.createElement("p"); timing.textContent = `${count} included frames · ${(count / r.fps).toFixed(2)} s. Source time labels do not control playback.`; root.append(timing);
    root.append(button(state.playing ? "Pause preview" : "Play preview", h.onPlay, busy || !count), button("Export…", h.onExport, busy || !count || (s.format === "webm" && !state.canEncode)), button("Discard draft", h.onDiscard, busy));
  } else if (d) root.append(button("Discard draft", h.onDiscard, busy));
  if (state.progress) { const p = document.createElement("progress"); p.max = state.progress.total || 1; p.value = state.progress.done; const label = document.createElement("span"); label.className = "record-progress-label"; label.textContent = `${state.progress.done} / ${state.progress.total}`; root.append(p, label, button("Cancel", h.onCancel)); }
  const message = document.createElement("div"); message.setAttribute("role", "status"); message.textContent = state.message ?? "Captured drafts are stored locally until discarded."; root.append(message);
  if (focus) Array.from(root.querySelectorAll<HTMLElement>("[data-record-control]")).find(el => el.dataset.recordControl === focus)?.focus();
}
