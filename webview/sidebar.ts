// Collapse behaviour for the left-sidebar sections (Layers / Edit / Variables /
// Mesh Modification / Problemtype, plus the Advanced group and the Information
// section inside it) and, within Mesh Modification, its subcategory groups
// (Element order & topology / Remeshing (MMG) / Smoothing & renumbering /
// Selection & combination / Fields / Sphere elements). Pure DOM — the markup is
// emitted statically by `src/webviewChrome.ts` (SIDEBAR_HTML).
//
// Section headers follow CAD-Preview's `collapsiblePanels.ts`: the chevron is a
// real `<button class="panel-chevron">` inside `.sb-section-header`, and the
// header itself is NOT clickable. That is forced by the markup — a header may
// carry its own action buttons (Edit's Undo/Redo/Clear), which a header-wide
// handler would toggle on every click. A button is also focusable and carries
// `aria-expanded` for free; its glyph is rotated by CSS off that attribute, so
// nothing here rewrites its content. `.collapsed` on the `.sb-section` stays the
// state hook (CSS hides the body, other modules test for it).
//
// Each `.sb-subsection-header` toggles `collapsed` on its nearest
// `.sb-subsection` — `.closest()` stops at the first match, so a subsection
// header never reaches past its own wrapper to the enclosing section. State
// lives in the DOM, which outlives model reloads (only `#stats`/`#outline` are
// re-filled, never the shell).

/** Wire the collapse controls on every sidebar section/subsection header. Call once after the shell exists. */
export function initSidebarSections(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>(".sb-section-header .panel-chevron").forEach((chevron) => {
    chevron.addEventListener("click", () => {
      const section = chevron.closest<HTMLElement>(".sb-section");
      if (section) setSectionCollapsed(section, !section.classList.contains("collapsed"));
    });
  });
  root.querySelectorAll<HTMLElement>(".sb-subsection-header").forEach((header) => {
    header.addEventListener("click", () => toggleSubsection(header));
  });
  setupAdvancedGroupCount(root);
}

/**
 * Collapses or expands a `.sb-section`, keeping its chevron's `aria-expanded`
 * and `title` in step. The one mutation point: `initSidebarSections` and
 * `expandSection` both route through it so the class and the attribute cannot
 * disagree.
 */
export function setSectionCollapsed(section: HTMLElement, collapsed: boolean): void {
  section.classList.toggle("collapsed", collapsed);
  // `:scope >` so a group's own chevron is found, never a nested section's.
  const chevron = section.querySelector<HTMLElement>(":scope > .sb-section-header .panel-chevron");
  if (!chevron) return;
  chevron.setAttribute("aria-expanded", collapsed ? "false" : "true");
  chevron.setAttribute("title", collapsed ? "Expand section" : "Collapse section");
}

/** Expands a section (and, for a section nested in Advanced, its group) if collapsed. */
export function expandSection(section: HTMLElement): void {
  const group = section.parentElement?.closest<HTMLElement>(".sb-section");
  if (group?.classList.contains("collapsed")) setSectionCollapsed(group, false);
  if (section.classList.contains("collapsed")) setSectionCollapsed(section, false);
}

function toggleSubsection(header: HTMLElement): void {
  const group = header.closest<HTMLElement>(".sb-subsection");
  if (!group) return;
  const collapsed = group.classList.toggle("collapsed");
  header.setAttribute("aria-expanded", collapsed ? "false" : "true");
}

/**
 * Text for the Advanced header's availability badge: the bare total when every
 * child is available, "n of m" otherwise. Pure, so the wording is testable
 * apart from the DOM that feeds it (CAD-Preview's `advancedCountLabel`).
 */
export function advancedCountLabel(available: number, total: number): string {
  return available === total ? String(total) : `${available} of ${total}`;
}

/**
 * Keeps `#advanced-count` truthful as children hide and show themselves.
 *
 * Observes the `hidden` attribute rather than exposing a refresh every gating
 * site must remember to call: eligibility can change at times this module does
 * not control, and a hand-maintained call list is exactly what drifts. Children
 * are the group's direct `.sb-section` members. Returns without wiring anything
 * when the group is absent.
 */
export function setupAdvancedGroupCount(root: ParentNode = document): void {
  const body = root.querySelector<HTMLElement>("#advanced-body");
  const badge = root.querySelector<HTMLElement>("#advanced-count");
  if (!body || !badge) return;
  const children = Array.from(body.querySelectorAll<HTMLElement>(":scope > .sb-section"));
  if (children.length === 0) return;

  const refresh = (): void => {
    badge.textContent = advancedCountLabel(children.filter((el) => !el.hidden).length, children.length);
  };
  new MutationObserver(refresh).observe(body, { subtree: true, attributes: true, attributeFilter: ["hidden"] });
  refresh();
}
