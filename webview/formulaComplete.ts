/**
 * Shared popup list component for formula and caption token name completion
 * (roadmap item 85). Attached to the Field calculator, Remesh size formula,
 * Variables formula rows, Formula selection seeds, and Screenshot title/caption.
 */

import {
  applyFormulaCompletion,
  matchCaptionCompletions,
  matchExprCompletions,
  type CaptionCompletionContext,
  type CompletionMatch,
  type FormulaCompletionItem,
} from "../src/parser/formulaComplete";

type InputEl = HTMLInputElement | HTMLTextAreaElement;

interface ActiveSession {
  input: InputEl;
  match: CompletionMatch;
  activeIndex: number;
}

let popupEl: HTMLDivElement | null = null;
let session: ActiveSession | null = null;

function ensurePopup(): HTMLDivElement {
  if (popupEl) return popupEl;
  const el = document.createElement("div");
  el.id = "formula-complete";
  el.className = "formula-complete hidden";
  el.setAttribute("role", "listbox");
  el.addEventListener("mousedown", (e) => {
    // Keep focus on the input so blur does not dismiss before click/accept.
    e.preventDefault();
    const row = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-fc-index]");
    if (!row || !session) return;
    const idx = Number(row.dataset.fcIndex);
    if (Number.isInteger(idx) && idx >= 0 && idx < session.match.items.length) {
      accept(idx);
    }
  });
  document.body.appendChild(el);
  popupEl = el;
  return el;
}

export function closeFormulaCompletion(): void {
  session = null;
  if (popupEl) {
    popupEl.classList.add("hidden");
    popupEl.innerHTML = "";
  }
}

function positionPopup(el: HTMLDivElement, input: InputEl): void {
  const rect = input.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(Math.max(rect.width, 220), Math.min(340, vw - 16));
  const left = Math.max(8, Math.min(rect.left, vw - width - 8));
  el.style.width = `${width}px`;
  el.style.left = `${left}px`;

  const estHeight = Math.min(220, el.scrollHeight || 180);
  const spaceBelow = vh - rect.bottom - 8;
  const spaceAbove = rect.top - 8;
  if (spaceBelow >= estHeight || spaceBelow >= spaceAbove) {
    el.style.top = `${Math.min(vh - 40, rect.bottom + 2)}px`;
    el.style.bottom = "";
  } else {
    el.style.top = "";
    el.style.bottom = `${vh - rect.top + 2}px`;
  }
}

function renderPopup(): void {
  if (!session) {
    closeFormulaCompletion();
    return;
  }
  const el = ensurePopup();
  el.innerHTML = "";
  const { items } = session.match;
  const maxShow = Math.min(items.length, 40);
  for (let i = 0; i < maxShow; i++) {
    const item = items[i];
    const row = document.createElement("div");
    row.className = "fc-item" + (i === session.activeIndex ? " active" : "");
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", i === session.activeIndex ? "true" : "false");
    row.dataset.fcIndex = String(i);

    const label = document.createElement("span");
    label.className = "fc-label";
    label.textContent = item.label;

    const meta = document.createElement("span");
    meta.className = "fc-meta";
    meta.textContent = item.unit ? `${item.detail} · ${item.unit}` : item.detail;

    row.append(label, meta);
    el.appendChild(row);
  }
  el.classList.remove("hidden");
  positionPopup(el, session.input);
  el.querySelector<HTMLElement>(".fc-item.active")?.scrollIntoView({ block: "nearest" });
}

function accept(index: number): void {
  if (!session) return;
  const { input, match } = session;
  const item = match.items[index];
  if (!item) return;
  const applied = applyFormulaCompletion(input.value, match.start, match.end, item);
  closeFormulaCompletion();
  input.value = applied.text;
  input.setSelectionRange(applied.cursor, applied.cursor);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function attachMatcher(
  input: InputEl,
  matchAt: (text: string, cursor: number, force: boolean) => CompletionMatch | null
): () => void {
  if (input.dataset.fcAttached === "1") return () => {};
  input.dataset.fcAttached = "1";

  const refresh = (force: boolean): void => {
    const cursor = input.selectionStart ?? input.value.length;
    const match = matchAt(input.value, cursor, force);
    if (!match || match.items.length === 0) {
      if (session?.input === input) closeFormulaCompletion();
      return;
    }
    session = { input, match, activeIndex: 0 };
    renderPopup();
  };

  const onInput = (): void => refresh(false);
  const onBlur = (): void => {
    if (session?.input === input) closeFormulaCompletion();
  };
  const onKeyDown = (e: Event): void => {
    const ke = e as KeyboardEvent;
    if (ke.ctrlKey && (ke.code === "Space" || ke.key === " ")) {
      ke.preventDefault();
      ke.stopPropagation();
      refresh(true);
      return;
    }
    if (!session || session.input !== input) return;
    if (ke.key === "ArrowDown") {
      ke.preventDefault();
      ke.stopPropagation();
      const count = Math.min(session.match.items.length, 40);
      session.activeIndex = (session.activeIndex + 1) % count;
      renderPopup();
    } else if (ke.key === "ArrowUp") {
      ke.preventDefault();
      ke.stopPropagation();
      const count = Math.min(session.match.items.length, 40);
      session.activeIndex = (session.activeIndex - 1 + count) % count;
      renderPopup();
    } else if (ke.key === "Enter" || ke.key === "Tab") {
      ke.preventDefault();
      ke.stopPropagation();
      accept(session.activeIndex);
    } else if (ke.key === "Escape") {
      ke.preventDefault();
      ke.stopPropagation();
      closeFormulaCompletion();
    }
  };

  input.addEventListener("input", onInput);
  input.addEventListener("blur", onBlur);
  input.addEventListener("keydown", onKeyDown);

  return () => {
    delete input.dataset.fcAttached;
    input.removeEventListener("input", onInput);
    input.removeEventListener("blur", onBlur);
    input.removeEventListener("keydown", onKeyDown);
    if (session?.input === input) closeFormulaCompletion();
  };
}

export function attachExprCompletion(input: InputEl, getItems: () => FormulaCompletionItem[]): () => void {
  return attachMatcher(input, (text, cursor, force) =>
    matchExprCompletions(text, cursor, getItems(), { minPrefix: 2, force })
  );
}

export function attachCaptionCompletion(
  input: InputEl,
  getContext: () => CaptionCompletionContext
): () => void {
  return attachMatcher(input, (text, cursor, force) =>
    matchCaptionCompletions(text, cursor, getContext(), { minPrefix: 2, force })
  );
}
