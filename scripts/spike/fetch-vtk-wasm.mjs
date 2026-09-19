#!/usr/bin/env node
// Tier 0 VTK-wasm spike (doc/roadmap.md Tier 0) — fetches and unpacks the
// vtk-wasm{32,64} binaries into out/vtk-wasm/, never into media/ or the repo.
//
// out/ is excluded from git (.gitignore:10) AND from the .vsix
// (.vscodeignore:13), so nothing here reaches a commit or a package. That is
// the whole point: this is measurement scaffolding for a keep-or-drop
// decision, not a vendoring step for a shipped feature.
//
// Usage:
//   node scripts/spike/fetch-vtk-wasm.mjs              # wasm32 (default)
//   node scripts/spike/fetch-vtk-wasm.mjs --variant wasm64
//   node scripts/spike/fetch-vtk-wasm.mjs --both        # both wasm binaries
//   node scripts/spike/fetch-vtk-wasm.mjs --loader      # + the npm loader
//   node scripts/spike/fetch-vtk-wasm.mjs --all         # everything
//
// The npm loader package (@kitware/vtk-wasm — loadAsync()/StandaloneSession,
// no wasm binary, 412 KB) is vendored the same way, into out/vtk-wasm/loader/,
// rather than added to package.json/package-lock.json: this is throwaway
// spike scaffolding, not a shipped dependency, and it may be dropped.
//
// Pin: scripts/spike/vtk-wasm-manifest.json. The download is size- and
// sha256-gated against that file and REFUSED on mismatch — mirroring
// scripts/screenshots/capture-split-fields.mjs's "fail rather than write a
// misleading artifact" precedent. A later push to Kitware/vtk-wasm's `dist`
// branch must not silently invalidate a measurement already written into
// doc/vtk-wasm-spike.md.
//
// No `tar` shell-out and no new npm dependency: unpacking is a ~90-line
// ustar reader below, so this runs on a bare checkout with only Node.

import { createHash } from "node:crypto";
import { gunzipSync, deflateRawSync } from "node:zlib";
import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT_DIR = join(ROOT, "out", "vtk-wasm");
const CACHE_DIR = join(OUT_DIR, "cache");
const MANIFEST_PATH = join(HERE, "vtk-wasm-manifest.json");

function parseArgs(argv) {
  const variantIdx = argv.indexOf("--variant");
  const wantLoader = argv.includes("--loader") || argv.includes("--all");
  let variants;
  if (argv.includes("--both") || argv.includes("--all")) variants = ["wasm32", "wasm64"];
  else if (variantIdx >= 0 && argv[variantIdx + 1]) variants = [argv[variantIdx + 1]];
  else if (argv.includes("--loader") && variantIdx < 0 && !argv.includes("--both")) variants = [];
  else variants = ["wasm32"];
  return { variants, wantLoader };
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// --- minimal ustar reader (POSIX tar, 512-byte header blocks) ---------------
function readOctal(buf, start, len) {
  const s = buf.toString("latin1", start, start + len).replace(/\0.*$/, "").trim();
  return s.length ? parseInt(s, 8) : 0;
}

function* iterateTarEntries(buf) {
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    // A zero-filled block marks end-of-archive (there are usually two).
    if (header.every((b) => b === 0)) {
      offset += 512;
      continue;
    }
    let name = header.toString("latin1", 0, 100).replace(/\0.*$/, "");
    const prefix = header.toString("latin1", 345, 500).replace(/\0.*$/, "");
    if (prefix) name = `${prefix}/${name}`;
    const size = readOctal(header, 124, 12);
    const typeFlag = header.toString("latin1", 156, 157);
    const dataStart = offset + 512;
    const paddedSize = Math.ceil(size / 512) * 512;
    if (typeFlag === "0" || typeFlag === "") {
      // Regular file.
      yield { name, data: buf.subarray(dataStart, dataStart + size) };
    }
    // typeFlag "5" = directory, "g"/"x" = pax headers — skipped; this bundle
    // (measured) carries only regular files and directories.
    offset = dataStart + paddedSize;
  }
}

function unpackTarGz(gzBuf, destDir) {
  // Synchronous gunzip via zlib's sync API keeps this a plain top-to-bottom
  // script; the bundle is tens of MB, well inside a single-buffer decompress.
  const tarBuf = gunzipSync(gzBuf);
  let files = 0;
  for (const entry of iterateTarEntries(tarBuf)) {
    if (!entry.name || entry.name.endsWith("/")) continue;
    const dest = join(destDir, entry.name.replace(/^\.\//, ""));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, entry.data);
    files++;
  }
  return files;
}

function deflateSize(buf) {
  return deflateRawSync(buf, { level: 9 }).length;
}

async function fetchVariant(variant, manifest) {
  const spec = manifest.variants[variant];
  if (!spec) throw new Error(`unknown variant "${variant}" — expected one of ${Object.keys(manifest.variants).join(", ")}`);

  mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = join(CACHE_DIR, `vtk-${variant}-emscripten.tar.gz`);
  const destDir = join(OUT_DIR, variant);

  let buf;
  if (existsSync(cachePath) && statSync(cachePath).size === spec.bytes) {
    buf = readFileSync(cachePath);
    if (sha256(buf) === spec.sha256) {
      console.log(`[${variant}] cache hit, sha256 verified: ${cachePath}`);
    } else {
      console.log(`[${variant}] cache present but sha256 mismatch, re-downloading`);
      buf = await download(spec.url);
    }
  } else {
    console.log(`[${variant}] downloading ${spec.url}`);
    buf = await download(spec.url);
  }

  const gotSha = sha256(buf);
  const gotBytes = buf.length;
  if (gotBytes !== spec.bytes || gotSha !== spec.sha256) {
    throw new Error(
      `[${variant}] REFUSING to unpack — checksum/size mismatch against ` +
      `${MANIFEST_PATH}.\n` +
      `  expected: ${spec.bytes} bytes, sha256 ${spec.sha256}\n` +
      `  got:      ${gotBytes} bytes, sha256 ${gotSha}\n` +
      `The vtk-wasm 'dist' branch has moved past the pinned commit ` +
      `${manifest.ref}. Re-verify before updating the pin — every number in ` +
      `doc/vtk-wasm-spike.md is measured against the pinned binary.`
    );
  }
  writeFileSync(cachePath, buf);

  const fileCount = unpackTarGz(buf, destDir);

  const wasmPath = join(destDir, "vtkWebAssembly.wasm");
  const mjsPath = join(destDir, "vtkWebAssembly.mjs");
  const wasmBytes = existsSync(wasmPath) ? statSync(wasmPath).size : 0;
  const mjsBytes = existsSync(mjsPath) ? statSync(mjsPath).size : 0;
  const mjsText = existsSync(mjsPath) ? readFileSync(mjsPath, "latin1") : "";
  // NOTE: a naive /pthread/i substring test false-positives on WebGPU glue
  // code — "depthReadOnly"/"depthStoreOp" both contain "pthRead"/"pthStor"
  // as a case-insensitive substring. Match real threading symbols instead.
  const THREAD_SYMBOLS = [
    /pthread_create/i,
    /ENVIRONMENT_IS_PTHREAD/i,
    /SharedArrayBuffer/,
    /_emscripten_futex/i,
    /new WebAssembly\.Memory\(\s*\{[^}]{0,200}shared\s*:\s*true/i,
  ];
  const pthreadHits = THREAD_SYMBOLS.filter((re) => re.test(mjsText)).length;

  console.log(`[${variant}] unpacked ${fileCount} files -> ${destDir}`);
  console.log(`[${variant}] vtkWebAssembly.wasm: ${(wasmBytes / 1048576).toFixed(1)} MB unpacked`);
  console.log(`[${variant}] vtkWebAssembly.mjs:  ${(mjsBytes / 1024).toFixed(1)} KB`);
  if (wasmBytes > 0) {
    const deflated = deflateSize(readFileSync(wasmPath));
    console.log(`[${variant}] deflate-9 of .wasm:  ${(deflated / 1048576).toFixed(1)} MB  <- approx .vsix cost if ever shipped`);
  }
  console.log(`[${variant}] pthread/SharedArrayBuffer/futex references in glue: ${pthreadHits}  (0 = single-threaded, no crossOriginIsolated needed)`);

  return { variant, destDir, wasmBytes, mjsBytes, pthreadHits };
}

async function fetchLoader(manifest) {
  const spec = manifest.loader;
  mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = join(CACHE_DIR, "kitware-vtk-wasm-loader.tgz");
  const destDir = join(OUT_DIR, "loader");

  let buf;
  if (existsSync(cachePath) && statSync(cachePath).size === spec.bytes) {
    buf = readFileSync(cachePath);
  } else {
    console.log(`[loader] downloading ${spec.url}`);
    buf = await download(spec.url);
  }
  const gotSha = sha256(buf);
  if (buf.length !== spec.bytes || gotSha !== spec.sha256) {
    throw new Error(
      `[loader] REFUSING to unpack — checksum/size mismatch against ${MANIFEST_PATH}.\n` +
      `  expected: ${spec.bytes} bytes, sha256 ${spec.sha256}\n` +
      `  got:      ${buf.length} bytes, sha256 ${gotSha}`
    );
  }
  writeFileSync(cachePath, buf);
  const fileCount = unpackTarGz(buf, destDir);
  console.log(`[loader] unpacked ${fileCount} files -> ${destDir} (npm package: ${manifest.npmLoader})`);
  return { destDir };
}

async function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const { variants, wantLoader } = parseArgs(process.argv.slice(2));
  console.log(`pinned ref: ${manifest.ref} (Kitware/vtk-wasm, branch "dist", commit HEAD at fetch time)`);
  const results = [];
  for (const v of variants) {
    results.push(await fetchVariant(v, manifest));
  }
  if (wantLoader || variants.length === 0) {
    results.push(await fetchLoader(manifest));
  }
  console.log("\ndone:", results.map((r) => r.variant || "loader").join(", "));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
