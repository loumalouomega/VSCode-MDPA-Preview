// Collapse behaviour for the left-sidebar sections (Information / Layers / Edit /
// Mesh Modification). Pure DOM — the markup is emitted statically by
// `src/webviewChrome.ts` (SIDEBAR_HTML). Each `.sb-section-header` toggles a
// `collapsed` class on its parent `.sb-section`; CSS in `webview/style.css` hides
// the body and rotates the chevron. State lives in the DOM, which outlives model
// reloads (only `#stats`/`#outline` are re-filled, never the shell).

/** Wire click handlers on every sidebar section header. Call once after the shell exists. */
export function initSidebarSections(root: ParentNode = document): void {
  const headers = root.querySelectorAll<HTMLElement>(".sb-section-header");
  headers.forEach((header) => {
    header.addEventListener("click", () => toggleSection(header));
  });
}

function toggleSection(header: HTMLElement): void {
  const section = header.closest<HTMLElement>(".sb-section");
  if (!section) return;
  const collapsed = section.classList.toggle("collapsed");
  header.setAttribute("aria-expanded", collapsed ? "false" : "true");
}
