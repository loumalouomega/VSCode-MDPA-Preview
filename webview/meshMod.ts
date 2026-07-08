/**
 * Mesh Modification sidebar wiring for the webview.  The section markup lives in
 * `src/webviewChrome.ts` (SIDEBAR_HTML); this module only forwards the modifier
 * clicks to the extension host, which runs the transform on its loaded model and
 * re-posts the result so the preview rebuilds.
 */

type PostMessage = (msg: unknown) => void;

/** Wires the Mesh Modification buttons. Safe to call once after the DOM is ready. */
export function initMeshMod(postMessage: PostMessage): void {
  const quadratic = document.getElementById("mesh-mod-quadratic");
  quadratic?.addEventListener("click", () => {
    postMessage({ type: "meshMod", op: "linearToQuadratic" });
  });
}
