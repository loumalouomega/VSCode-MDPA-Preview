/**
 * DOM building blocks for the Problemtype sidebar (webview/problemtype.ts):
 * stage captions, collapsible cards and sub-groups, header chips and the icon
 * tile. Kept apart from the case-state logic so that file stays about the
 * case, not about markup.
 *
 * Collapse state lives in a module-level map keyed by the caller. The sidebar
 * rebuilds every block on each render (an assignment is added, the model's
 * SubModelParts change, a preset filter keystroke…), and a block that forgot
 * whether the user had opened it made every such event snap the whole panel
 * back to its defaults.
 *
 * Declaration text is always set via textContent — user problemtypes are
 * untrusted strings. The only innerHTML is generated, trusted icon markup from
 * src/toolbarIcons.ts, and only for ids that exist in that table.
 */

import { TOOLBAR_ICONS, ToolbarIconId } from "../src/toolbarIcons";

const collapseState = new Map<string, boolean>();

/** True when `id` names a real toolbar icon (user declarations may name anything). */
export function isIconId(id: string | undefined): id is ToolbarIconId {
  return id !== undefined && Object.prototype.hasOwnProperty.call(TOOLBAR_ICONS, id);
}

/** An inline icon, or nothing when the id is unknown. */
export function iconSpan(id: string | undefined, className = "toolbar-icon"): HTMLElement | undefined {
  if (!isIconId(id)) return undefined;
  const span = document.createElement("span");
  span.className = className;
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = TOOLBAR_ICONS[id]; // generated, trusted markup — never user strings
  return span;
}

/** Collapsed state for `key`, falling back to `dflt` until the user toggles it. */
export function isCollapsed(key: string, dflt: boolean): boolean {
  return collapseState.get(key) ?? dflt;
}

export function setCollapsed(key: string, value: boolean): void {
  collapseState.set(key, value);
}

/** Forgets every remembered toggle (tests / a problemtype switch that wants defaults). */
export function resetCollapseState(): void {
  collapseState.clear();
}

/**
 * A stage caption: a small uppercase label with a hairline running out of it,
 * the separator between the sidebar's logical stages (Domain, Conditions,
 * Solution, Results).
 */
export function stageCaption(text: string, icon?: string): HTMLElement {
  const sep = document.createElement("div");
  sep.className = "pt-sep";
  sep.setAttribute("role", "separator");
  const glyph = iconSpan(icon);
  if (glyph) sep.appendChild(glyph);
  const label = document.createElement("span");
  label.className = "pt-sep-label";
  label.textContent = text;
  sep.appendChild(label);
  return sep;
}

export interface BlockOptions {
  /** Collapse-store key (should include the problemtype id). */
  key: string;
  title: string;
  /** Collapsed until the user says otherwise. */
  collapsed?: boolean;
  icon?: string;
  /** A small badge after the title, e.g. the number of applied rows. */
  count?: number;
}

/**
 * A collapsible `.edit-form` card: chevron, icon, title, optional count badge.
 * Same markup the Edit forms use, so the shared `.edit-form*` rules apply.
 */
export function cardBlock(o: BlockOptions): { form: HTMLElement; body: HTMLElement } {
  const form = document.createElement("div");
  form.className = "edit-form pt-card";
  const titleBtn = document.createElement("button");
  titleBtn.type = "button";
  titleBtn.className = "edit-form-title";
  const chevron = document.createElement("span");
  chevron.className = "sb-chevron";
  const label = document.createElement("span");
  label.className = "pt-card-title";
  label.textContent = o.title;
  titleBtn.append(chevron);
  const glyph = iconSpan(o.icon);
  if (glyph) titleBtn.append(glyph);
  titleBtn.append(label);
  if (o.count !== undefined && o.count > 0) titleBtn.append(countBadge(o.count));
  const body = document.createElement("div");
  body.className = "pt-form-body";
  const apply = (collapsed: boolean): void => {
    form.classList.toggle("collapsed", collapsed);
    titleBtn.setAttribute("aria-expanded", String(!collapsed));
  };
  apply(isCollapsed(o.key, o.collapsed === true));
  titleBtn.addEventListener("click", () => {
    const next = !form.classList.contains("collapsed");
    setCollapsed(o.key, next);
    apply(next);
  });
  form.append(titleBtn, body);
  return { form, body };
}

/**
 * A nested group inside a card (a field group, a condition branch): a ruled
 * subhead with chevron, icon and label — the Mesh Modification subsections'
 * visual language, with its own toggle wiring because sidebar.ts only wires
 * static markup at startup.
 */
export function groupBlock(o: BlockOptions): { group: HTMLElement; body: HTMLElement } {
  const group = document.createElement("div");
  group.className = "pt-group";
  const header = document.createElement("button");
  header.type = "button";
  header.className = "pt-group-header";
  const chevron = document.createElement("span");
  chevron.className = "sb-chevron";
  header.append(chevron);
  const glyph = iconSpan(o.icon);
  if (glyph) header.append(glyph);
  const label = document.createElement("span");
  label.className = "pt-group-title";
  label.textContent = o.title;
  header.append(label);
  if (o.count !== undefined && o.count > 0) header.append(countBadge(o.count));
  const body = document.createElement("div");
  body.className = "pt-group-body";
  const apply = (collapsed: boolean): void => {
    group.classList.toggle("collapsed", collapsed);
    header.setAttribute("aria-expanded", String(!collapsed));
  };
  apply(isCollapsed(o.key, o.collapsed === true));
  header.addEventListener("click", () => {
    const next = !group.classList.contains("collapsed");
    setCollapsed(o.key, next);
    apply(next);
  });
  group.append(header, body);
  return { group, body };
}

export function countBadge(n: number): HTMLElement {
  const badge = document.createElement("span");
  badge.className = "pt-count";
  badge.textContent = String(n);
  return badge;
}

export interface HeaderInfo {
  name: string;
  description?: string;
  icon?: string;
  /** "workspace · js" style provenance for non-built-in problemtypes. */
  origin?: string;
  chips: string[];
}

/** The problemtype header card: logo tile, name, description, origin badge, summary chips. */
export function headerCard(info: HeaderInfo): HTMLElement {
  const card = document.createElement("div");
  card.className = "pt-header";
  const tile = document.createElement("div");
  tile.className = "pt-logo";
  tile.appendChild(iconSpan(isIconId(info.icon) ? info.icon : "problemtype")!);
  const text = document.createElement("div");
  text.className = "pt-header-text";
  const name = document.createElement("div");
  name.className = "pt-header-name";
  name.textContent = info.name;
  if (info.origin) {
    const origin = document.createElement("span");
    origin.className = "pt-origin";
    origin.textContent = info.origin;
    name.appendChild(origin);
  }
  text.appendChild(name);
  if (info.description) {
    const desc = document.createElement("div");
    desc.className = "pt-header-desc";
    desc.textContent = info.description;
    desc.title = info.description;
    text.appendChild(desc);
  }
  const chips = document.createElement("div");
  chips.className = "pt-chips";
  for (const c of info.chips) {
    const chip = document.createElement("span");
    chip.className = "pt-chip";
    chip.textContent = c;
    chips.appendChild(chip);
  }
  text.appendChild(chips);
  card.append(tile, text);
  return card;
}
