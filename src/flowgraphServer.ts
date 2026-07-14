// A tiny static server for the embedded Flowgraph editor.
//
// Flowgraph (@kratos-flowgraph/flowgraph) ships as an Express app that serves a
// litegraph-based canvas editor out of its `public/` tree, rendering `views/
// index.ejs` with the auto-discovered node/widget module lists. We do NOT spawn
// its own `app.js`: that hardcodes port 8182 (via the `config` package) and
// carries `/upload_json` + `/run_simulation` routes we don't want (the extension
// owns Kratos runs). Instead this wrapper serves the same assets on an ephemeral
// port and injects our cross-origin bridge script.
//
// It bundles cleanly into dist/flowgraphServer.js because we register the EJS
// engine explicitly with `app.engine("ejs", ejs.__express)` — Express's default
// view lookup does a *dynamic* `require("ejs")` that esbuild cannot follow.
//
// Run modes:
//   - forked child (the extension): reads FLOWGRAPH_ASSET_ROOT / FLOWGRAPH_BRIDGE_PATH
//     from env, listens on port 0, reports the assigned port over the IPC channel.
//   - imported (tests): call createFlowgraphApp(opts) and listen(0) yourself.

import fs from "fs";
import path from "path";
import type { Express } from "express";
import express from "express";
import cors from "cors";
import ejs from "ejs";

export interface FlowgraphServerOptions {
  /** Directory containing flowgraph's `public/` and `views/` folders. */
  assetRoot: string;
  /** Absolute path to our `vscode-bridge.js` (served at `/js/vscode-bridge.js`). */
  bridgePath: string;
}

/** Recursively list `.js` files under `dir`, as paths relative to `base` with `/` separators. */
function listJsFiles(dir: string, base: string): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      out.push(...listJsFiles(full, base));
    } else if (name.endsWith(".js")) {
      out.push(path.relative(base, full).split(path.sep).join("/"));
    }
  }
  return out;
}

/** The node/widget module URLs index.ejs injects as `<script type="module">` tags. */
function moduleLists(assetRoot: string): { nodes: string[]; widgets: string[] } {
  const publicDir = path.join(assetRoot, "public");
  return {
    nodes: listJsFiles(path.join(publicDir, "js", "nodes"), publicDir),
    widgets: listJsFiles(path.join(publicDir, "js", "widgets"), publicDir),
  };
}

/** Inject the bridge `<script>` just before `</body>` (leaves flowgraph's files untouched). */
function injectBridge(html: string): string {
  const tag = `<script type="text/javascript" src="js/vscode-bridge.js"></script>`;
  const idx = html.lastIndexOf("</body>");
  return idx === -1 ? html + tag : html.slice(0, idx) + tag + html.slice(idx);
}

/** Build the Express app serving the flowgraph editor + bridge. Pure/testable. */
export function createFlowgraphApp(opts: FlowgraphServerOptions): Express {
  const app = express();
  const publicDir = path.join(opts.assetRoot, "public");

  app.use(cors());
  app.use(express.json({ limit: "50mb" }));

  // Register EJS explicitly so esbuild statically bundles it (no dynamic require).
  // `__express` is ejs's Express engine adapter; @types/ejs omits it, so cast.
  type EngineFn = (
    filePath: string,
    options: object,
    callback: (e: unknown, rendered?: string) => void
  ) => void;
  const ejsEngine = (ejs as unknown as { __express: EngineFn }).__express;
  app.engine("ejs", ejsEngine);
  app.set("view engine", "ejs");
  app.set("views", path.join(opts.assetRoot, "views"));

  // Our bridge, served alongside flowgraph's own assets.
  app.get("/js/vscode-bridge.js", (_req, res) => {
    res.type("application/javascript").sendFile(opts.bridgePath);
  });

  app.use(express.static(publicDir));

  app.get("/", (_req, res, next) => {
    const { nodes, widgets } = moduleLists(opts.assetRoot);
    res.render("index.ejs", { nodes, widgets }, (err, html) => {
      if (err) return next(err);
      res.type("html").send(injectBridge(html));
    });
  });

  return app;
}

/** Fork/child bootstrap: listen on an ephemeral port and report it to the parent. */
function bootstrap(): void {
  const assetRoot = process.env.FLOWGRAPH_ASSET_ROOT;
  const bridgePath = process.env.FLOWGRAPH_BRIDGE_PATH;
  if (!assetRoot || !bridgePath) {
    // eslint-disable-next-line no-console
    console.error("flowgraphServer: FLOWGRAPH_ASSET_ROOT/FLOWGRAPH_BRIDGE_PATH not set");
    process.exit(1);
    return;
  }
  const app = createFlowgraphApp({ assetRoot, bridgePath });
  const server = app.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    const port = addr && typeof addr === "object" ? addr.port : undefined;
    process.send?.({ type: "listening", port });
  });
  server.on("error", (err) => {
    process.send?.({ type: "error", message: String((err as Error).message ?? err) });
    process.exit(1);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on("disconnect", shutdown); // parent went away
  process.on("SIGTERM", shutdown);
}

// Only bootstrap when run as the entry point (esbuild sets this for dist/flowgraphServer.js);
// importing the module for tests must not start a server.
if (require.main === module) {
  bootstrap();
}
