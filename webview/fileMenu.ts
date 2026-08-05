/**
 * File (Home) menu wiring for the webview.  The menu markup (`#file-menu`) is
 * injected by the providers from `src/webviewChrome.ts`; this module only owns
 * the open/close toggle and forwards item clicks to the extension host, which
 * does all file I/O (Open / Save / Save As / Export).
 */

type PostMessage = (msg: unknown) => void;

/** Wires the #file-menu dropdown. Safe to call once after the DOM is ready. */
export function initFileMenu(postMessage: PostMessage): void {
  const root = document.getElementById("file-menu");
  const btn = document.getElementById("file-menu-btn");
  const popup = document.getElementById("file-menu-popup");
  if (!root || !btn || !popup) return;

  const setOpen = (open: boolean): void => {
    popup.classList.toggle("hidden", !open);
    btn.setAttribute("aria-expanded", String(open));
  };
  const close = (): void => setOpen(false);

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(popup.classList.contains("hidden"));
  });

  popup.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>("[data-menu]");
    if (!item) return;
    const menu = item.dataset.menu;
    close();
    if (menu === "open") postMessage({ type: "menuOpen" });
  else if (menu === "reload") postMessage({ type: "menuReload" });
    else if (menu === "save") postMessage({ type: "menuSave" });
    else if (menu === "saveAs") postMessage({ type: "menuSaveAs" });
    else if (menu === "export") postMessage({ type: "menuExport", format: item.dataset.format });
    else if (menu === "saveProblem") postMessage({ type: "menuSaveProblem" });
    else if (menu === "loadProblem") postMessage({ type: "menuLoadProblem" });
  });

  // Dismiss on outside click or Escape.
  document.addEventListener("click", (e) => {
    if (!root.contains(e.target as Node)) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
}
