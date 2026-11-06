// DOM half of the optional ribbon (data in src/parser/ribbonSpec.ts). Renders
// tabs + groups into the static #ribbon container, forwards clicks to the same
// `dispatchToolbarAction` the toolbar and menus use, and mirrors each toggle's
// pressed state. State changes made by the user call `onChange` (view-sidecar
// save); `setState` is silent so restoring a document never echoes a write.

import { TOOLBAR_ICONS } from "../src/toolbarIcons";
import { UI_GLYPHS, glyph, type UiGlyphId } from "../src/uiGlyphs";
import {
  DEFAULT_RIBBON_TAB,
  RIBBON_GROUPS,
  RIBBON_TABS,
  RIBBON_TAB_LABELS,
  sanitizeRibbonTab,
  type RibbonItem,
  type RibbonTabId,
} from "../src/parser/ribbonSpec";

export interface RibbonState {
  tab: RibbonTabId;
  /** Icon-only buttons. */
  compact: boolean;
  /** Body collapsed; the tab strip stays so it can be reopened. */
  hidden: boolean;
}

export const DEFAULT_RIBBON_STATE: RibbonState = { tab: DEFAULT_RIBBON_TAB, compact: false, hidden: false };

export interface RibbonHost {
  root: HTMLElement;
  /** Runs the toolbar action of the same id. */
  dispatch(action: string): void;
  /** Pressed state of a toggle action; undefined = unknown. */
  isPressed(action: string): boolean | undefined;
  /** User changed the state (tab / compact / hidden). */
  onChange(state: RibbonState): void;
}

export interface RibbonHandle {
  getState(): RibbonState;
  setState(s: Partial<RibbonState>): void;
  /** Re-read pressed states (call after any toggle changes). */
  refresh(): void;
}

function iconHtml(spec: string): string {
  const [kind, id] = spec.split(":");
  if (kind === "ic") return `<span class="toolbar-icon">${(TOOLBAR_ICONS as Record<string, string>)[id] ?? ""}</span>`;
  return id in UI_GLYPHS ? glyph(id as UiGlyphId) : "";
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function itemHtml(i: RibbonItem): string {
  return `<button type="button" class="ribbon-btn" data-ribbon-action="${esc(i.action)}"${i.toggle ? ' aria-pressed="false"' : ""} title="${esc(i.title)}" aria-label="${esc(i.title)}">${iconHtml(i.icon)}<span class="ribbon-btn-label">${esc(i.label)}</span></button>`;
}

export function setupRibbon(host: RibbonHost): RibbonHandle {
  const tabsEl = host.root.querySelector<HTMLElement>("#ribbon-tabs")!;
  const bodyEl = host.root.querySelector<HTMLElement>("#ribbon-body")!;
  let state: RibbonState = { ...DEFAULT_RIBBON_STATE };

  tabsEl.innerHTML =
    RIBBON_TABS.map(
      (t) => `<button type="button" role="tab" class="ribbon-tab" data-ribbon-tab="${t}" aria-selected="false">${RIBBON_TAB_LABELS[t]}</button>`,
    ).join("") +
    `<span class="ribbon-tabs-spacer"></span>` +
    `<button type="button" class="ribbon-tool" data-ribbon-tool="compact" aria-pressed="false" title="Icons only">${glyph("grid3")}</button>` +
    `<button type="button" class="ribbon-tool" data-ribbon-tool="hidden" aria-pressed="false" title="Show or hide the ribbon">${glyph("chevronDown")}</button>`;

  function renderBody(): void {
    bodyEl.innerHTML = RIBBON_GROUPS[state.tab]
      .map(
        (g) =>
          `<div class="ribbon-group" role="group" aria-label="${esc(g.label)}"><div class="ribbon-group-items">${g.items.map(itemHtml).join("")}</div><div class="ribbon-group-label">${esc(g.label)}</div></div>`,
      )
      .join("");
    refresh();
  }

  function refresh(): void {
    bodyEl.querySelectorAll<HTMLElement>("button[data-ribbon-action]").forEach((b) => {
      if (!b.hasAttribute("aria-pressed")) return;
      const on = host.isPressed(b.dataset.ribbonAction!) === true;
      b.setAttribute("aria-pressed", String(on));
      b.classList.toggle("active", on);
    });
  }

  function applyState(): void {
    document.body.classList.toggle("ribbon-compact", state.compact);
    document.body.classList.toggle("ribbon-collapsed", state.hidden);
    tabsEl.querySelectorAll<HTMLElement>("button[data-ribbon-tab]").forEach((b) => {
      const on = b.dataset.ribbonTab === state.tab;
      b.setAttribute("aria-selected", String(on));
      b.classList.toggle("active", on);
    });
    tabsEl.querySelector('[data-ribbon-tool="compact"]')?.setAttribute("aria-pressed", String(state.compact));
    tabsEl.querySelector('[data-ribbon-tool="hidden"]')?.setAttribute("aria-pressed", String(!state.hidden));
    renderBody();
  }

  tabsEl.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("button");
    if (!t) return;
    if (t.dataset.ribbonTab) {
      state = { ...state, tab: sanitizeRibbonTab(t.dataset.ribbonTab), hidden: false };
    } else if (t.dataset.ribbonTool === "compact") state = { ...state, compact: !state.compact };
    else if (t.dataset.ribbonTool === "hidden") state = { ...state, hidden: !state.hidden };
    else return;
    applyState();
    host.onChange({ ...state });
  });

  bodyEl.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-ribbon-action]");
    if (!b) return;
    host.dispatch(b.dataset.ribbonAction!);
    // The action may toggle asynchronously; refresh now and on the next frame.
    refresh();
    requestAnimationFrame(refresh);
  });

  host.root.hidden = false;
  applyState();
  return {
    getState: () => ({ ...state }),
    setState(s) {
      state = { ...state, ...s, tab: sanitizeRibbonTab(s.tab ?? state.tab) };
      applyState();
    },
    refresh,
  };
}
