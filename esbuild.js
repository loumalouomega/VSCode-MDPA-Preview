// Bundles the extension host (CommonJS for the Node VS Code runtime) and the
// webview script (ESM/IIFE for the browser-like webview) in one step.
// Never run `tsc` to emit the shipped code — esbuild owns that; `tsc` is only
// used for type-checking (`npm run typecheck`) and compiling tests.
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

// Copy the webview stylesheet (kept as source under webview/) into the shipped
// media/ folder, which is the webview's only allowed local resource root.
const copyStylePlugin = {
  name: "copy-style",
  setup(build) {
    build.onEnd(() => {
      const out = path.join(__dirname, "media");
      fs.mkdirSync(out, { recursive: true });
      fs.copyFileSync(
        path.join(__dirname, "webview", "style.css"),
        path.join(out, "style.css")
      );
    });
  },
};

// The MMG WASM binary must sit next to the bundled extension host: activation
// feeds it to initialize({ wasmBinary }) because the Emscripten loader's own
// file lookup breaks once mmg.cjs is bundled away from its package dir.
const copyWasmPlugin = {
  name: "copy-mmg-wasm",
  setup(build) {
    build.onEnd(() => {
      const out = path.join(__dirname, "dist");
      fs.mkdirSync(out, { recursive: true });
      fs.copyFileSync(
        path.join(
          __dirname,
          "node_modules",
          "@loumalouomega",
          "mmg-wasm",
          "dist",
          "mmg-core.wasm"
        ),
        path.join(out, "mmg-core.wasm")
      );
    });
  },
};

// Python problemtypes: the pyodide runtime files are copied verbatim into
// dist/pyodide/ (the loader locates its .wasm/.zip siblings relative to its
// own file, so it must never be bundled — see the `external` entry), and the
// python authoring module ships as dist/problemtypes/kratos_problemtype.py.
const PYODIDE_FILES = [
  "pyodide.js",
  "pyodide.mjs",
  "pyodide.asm.mjs",
  "pyodide.asm.wasm",
  "python_stdlib.zip",
  "pyodide-lock.json",
];
const copyPyodidePlugin = {
  name: "copy-pyodide",
  setup(build) {
    build.onEnd(() => {
      const src = path.join(__dirname, "node_modules", "pyodide");
      const out = path.join(__dirname, "dist", "pyodide");
      fs.mkdirSync(out, { recursive: true });
      for (const file of PYODIDE_FILES) {
        fs.copyFileSync(path.join(src, file), path.join(out, file));
      }
      const ptOut = path.join(__dirname, "dist", "problemtypes");
      fs.mkdirSync(ptOut, { recursive: true });
      fs.copyFileSync(
        path.join(__dirname, "assets", "kratos_problemtype.py"),
        path.join(ptOut, "kratos_problemtype.py")
      );
    });
  },
};

// Extended mesh formats: @meshioplusplus/wasm is ESM-only and its Emscripten
// glue reads import.meta.url, which an esbuild ESM->CJS rewrite would turn
// into undefined — so it is never bundled (see the `external` entry) and ships
// verbatim instead, like pyodide. src/parser/meshio.ts pulls it in through a
// runtime dynamic import and hands it a locateFile pointing at the .wasm here.
// The src/ <- dist/ layout MUST be preserved: src/index.mjs imports
// '../dist/meshioplusplus_wasm.mjs'.
//
// Since 8.8.0 there are TWO native artifacts and index.mjs's resolveVariant()
// picks the threaded `_mt` one under Node — i.e. in the extension host — so
// both pairs must ship or the packaged extension cannot open any meshio format
// at all. That is the ~6.2 MB the _mt.wasm adds to the .vsix; the mt glue finds
// its own pthread worker relative to its file, so no other change is needed.
const copyMeshioPlugin = {
  name: "copy-meshio",
  setup(build) {
    build.onEnd(() => {
      const src = path.join(__dirname, "node_modules", "@meshioplusplus", "wasm");
      const out = path.join(__dirname, "dist", "meshio");
      fs.mkdirSync(path.join(out, "src"), { recursive: true });
      fs.mkdirSync(path.join(out, "dist"), { recursive: true });
      fs.copyFileSync(
        path.join(src, "src", "index.mjs"),
        path.join(out, "src", "index.mjs")
      );
      for (const file of [
        "meshioplusplus_wasm.mjs",
        "meshioplusplus_wasm.wasm",
        "meshioplusplus_wasm_mt.mjs",
        "meshioplusplus_wasm_mt.wasm",
      ]) {
        fs.copyFileSync(path.join(src, "dist", file), path.join(out, "dist", file));
      }
      // package.json records the shipped version; the rest is attribution.
      // The published tarball currently carries no LICENSE (the MIT text lives
      // at the meshio++ repo root, outside the wasm/ package dir), so guard it.
      for (const file of ["package.json", "README.md", "LICENSE"]) {
        const from = path.join(src, file);
        if (fs.existsSync(from)) fs.copyFileSync(from, path.join(out, file));
      }
    });
  },
};

// Flowgraph (the embedded node editor) ships as a static asset tree that its
// Express server serves. dist/flowgraphServer.js (a third extension entry, see
// below) serves these on an ephemeral port; here we copy the pristine public/
// + views/ from the installed package into dist/flowgraph/, plus our own
// cross-origin bridge client. The package's own app.js/config are not shipped.
const copyFlowgraphPlugin = {
  name: "copy-flowgraph",
  setup(build) {
    build.onEnd(() => {
      const src = path.join(
        __dirname,
        "node_modules",
        "@kratos-flowgraph",
        "flowgraph"
      );
      const out = path.join(__dirname, "dist", "flowgraph");
      fs.mkdirSync(out, { recursive: true });
      for (const dir of ["public", "views"]) {
        fs.cpSync(path.join(src, dir), path.join(out, dir), {
          recursive: true,
        });
      }
      // Flowgraph is AGPL-3.0 — ship its licence next to the served assets.
      fs.copyFileSync(path.join(src, "LICENSE"), path.join(out, "LICENSE"));
      // Our bridge client, injected into the served page by flowgraphServer.ts.
      fs.copyFileSync(
        path.join(__dirname, "flowgraph-bridge", "vscode-bridge.js"),
        path.join(out, "vscode-bridge.js")
      );
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  // mmgWorker.js is the worker-thread entry the extension spawns per MMG run
  // (src/mmgWorkerClient.ts); it must sit next to extension.js + the wasm.
  // mcpServer.js is the standalone stdio MCP server (plain `node`, no VS Code).
  entryPoints: [
    "src/extension.ts",
    "src/mmgWorker.ts",
    "src/mcpServer.ts",
    "src/flowgraphServer.ts",
  ],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outdir: "dist",
  // pyodide stays external: in dev it resolves from node_modules; in the
  // packaged extension pyRuntime.ts falls back to dist/pyodide/pyodide.js.
  // @meshioplusplus/wasm likewise (see copyMeshioPlugin): ESM-only, and its
  // glue's import.meta.url does not survive a CJS bundle. The "/*" entry
  // matters — meshio.ts's require.resolve("@meshioplusplus/wasm/package.json")
  // is a literal esbuild would otherwise try to resolve at build time.
  external: ["vscode", "pyodide", "@meshioplusplus/wasm", "@meshioplusplus/wasm/*"],
  sourcemap: !production,
  minify: production,
  logLevel: "info",
  // Force the CJS build of mmg-wasm: the ESM one locates its wasm through
  // import.meta.url, which an esbuild CJS bundle rewrites to undefined.
  alias: {
    "@loumalouomega/mmg-wasm": path.join(
      __dirname,
      "node_modules",
      "@loumalouomega",
      "mmg-wasm",
      "dist",
      "mmg.cjs"
    ),
  },
  plugins: [copyWasmPlugin, copyPyodidePlugin, copyFlowgraphPlugin, copyMeshioPlugin],
};

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: ["webview/main.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2021",
  outfile: "media/webview.js",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
  // vtk.js expects a browser global and a NODE_ENV; esbuild's browser platform
  // does not provide these by default.
  define: {
    global: "globalThis",
    "process.env.NODE_ENV": production ? '"production"' : '"development"',
  },
  plugins: [copyStylePlugin],
};

async function main() {
  const contexts = await Promise.all([
    esbuild.context(extensionConfig),
    esbuild.context(webviewConfig),
  ]);

  if (watch) {
    await Promise.all(contexts.map((c) => c.watch()));
    console.log("[esbuild] watching...");
  } else {
    await Promise.all(contexts.map((c) => c.rebuild()));
    await Promise.all(contexts.map((c) => c.dispose()));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
