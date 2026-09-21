/**
 * File (Home) menu wiring for the webview.  The menu markup (`#file-menu`) is
 * injected by the providers from `src/webviewChrome.ts`; this module registers
 * it with `dropdownMenu.ts` and forwards item clicks to the extension host,
 * which does all file I/O (Open / Save / Save As / Export).
 */

import { setupDropdown } from "./dropdownMenu";

type PostMessage = (msg: unknown) => void;

/** Wires the #file-menu dropdown. Safe to call once after the DOM is ready. */
export function initFileMenu(postMessage: PostMessage): void {
  const popup = document.getElementById("file-menu-popup");
  // Open/close, one-open-at-a-time, outside-click and Escape dismissal and the
  // arrow-key navigation are `dropdownMenu.ts`'s (shared with the toolbar's
  // View / Advanced menus); this module only routes item clicks.
  const menu = setupDropdown("file-menu-btn", "file-menu-popup");
  if (!popup || !menu) return;

  popup.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>("[data-menu]");
    if (!item) return;
    const kind = item.dataset.menu;
    menu.close();
    if (kind === "open") postMessage({ type: "menuOpen" });
    else if (kind === "reload") postMessage({ type: "menuReload" });
    else if (kind === "save") postMessage({ type: "menuSave" });
    else if (kind === "saveAs") postMessage({ type: "menuSaveAs" });
    else if (kind === "export")
      postMessage({ type: "menuExport", format: item.dataset.format, outputFormat: item.dataset.outputFormat });
    else if (kind === "saveProblem") postMessage({ type: "menuSaveProblem" });
    else if (kind === "loadProblem") postMessage({ type: "menuLoadProblem" });
  });
}
