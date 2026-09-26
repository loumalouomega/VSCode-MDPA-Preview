#!/usr/bin/env node
// Fetch, verify and unpack the pinned VTK-wasm candidates (roadmap item 18).
//
// Promoted from scripts/spike/fetch-vtk-wasm.mjs (which stays as the
// 2026-09-18 spike's historical tool). Differences: tarballs are fetched by
// COMMIT from scripts/vtk-wasm/manifest.json (mirrors first), every unpacked
// file is hash-gated individually, and the result of the G0.1 checks
// (single-threadedness, compile time) is written as JSON evidence.
//
// Usage:
//   node scripts/vtk-wasm/fetch.mjs                      # every candidate
//   node scripts/vtk-wasm/fetch.mjs --candidate rel-9.7.0
//   node scripts/vtk-wasm/fetch.mjs --loader             # + the npm loader
//   node scripts/vtk-wasm/fetch.mjs --record             # pin per-file hashes (first time only)
//   node scripts/vtk-wasm/fetch.mjs --verify-only        # no network; cache + unpacked tree
//   node scripts/vtk-wasm/fetch.mjs --no-cache           # force a fresh download (G0.1 repeatability)
//
// Output: out/vtk-wasm/<candidate>/, cache in out/vtk-wasm/cache/, evidence
// in out/vtk-wasm-eval/results/g0-1-pin.json. out/ is gitignored and not
// packaged; nothing here writes into media/ (that is prepare-assets.mjs's job).
//
// No `tar` shell-out and no npm dependency: the ustar reader is the spike's.

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT_DIR = join(ROOT, "out", "vtk-wasm");
const CACHE_DIR = join(OUT_DIR, "cache");
const RESULTS_DIR = join(ROOT, "out", "vtk-wasm-eval", "results");
export const MANIFEST_PATH = join(HERE, "manifest.json");

export function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export function readManifest() {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
}

function writeManifest(m) {
  writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2) + "\n");
}

// --- minimal ustar reader (POSIX tar, 512-byte header blocks) ---------------
function readOctal(buf, start, len) {
  const s = buf.toString("latin1", start, start + len).replace(/\0.*$/, "").trim();
  return s.length ? parseInt(s, 8) : 0;
}

export function* iterateTarEntries(buf) {
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
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
    if (typeFlag === "0" || typeFlag === "") {
      yield { name: name.replace(/^\.\//, ""), data: buf.subarray(dataStart, dataStart + size) };
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
}

/** Digest over types/*.json: sha256 of sorted "name:sha256" lines. */
function typesDigest(entries) {
  const lines = entries.map((e) => `${e.name}:${sha256(e.data)}`).sort();
  return sha256(Buffer.from(lines.join("\n")));
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function sourcesFor(m, spec) {
  const urls = (m.mirrors ?? []).map((base) => `${base.replace(/\/+$/, "")}/${spec.path.split("/").pop()}`);
  urls.push(`https://raw.githubusercontent.com/${m.repo}/${m.commit}/${spec.path}`);
  return urls;
}

async function obtainTarball(m, name, spec, { noCache, verifyOnly }) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = join(CACHE_DIR, `${name}.tar.gz`);
  if (!noCache && existsSync(cachePath) && statSync(cachePath).size === spec.bytes) {
    const buf = readFileSync(cachePath);
    if (sha256(buf) === spec.sha256) return { buf, from: "cache" };
  }
  if (verifyOnly) throw new Error(`[${name}] --verify-only: no verified cache at ${cachePath}`);
  let lastErr;
  for (const url of sourcesFor(m, spec)) {
    try {
      const buf = await download(url);
      if (buf.length !== spec.bytes || sha256(buf) !== spec.sha256) {
        lastErr = new Error(
          `[${name}] REFUSING ${url}: expected ${spec.bytes} bytes sha256 ${spec.sha256}, ` +
            `got ${buf.length} bytes sha256 ${sha256(buf)}`
        );
        continue;
      }
      writeFileSync(cachePath, buf);
      return { buf, from: url };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error(`[${name}] no source`);
}

// Real threading symbols only: a naive /pthread/i matches WebGPU glue
// ("depthReadOnly"), a false positive the spike already hit once.
const THREAD_SYMBOLS = [
  /pthread_create/i,
  /ENVIRONMENT_IS_PTHREAD/i,
  /SharedArrayBuffer/,
  /_emscripten_futex/i,
  /new WebAssembly\.Memory\(\s*\{[^}]{0,200}shared\s*:\s*true/i,
];

async function processCandidate(m, name, opts) {
  const spec = m.candidates[name];
  if (!spec) throw new Error(`unknown candidate "${name}" — expected one of ${Object.keys(m.candidates).join(", ")}`);
  const { buf, from } = await obtainTarball(m, name, spec, opts);
  const entries = [...iterateTarEntries(gunzipSync(buf))].filter((e) => e.name && !e.name.endsWith("/"));
  const types = entries.filter((e) => e.name.startsWith("types/"));
  const plain = entries.filter((e) => !e.name.startsWith("types/"));

  const got = {};
  for (const e of plain) got[e.name] = { bytes: e.data.length, sha256: sha256(e.data) };
  const gotTypesDigest = types.length ? typesDigest(types) : null;

  const recorded = Object.keys(spec.files ?? {}).length > 0;
  if (!recorded) {
    if (!opts.record) {
      throw new Error(`[${name}] per-file hashes are not pinned yet — run once with --record`);
    }
    spec.files = got;
    spec.typesCount = types.length;
    spec.typesDigest = gotTypesDigest;
    writeManifest(m);
    console.log(`[${name}] recorded ${plain.length} file hashes + ${types.length} types (digest ${gotTypesDigest})`);
  } else {
    const problems = [];
    for (const [f, want] of Object.entries(spec.files)) {
      const g = got[f];
      if (!g) problems.push(`missing ${f}`);
      else if (g.bytes !== want.bytes || g.sha256 !== want.sha256) problems.push(`${f}: ${g.bytes}/${g.sha256}`);
    }
    for (const f of Object.keys(got)) if (!spec.files[f]) problems.push(`unexpected ${f}`);
    if (types.length !== spec.typesCount || gotTypesDigest !== spec.typesDigest) {
      problems.push(`types: ${types.length} files, digest ${gotTypesDigest}`);
    }
    if (problems.length) throw new Error(`[${name}] REFUSING unpacked tree:\n  ${problems.join("\n  ")}`);
  }

  const destDir = join(OUT_DIR, name);
  rmSync(destDir, { recursive: true, force: true });
  for (const e of entries) {
    const dest = join(destDir, e.name);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, e.data);
  }

  const builds = plain.filter((e) => e.name.endsWith(".mjs")).map((e) => e.name.replace(/\.mjs$/, ""));
  const perBuild = {};
  for (const b of builds) {
    const mjs = readFileSync(join(destDir, `${b}.mjs`), "latin1");
    const wasm = readFileSync(join(destDir, `${b}.wasm`));
    const t0 = performance.now();
    const mod = await WebAssembly.compile(wasm);
    const compileMs = performance.now() - t0;
    const imports = WebAssembly.Module.imports(mod);
    perBuild[b] = {
      mjsBytes: Buffer.byteLength(mjs, "latin1"),
      wasmBytes: wasm.length,
      compileMs: Math.round(compileMs),
      imports: imports.length,
      importedMemory: imports.some((i) => i.kind === "memory"),
      threadSymbolHits: THREAD_SYMBOLS.filter((re) => re.test(mjs)).length,
      jspiSuspending: (mjs.match(/new WebAssembly\.Suspending/g) ?? []).length,
      dynamicCodeSites: (mjs.match(/new Function\(/g) ?? []).length,
    };
  }
  console.log(`[${name}] ${from === "cache" ? "cache hit" : `downloaded ${from}`} -> ${destDir}`);
  for (const [b, r] of Object.entries(perBuild)) console.log(`  ${b}: ${JSON.stringify(r)}`);
  return { name, vtkVersion: spec.vtkVersion, source: from, tarballBytes: buf.length, files: plain.length, types: types.length, builds: perBuild };
}

async function processLoader(m, opts) {
  const spec = m.loader;
  mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = join(CACHE_DIR, "kitware-vtk-wasm-loader.tgz");
  let buf = existsSync(cachePath) ? readFileSync(cachePath) : null;
  if (!buf || buf.length !== spec.bytes || sha256(buf) !== spec.sha256) {
    if (opts.verifyOnly) throw new Error(`[loader] --verify-only: no verified cache`);
    buf = await download(spec.url);
  }
  if (buf.length !== spec.bytes || sha256(buf) !== spec.sha256) {
    throw new Error(`[loader] REFUSING: got ${buf.length} bytes sha256 ${sha256(buf)}`);
  }
  writeFileSync(cachePath, buf);
  const destDir = join(OUT_DIR, "loader");
  rmSync(destDir, { recursive: true, force: true });
  for (const e of iterateTarEntries(gunzipSync(buf))) {
    if (!e.name || e.name.endsWith("/")) continue;
    const dest = join(destDir, e.name);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, e.data);
  }
  console.log(`[loader] ${spec.npm}@${spec.version} -> ${destDir}`);
  return { name: "loader", version: spec.version };
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = {
    record: argv.includes("--record"),
    verifyOnly: argv.includes("--verify-only"),
    noCache: argv.includes("--no-cache"),
  };
  const m = readManifest();
  const picked = [];
  argv.forEach((a, i) => a === "--candidate" && argv[i + 1] && picked.push(argv[i + 1]));
  const names = picked.length ? picked : Object.keys(m.candidates);
  console.log(`pin: ${m.repo}@${m.commit} (branch ${m.branch}, resolved ${m.resolvedOn})`);
  const results = [];
  for (const n of names) results.push(await processCandidate(m, n, opts));
  if (argv.includes("--loader")) results.push(await processLoader(m, opts));
  mkdirSync(RESULTS_DIR, { recursive: true });
  const out = join(RESULTS_DIR, "g0-1-pin.json");
  writeFileSync(out, JSON.stringify({ date: new Date().toISOString(), commit: m.commit, node: process.version, results }, null, 2));
  console.log(`evidence -> ${out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
