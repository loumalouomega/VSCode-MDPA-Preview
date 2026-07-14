// The embedded Flowgraph editor pane. When the Flowgraph problemtype is
// selected, the host forks a localhost server and posts `flowgraphReady{url,
// origin}`; we reveal a split pane inside #viewport and point an <iframe> at
// that URL. The iframe is a separate origin, so the two-way ProjectParameters
// bridge (see src/flowgraphMessages.ts + flowgraph-bridge/vscode-bridge.js)
// rides cross-origin postMessage, guarded by the resolved origin.
//
// Layout: #viewport is a flex container holding [#vtk-sub][#flowgraph-resizer]
// [#flowgraph-pane]. Horizontal split = flex-direction:column (flowgraph below);
// vertical = row (flowgraph beside). The existing ResizeObserver on #render-root
// refits the VTK canvas automatically as #vtk-sub's size changes.

import {
  FLOWGRAPH_BRIDGE_NS,
  isBridgeMessage,
  type BridgeToFrame,
} from "../src/flowgraphMessages";

type Orientation = "horizontal" | "vertical";
type PostToHost = (msg: unknown) => void;

const MIN_MESH = 0.15; // keep at least 15% for each pane
const MAX_MESH = 0.85;

let post: PostToHost = () => {};
let viewport: HTMLElement | null = null;
let pane: HTMLElement | null = null;
let resizer: HTMLElement | null = null;
let frame: HTMLIFrameElement | null = null;
let restoreBtn: HTMLElement | null = null;
let orientation: Orientation = "horizontal";
let collapsed = false; // pane hidden but the server/iframe kept alive

let frameOrigin = ""; // origin of the loaded iframe, gates inbound postMessage
let frameReady = false; // the in-iframe bridge announced window.graph is up
let pendingParams: string | null = null; // buffered until frameReady
let meshFraction = 0.6; // share of the split given to the mesh view

/** Wire the pane. Call once after the DOM is ready. `defaultOrientation` from settings. */
export function initFlowgraphPane(
  postMessage: PostToHost,
  defaultOrientation: Orientation = "horizontal"
): void {
  post = postMessage;
  viewport = document.getElementById("viewport");
  pane = document.getElementById("flowgraph-pane");
  resizer = document.getElementById("flowgraph-resizer");
  frame = document.getElementById("flowgraph-frame") as HTMLIFrameElement | null;
  restoreBtn = document.getElementById("flowgraph-restore");
  orientation = defaultOrientation;
  if (!viewport || !pane || !resizer || !frame) return; // e.g. a provider without the pane

  applyOrientation();
  wireResizer();

  const orientBtn = document.getElementById("flowgraph-orient");
  orientBtn?.addEventListener("click", () => {
    orientation = orientation === "horizontal" ? "vertical" : "horizontal";
    applyOrientation();
  });

  // Hide/show: collapse the pane (mesh view fills the viewport) while keeping the
  // server + iframe alive, and a floating chip to bring it back.
  document
    .getElementById("flowgraph-hide")
    ?.addEventListener("click", collapseFlowgraphPane);
  restoreBtn?.addEventListener("click", expandFlowgraphPane);

  // Cross-origin messages relayed from the flowgraph bridge.
  window.addEventListener("message", (event) => {
    if (!frameOrigin || event.origin !== frameOrigin) return;
    if (!isBridgeMessage(event.data)) return;
    const data = event.data;
    if (data.type === "frameReady") {
      frameReady = true;
      if (pendingParams != null) {
        sendToFrame({ ns: FLOWGRAPH_BRIDGE_NS, type: "loadParams", json: pendingParams });
        pendingParams = null;
      }
    } else if (data.type === "exportParams") {
      post({ type: "flowgraphExport", json: data.json });
    }
  });
}

/** Reveal the pane and load the flowgraph server URL (host `flowgraphReady`). */
export function showFlowgraphPane(url: string, origin: string): void {
  if (!viewport || !pane || !resizer || !frame) return;
  frameOrigin = origin;
  frameReady = false;
  collapsed = false;
  restoreBtn?.classList.add("hidden");
  viewport.classList.add("flowgraph-open");
  viewport.classList.remove("flowgraph-collapsed");
  pane.classList.remove("hidden");
  resizer.classList.remove("hidden");
  if (frame.getAttribute("src") !== url) frame.setAttribute("src", url);
}

/** Hide the pane, unload the iframe, and tell the host to release the server. */
export function hideFlowgraphPane(): void {
  if (!viewport || !pane || !resizer || !frame) return;
  if (!viewport.classList.contains("flowgraph-open")) return; // already hidden
  viewport.classList.remove("flowgraph-open");
  viewport.classList.remove("flowgraph-collapsed");
  pane.classList.add("hidden");
  resizer.classList.add("hidden");
  restoreBtn?.classList.add("hidden");
  frame.setAttribute("src", "about:blank");
  frameReady = false;
  frameOrigin = "";
  pendingParams = null;
  collapsed = false;
  post({ type: "flowgraphStop" });
}

/** Collapse the pane so the mesh view fills the viewport, keeping the editor alive. */
export function collapseFlowgraphPane(): void {
  if (!viewport || !pane || !resizer) return;
  if (!viewport.classList.contains("flowgraph-open")) return;
  collapsed = true;
  viewport.classList.add("flowgraph-collapsed");
  pane.classList.add("hidden");
  resizer.classList.add("hidden");
  restoreBtn?.classList.remove("hidden");
}

/** Re-reveal a collapsed pane. */
export function expandFlowgraphPane(): void {
  if (!viewport || !pane || !resizer) return;
  if (!collapsed) return;
  collapsed = false;
  viewport.classList.remove("flowgraph-collapsed");
  pane.classList.remove("hidden");
  resizer.classList.remove("hidden");
  restoreBtn?.classList.add("hidden");
}

/** Push ProjectParameters into the graph (host `flowgraphLoadParams`). Buffered until ready. */
export function loadFlowgraphParams(json: string): void {
  if (frameReady) {
    sendToFrame({ ns: FLOWGRAPH_BRIDGE_NS, type: "loadParams", json });
  } else {
    pendingParams = json;
  }
}

/** True while the flowgraph pane is visible. */
export function isFlowgraphOpen(): boolean {
  return !!viewport?.classList.contains("flowgraph-open");
}

function sendToFrame(msg: BridgeToFrame): void {
  if (frame?.contentWindow && frameOrigin) {
    frame.contentWindow.postMessage(msg, frameOrigin);
  }
}

function applyOrientation(): void {
  if (!viewport) return;
  viewport.classList.toggle("flowgraph-vertical", orientation === "vertical");
  if (resizer) {
    resizer.style.cursor = orientation === "vertical" ? "col-resize" : "row-resize";
  }
  applyFraction();
}

function applyFraction(): void {
  if (!pane) return;
  const pct = (1 - meshFraction) * 100;
  // #vtk-sub is flex:1 and fills the remainder; only the flowgraph pane is
  // sized along the split axis. The cross axis must be pinned to 100% so the
  // pane (and its iframe) fill the full height in vertical / width in horizontal
  // — otherwise the base `height:40%` CSS leaves the vertical pane short.
  if (orientation === "vertical") {
    pane.style.width = `${pct}%`;
    pane.style.height = "100%";
  } else {
    pane.style.height = `${pct}%`;
    pane.style.width = "100%";
  }
}

function wireResizer(): void {
  if (!resizer || !viewport) return;
  let dragging = false;
  const onMove = (e: PointerEvent): void => {
    if (!dragging || !viewport) return;
    const rect = viewport.getBoundingClientRect();
    const frac =
      orientation === "vertical"
        ? (e.clientX - rect.left) / rect.width
        : (e.clientY - rect.top) / rect.height;
    meshFraction = Math.max(MIN_MESH, Math.min(MAX_MESH, frac));
    applyFraction();
  };
  const stop = (): void => {
    if (!dragging) return;
    dragging = false;
    resizer?.classList.remove("dragging");
    document.body.style.userSelect = "";
  };
  resizer.addEventListener("pointerdown", (e) => {
    dragging = true;
    resizer?.classList.add("dragging");
    resizer?.setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  resizer.addEventListener("pointermove", onMove);
  resizer.addEventListener("pointerup", stop);
  resizer.addEventListener("pointercancel", stop);
}
