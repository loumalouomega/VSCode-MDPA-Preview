#!/usr/bin/env node
// Tier 0 VTK-wasm spike static server. Zero dependencies (not express — the
// point of this server is to be auditably header-minimal, unlike
// src/flowgraphServer.ts, which legitimately needs express/ejs).
//
// file:// cannot serve this spike: @kitware/vtk-wasm's loader does a real
// fetch() of the glue .mjs/.wasm, and Chromium blocks fetch() of file:// URLs
// regardless of CSP. A dynamic import() of a file:// module from a file://
// page is likewise blocked as a cross-origin (opaque-origin) module fetch.
// So an http origin is required even to test the CSP question honestly.
//
// Mounts:
//   /              -> out/spike/            (spike pages + bundled JS)
//   /media/        -> media/                (the real webview.js/style.css)
//   /vtk-wasm/<v>/ -> out/vtk-wasm/<v>/      (fetched binaries, v = wasm32|wasm64)
//
// Deliberately sends NO Content-Security-Policy header and NO
// Cross-Origin-Opener/Embedder-Policy headers by default: the CSP under test
// lives in each page's own <meta> tag (mirroring src/webviewChrome.ts's
// buildPreviewHtml, which also uses a meta tag, never a header), and no COOP
// /COEP is what makes crossOriginIsolated === false — matching a real VS
// Code webview and turning "the binary needs no SharedArrayBuffer" from a
// grep into a runtime fact. Set SPIKE_COI=1 to add COOP/COEP for contrast.
//
// Usage: node scripts/spike/serve-spike.mjs [--port 7317]

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize, sep } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

const MOUNTS = [
  { prefix: "/vtk-wasm/", dir: join(ROOT, "out", "vtk-wasm") },
  { prefix: "/media/", dir: join(ROOT, "media") },
  { prefix: "/", dir: join(ROOT, "out", "spike") },
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  // .tar.gz served WITHOUT Content-Encoding: gzip — with it, the browser
  // would transparently decompress the response body, and @kitware/vtk-wasm
  // (via js-untar) expects to receive and gunzip the raw gzip bytes itself.
  ".gz": "application/gzip",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function resolveMount(urlPath) {
  for (const { prefix, dir } of MOUNTS) {
    if (urlPath.startsWith(prefix)) {
      const rel = urlPath.slice(prefix.length) || "index.html";
      const resolved = normalize(join(dir, rel));
      // Path-traversal guard, same policy family as isSafeEntryName in
      // src/parser/problemZip.ts / src/parser/zip.ts.
      if (!resolved.startsWith(dir + sep) && resolved !== dir) return null;
      return resolved;
    }
  }
  return null;
}

function parsePort(argv) {
  const i = argv.indexOf("--port");
  if (i >= 0 && argv[i + 1]) return Number(argv[i + 1]);
  return Number(process.env.SPIKE_PORT) || 7317;
}

const port = parsePort(process.argv.slice(2));
const withCoi = process.env.SPIKE_COI === "1";

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith("/")) path += "index.html";
    const filePath = resolveMount(path);
    if (!filePath) {
      res.writeHead(404).end("not found (no mount)");
      return;
    }
    const st = await stat(filePath).catch(() => null);
    if (!st || !st.isFile()) {
      res.writeHead(404).end(`not found: ${path}`);
      return;
    }
    const ext = extname(filePath);
    const contentType = MIME[ext] || "application/octet-stream";
    const headers = {
      "Content-Type": contentType,
      "Content-Length": st.size,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    };
    if (withCoi) {
      headers["Cross-Origin-Opener-Policy"] = "same-origin";
      headers["Cross-Origin-Embedder-Policy"] = "require-corp";
    }
    // Deliberately no Content-Security-Policy header — see module doc.
    res.writeHead(200, headers);
    res.end(await readFile(filePath));
  } catch (err) {
    res.writeHead(500).end(String(err && err.message ? err.message : err));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`spike server: http://127.0.0.1:${port}/`);
  console.log(`  control: http://127.0.0.1:${port}/control.html`);
  console.log(`  boot:    http://127.0.0.1:${port}/boot.html?csp=shipped`);
  console.log(`  boot:    http://127.0.0.1:${port}/boot.html?csp=augmented`);
  console.log(`  spike:   http://127.0.0.1:${port}/spike.html`);
  console.log(`  crossOriginIsolated headers: ${withCoi ? "ON (SPIKE_COI=1)" : "off (matches a real VS Code webview)"}`);
});
