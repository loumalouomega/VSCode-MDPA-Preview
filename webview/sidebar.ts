// Collapse behaviour for the left-sidebar sections (Information / Layers / Edit /
// Mesh Modification) and, within Mesh Modification, its subcategory groups
// (Element order & topology / Remeshing (MMG) / Smoothing & renumbering /
// Selection & combination / Fields / Sphere elements). Pure DOM — the markup is
// emitted statically by `src/webviewChrome.ts` (SIDEBAR_HTML). Each
// `.sb-section-header` toggles `collapsed` on its parent `.sb-section`; each
// `.sb-subsection-header` does the same for its nearest `.sb-subsection` —
// `.closest()` stops at the first match, so a subsection header never reaches
// past its own wrapper to the enclosing section. CSS in `webview/style.css`
// hides the body and rotates the chevron for either level. State lives in the
// DOM, which outlives model reloads (only `#stats`/`#outline` are re-filled,
// never the shell).

/** Wire click handlers on every sidebar section/subsection header. Call once after the shell exists. */
export function initSidebarSections(root: ParentNode = document): void {
  wireToggle(root, ".sb-section-header", ".sb-section");
  wireToggle(root, ".sb-subsection-header", ".sb-subsection");
}

function wireToggle(root: ParentNode, headerSelector: string, groupSelector: string): void {
  root.querySelectorAll<HTMLElement>(headerSelector).forEach((header) => {
    header.addEventListener("click", () => toggleGroup(header, groupSelector));
  });
}

function toggleGroup(header: HTMLElement, groupSelector: string): void {
  const group = header.closest<HTMLElement>(groupSelector);
  if (!group) return;
  const collapsed = group.classList.toggle("collapsed");
  header.setAttribute("aria-expanded", collapsed ? "false" : "true");
}
