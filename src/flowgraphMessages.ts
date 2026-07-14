// Shared message-contract for the embedded Flowgraph node editor. Imported by
// the extension host (src/), the webview (webview/), and the tests, so it must
// stay free of any `vscode` or DOM imports.
//
// Three hops carry the two-way ProjectParameters bridge:
//   webview  <->  host   (VS Code postMessage, same trusted origin)
//   webview  <->  iframe (cross-origin postMessage to the localhost server)
// The iframe half is spoken by `flowgraph-bridge/vscode-bridge.js`, injected
// into the served flowgraph page.

/** webview -> host: ask the host to (start and) hand back the server URL. */
export interface FlowgraphStartMsg {
  type: "flowgraphStart";
}
/** webview -> host: the flowgraph pane was hidden; release the shared server. */
export interface FlowgraphStopMsg {
  type: "flowgraphStop";
}
/** webview -> host: flowgraph produced a ProjectParameters.json (relayed from the iframe). */
export interface FlowgraphExportMsg {
  type: "flowgraphExport";
  json: string;
}

/** host -> webview: the server is up; embed `url` (an asExternalUri result), whose `origin` gates postMessage. */
export interface FlowgraphReadyMsg {
  type: "flowgraphReady";
  url: string;
  origin: string;
}
/** host -> webview: the server could not be started. */
export interface FlowgraphErrorMsg {
  type: "flowgraphError";
  message: string;
}
/** host -> webview: seed the graph with the current case's ProjectParameters (relayed into the iframe). */
export interface FlowgraphLoadParamsMsg {
  type: "flowgraphLoadParams";
  json: string;
}

export type FlowgraphHostToWebview =
  | FlowgraphReadyMsg
  | FlowgraphErrorMsg
  | FlowgraphLoadParamsMsg;
export type FlowgraphWebviewToHost =
  | FlowgraphStartMsg
  | FlowgraphStopMsg
  | FlowgraphExportMsg;

// --- webview <-> iframe (cross-origin) -------------------------------------
// These ride raw `window.postMessage`, so they carry a distinct namespace tag
// to avoid colliding with any stray messages on the bus.

export const FLOWGRAPH_BRIDGE_NS = "kratos-flowgraph-bridge" as const;

/** iframe -> webview: `window.graph` exists; the bridge is ready to receive params. */
export interface BridgeFrameReadyMsg {
  ns: typeof FLOWGRAPH_BRIDGE_NS;
  type: "frameReady";
}
/** iframe -> webview: the user hit Generate; here is the resulting ProjectParameters. */
export interface BridgeExportParamsMsg {
  ns: typeof FLOWGRAPH_BRIDGE_NS;
  type: "exportParams";
  json: string;
}
/** webview -> iframe: load these ProjectParameters into the graph. */
export interface BridgeLoadParamsMsg {
  ns: typeof FLOWGRAPH_BRIDGE_NS;
  type: "loadParams";
  json: string;
}

export type BridgeFromFrame = BridgeFrameReadyMsg | BridgeExportParamsMsg;
export type BridgeToFrame = BridgeLoadParamsMsg;

/** Type guard for messages arriving from the flowgraph iframe. */
export function isBridgeMessage(data: unknown): data is BridgeFromFrame {
  return (
    !!data &&
    typeof data === "object" &&
    (data as { ns?: unknown }).ns === FLOWGRAPH_BRIDGE_NS
  );
}
