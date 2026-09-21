// The DOM half of the menubar's document chip and the status bar. All wording
// comes from the pure, unit-tested `src/statusStats.ts`; this file only writes
// it into the elements `src/webviewChrome.ts` emits, and — like every other
// setter in this bundle — treats a missing element as a no-op rather than a
// throw (the screenshot harness and some tests ship a stripped-down page).
//
// Every fact cell ships `hidden` and is shown only while it has text, so an
// empty cell never leaves a stray gap or separator.

import type { DocumentInfoMessage } from "../src/documentInfo";
import {
  describeEngineState,
  EngineState,
  formatFrame,
  formatModelCounts,
  formatPick,
  ModelCounts,
  PickInfo,
  unsavedEditsLabel,
} from "../src/statusStats";

const el = (id: string): HTMLElement | null => document.getElementById(id);

/** Writes `text` into a fact cell and shows it only when there is some. */
function setCell(id: string, text: string): void {
  const cell = el(id);
  if (!cell) return;
  cell.textContent = text;
  cell.hidden = text === "";
}

/**
 * Fills the menubar's document chip. Everything goes through `textContent` /
 * `title`: the name is a filename, i.e. untrusted document-derived text, and
 * must never reach `innerHTML`.
 */
export function applyDocumentInfo(msg: DocumentInfoMessage): void {
  const chip = el("doc-chip");
  const name = el("doc-chip-name");
  const format = el("doc-chip-format");
  const dot = el("doc-chip-dirty");
  const unsaved = el("doc-chip-unsaved");
  if (!chip || !name || !format || !dot) return;
  name.textContent = msg.name;
  format.textContent = msg.format ?? "";
  chip.title = msg.path;
  dot.hidden = !msg.dirty;
  // "3 unsaved edits" — a count, never a verdict. Empty when clean, so the span
  // collapses instead of leaving a gap in the chip.
  if (unsaved) unsaved.textContent = unsavedEditsLabel(msg.dirty ? msg.unsavedEdits : 0);
  chip.hidden = false;
}

/** The status bar's engine cell: text + a dot whose colour follows `data-tone`. */
export function setEngineStatus(state: EngineState): void {
  const box = el("engine-status");
  const text = el("engine-status-text");
  if (!box || !text) return;
  const d = describeEngineState(state);
  text.textContent = d.text;
  box.dataset.tone = d.tone;
}

/** "12,345 nodes · 6,789 elements · 42 conditions"; `undefined` (no model) empties the cell. */
export function setModelCounts(counts: ModelCounts | undefined): void {
  setCell("sb-count-model", counts ? formatModelCounts(counts) : "");
}

/** The timeline position; anything without a real timeline (`total <= 1`) empties the cell. */
export function setFrameStatus(frameIndex: number, totalFrames: number, stepLabel?: string): void {
  setCell("sb-count-frame", formatFrame(frameIndex, totalFrames, stepLabel));
}

export function clearFrameStatus(): void {
  setCell("sb-count-frame", "");
}

/** The last Inspect pick; `undefined` empties the cell. */
export function setPickStatus(pick: PickInfo | undefined): void {
  setCell("sb-cursor", formatPick(pick));
}
