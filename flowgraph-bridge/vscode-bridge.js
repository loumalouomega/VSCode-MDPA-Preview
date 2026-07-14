/*
 * vscode-bridge.js — injected into the served Flowgraph page by our localhost
 * server (src/flowgraphServer.ts). It runs INSIDE the flowgraph iframe, which
 * is a separate http origin from the VS Code webview, so the only channel to
 * the extension is cross-origin window.postMessage. This script is plain ES5-ish
 * browser JS (jQuery / litegraph globals are available here) and is intentionally
 * defensive: flowgraph internals may change, and a broken bridge must never take
 * the editor down.
 *
 * Protocol mirror of src/flowgraphMessages.ts:
 *   iframe -> parent : { ns, type:"frameReady" }
 *                      { ns, type:"exportParams", json }
 *   parent -> iframe : { ns, type:"loadParams", json }
 */
(function () {
  "use strict";

  var NS = "kratos-flowgraph-bridge";
  var pendingLoad = null; // last loadParams buffered until the graph is ready
  var graphReady = false;

  function toParent(msg) {
    msg.ns = NS;
    try {
      // Content is non-sensitive graph config; the parent validates event.origin
      // against the known flowgraph origin, so "*" here is acceptable.
      window.parent.postMessage(msg, "*");
    } catch (e) {
      /* nothing we can do from inside the iframe */
    }
  }

  // --- inbound: parent -> iframe -------------------------------------------
  window.addEventListener("message", function (event) {
    // Only trust our embedder.
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.ns !== NS) return;
    if (data.type === "loadParams") {
      if (graphReady) applyParams(data.json);
      else pendingLoad = data.json;
    }
  });

  function applyParams(json) {
    try {
      var obj = typeof json === "string" ? JSON.parse(json) : json;
      if (window.graph && typeof window.graph.configure_project_parameters === "function") {
        window.graph.configure_project_parameters(obj);
      }
    } catch (e) {
      /* malformed params: leave the graph as-is */
    }
  }

  // --- readiness handshake --------------------------------------------------
  // window.graph is set by public/js/code.js only after every node module has
  // registered. Poll until it exists, then announce and flush any buffered load.
  var tries = 0;
  var poll = setInterval(function () {
    tries++;
    if (window.graph && typeof window.graph.configure_project_parameters === "function") {
      clearInterval(poll);
      graphReady = true;
      hookGenerate();
      toParent({ type: "frameReady" });
      if (pendingLoad != null) {
        applyParams(pendingLoad);
        pendingLoad = null;
      }
    } else if (tries > 600) {
      // ~30s at 50ms; give up quietly, the editor still works standalone.
      clearInterval(poll);
    }
  }, 50);

  // --- outbound: intercept Generate ----------------------------------------
  // Flowgraph's "Generate" button (#play-graph) runs graph.runStep(), which
  // populates the "Export case files" (IO/DownloadProblem) node's .value with
  // the ProjectParameters. We piggyback: after the graph has stepped, harvest
  // that value and forward it to the extension.
  function hookGenerate() {
    var btn = document.querySelector("#play-graph");
    if (!btn) return;
    btn.addEventListener("click", function () {
      // Deferred so flowgraph's own click handler has run graph.runStep() first.
      setTimeout(harvestAndPost, 200);
    });
  }

  function harvestAndPost() {
    var json = harvestProjectParameters();
    if (json != null) toParent({ type: "exportParams", json: json });
  }

  function harvestProjectParameters() {
    try {
      var g = window.graph;
      if (!g || !g._nodes) return null;
      for (var i = 0; i < g._nodes.length; i++) {
        var n = g._nodes[i];
        var isExport =
          (n.constructor && n.constructor.title === "Export case files") ||
          n.type === "IO/DownloadProblem";
        if (isExport && n.value != null) {
          return n.value.constructor === String
            ? n.value
            : JSON.stringify(n.value);
        }
      }
    } catch (e) {
      /* fall through */
    }
    return null;
  }
})();
