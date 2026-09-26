#!/usr/bin/env node
// Dependency-free static server for the VTK-wasm evaluation and parity pages
// (roadmap item 18). Promoted from scripts/spike/serve-spike.mjs.
//
// Why a server at all: file:// cannot fetch() a .wasm or import() a module,
// so the existing file:// screenshot harness cannot host VTK-wasm. Serving
// the repo over http also gives `.wasm` the application/wasm MIME type that
// WebAssembly.instantiateStreaming requires (a wrong type silently falls back
// to the slower ArrayBuffer path — which the evaluation measures).
//
// Only three trees are exposed: out/, media/ and scripts/vtk-wasm/eval/ —
// nothing else in the repo is reachable. No CSP header is sent: every page
// declares its own policy in a <meta> tag, exactly as the webview does, so
// the policy under test is the page's, never the server's.
//
//   node scripts/vtk-wasm/serve.mjs [port]            # standalone, default 7318
//   import { startServer } from "./serve.mjs"         # in-process (run.mjs)

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

const ROOTS = {
  "/out/": join(ROOT, "out"),
  "/media/": join(ROOT, "media"),
  "/eval/": join(HERE, "eval"),
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".gz": "application/gzip",
};

function resolve(urlPath) {
  const clean = decodeURIComponent(urlPath.split("?")[0]);
  for (const [prefix, dir] of Object.entries(ROOTS)) {
    if (!clean.startsWith(prefix)) continue;
    const file = normalize(join(dir, clean.slice(prefix.length)));
    // Path traversal guard: the resolved file must stay inside its root.
    if (file !== dir && !file.startsWith(dir + sep)) return undefined;
    return file;
  }
  return undefined;
}

export function startServer(port = 7318, { log = false, headers = {} } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    const file = resolve(req.url ?? "/");
    requests.push(req.url);
    if (!file || !existsSync(file) || !statSync(file).isFile()) {
      if (log) console.log(`404 ${req.url}`);
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "content-length": statSync(file).size,
      "cache-control": "no-store",
      ...headers,
    });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolveP) => {
    server.listen(port, "127.0.0.1", () => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      resolveP({ origin, requests, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.argv[2] ?? 7318);
  startServer(port, { log: true }).then(({ origin }) => console.log(`serving out/, media/, eval/ at ${origin}`));
}
