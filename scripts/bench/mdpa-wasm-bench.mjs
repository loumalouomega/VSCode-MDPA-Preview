#!/usr/bin/env node
/**
 * Benchmark for roadmap item 87 (Rust/WASM mdpa-core probe).
 *
 * Generates a realistic 1,000,000-element tetrahedral .mdpa file (with nodes,
 * elements, boundary conditions, Properties, NodalData, and SubModelParts),
 * runs TS vs Rust/WASM inside dedicated worker threads (matching
 * meshioReadWorker / analysisWorker isolation), and compares wall time,
 * peak memory, and byte-identical output.
 *
 * Usage:
 *   npm run build:tests && node scripts/bench/mdpa-wasm-bench.mjs
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");

function generateLargeMdpa(filePath, targetElements = 1_000_000) {
  // Structured 3D grid split into 5 tets per hex cell.
  // 59 * 59 * 58 = 201,898 hexes * 5 = 1,009,490 tets (> 1M elements), 212,400 nodes.
  const nx = 60;
  const ny = 60;
  const nz = 59;
  const nodeId = (i, j, k) => 1 + i + nx * (j + ny * k);

  const fd = fs.openSync(filePath, "w");
  const writeChunk = (s) => fs.writeSync(fd, s);

  writeChunk("Begin ModelPartData\nEnd ModelPartData\n\n");
  writeChunk("Begin Properties 1\n  DENSITY 1000\n  VISCOSITY 0.001\nEnd Properties\n\n");

  // Nodes
  writeChunk("Begin Nodes\n");
  let buf = [];
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const id = nodeId(i, j, k);
        buf.push(`  ${id} ${(i * 0.1).toFixed(4)} ${(j * 0.1).toFixed(4)} ${(k * 0.1).toFixed(4)}\n`);
        if (buf.length >= 16384) {
          writeChunk(buf.join(""));
          buf = [];
        }
      }
    }
  }
  if (buf.length) {
    writeChunk(buf.join(""));
    buf = [];
  }
  writeChunk("End Nodes\n\n");

  // Elements (Element3D4N)
  writeChunk("Begin Elements Element3D4N\n");
  let eid = 0;
  outer: for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const n000 = nodeId(i, j, k);
        const n100 = nodeId(i + 1, j, k);
        const n110 = nodeId(i + 1, j + 1, k);
        const n010 = nodeId(i, j + 1, k);
        const n001 = nodeId(i, j, k + 1);
        const n101 = nodeId(i + 1, j, k + 1);
        const n111 = nodeId(i + 1, j + 1, k + 1);
        const n011 = nodeId(i, j + 1, k + 1);
        const tets = [
          [n000, n100, n110, n101],
          [n000, n110, n010, n011],
          [n000, n001, n101, n011],
          [n111, n101, n110, n011],
          [n000, n101, n110, n011],
        ];
        for (const [a, b, c, d] of tets) {
          eid++;
          buf.push(`  ${eid} 1 ${a} ${b} ${c} ${d}\n`);
          if (eid >= targetElements) break outer;
        }
        if (buf.length >= 16384) {
          writeChunk(buf.join(""));
          buf = [];
        }
      }
    }
  }
  if (buf.length) {
    writeChunk(buf.join(""));
    buf = [];
  }
  writeChunk("End Elements\n\n");

  // Boundary conditions (bottom & top faces -> ~14,000 triangles)
  writeChunk("Begin Conditions SurfaceCondition3D3N\n");
  let cid = 0;
  for (const k of [0, nz - 1]) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = nodeId(i, j, k);
        const b = nodeId(i + 1, j, k);
        const c = nodeId(i + 1, j + 1, k);
        const d = nodeId(i, j + 1, k);
        cid++;
        buf.push(`  ${cid} 1 ${a} ${b} ${c}\n`);
        cid++;
        buf.push(`  ${cid} 1 ${a} ${c} ${d}\n`);
      }
    }
  }
  writeChunk(buf.join(""));
  buf = [];
  writeChunk("End Conditions\n\n");

  // NodalData PRESSURE on first 50,000 nodes
  writeChunk("Begin NodalData PRESSURE\n");
  for (let id = 1; id <= 50_000; id++) {
    buf.push(`  ${id} 0 ${(101325.0 + id * 0.01).toFixed(3)}\n`);
    if (buf.length >= 16384) {
      writeChunk(buf.join(""));
      buf = [];
    }
  }
  if (buf.length) {
    writeChunk(buf.join(""));
    buf = [];
  }
  writeChunk("End NodalData\n\n");

  // SubModelPart
  writeChunk("Begin SubModelPart Inlet\n  Begin SubModelPartNodes\n");
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      buf.push(`    ${nodeId(i, j, 0)}\n`);
    }
  }
  writeChunk(buf.join(""));
  buf = [];
  writeChunk("  End SubModelPartNodes\nEnd SubModelPart\n");

  fs.closeSync(fd);
  const stat = fs.statSync(filePath);
  return {
    bytes: stat.size,
    nodes: nx * ny * nz,
    elements: eid,
    conditions: cid,
  };
}

if (!isMainThread) {
  // Worker execution
  const { mode, filePath } = workerData;
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const mdpaParser = require(path.join(REPO_ROOT, "out/parser/mdpaParser.js"));
  const mdpaWriter = require(path.join(REPO_ROOT, "out/parser/writers/mdpaWriter.js"));
  const mdpaWasm = require(path.join(REPO_ROOT, "out/parser/mdpaWasm.js"));

  const memBefore = process.memoryUsage();
  let peakRss = memBefore.rss;
  const sampleMem = () => {
    const r = process.memoryUsage().rss;
    if (r > peakRss) peakRss = r;
  };
  const timer = setInterval(sampleMem, 10);

  const t0 = performance.now();
  let summary = {};

  if (mode === "ts-parse-file") {
    const m = await mdpaParser.parseMdpaFileTs(filePath);
    sampleMem();
    summary = { nodeCount: m.nodeCount, elemCount: m.blocks[0].count, bounds: m.bounds };
  } else if (mode === "wasm-parse-file") {
    const m = await mdpaWasm.parseMdpaFileWasm(filePath);
    sampleMem();
    summary = { nodeCount: m.nodeCount, elemCount: m.blocks[0].count, bounds: m.bounds };
  } else if (mode === "ts-parse-mem") {
    const text = fs.readFileSync(filePath, "utf8");
    const tParse = performance.now();
    const m = mdpaParser.parseMdpaTs(text);
    const parseMs = performance.now() - tParse;
    sampleMem();
    summary = { nodeCount: m.nodeCount, elemCount: m.blocks[0].count, parseOnlyMs: parseMs };
  } else if (mode === "wasm-parse-mem") {
    const buf = fs.readFileSync(filePath);
    const tParse = performance.now();
    const m = mdpaWasm.parseMdpaBytesWasm(buf);
    const parseMs = performance.now() - tParse;
    sampleMem();
    summary = { nodeCount: m.nodeCount, elemCount: m.blocks[0].count, parseOnlyMs: parseMs };
  } else if (mode === "ts-write") {
    const m = await mdpaWasm.parseMdpaFileWasm(filePath);
    const tWrite = performance.now();
    const out = mdpaWriter.writeMdpaTs(m);
    const writeMs = performance.now() - tWrite;
    sampleMem();
    const sha = crypto.createHash("sha256").update(out).digest("hex").slice(0, 16);
    summary = { bytes: Buffer.byteLength(out), sha, writeOnlyMs: writeMs };
  } else if (mode === "wasm-write") {
    const m = await mdpaWasm.parseMdpaFileWasm(filePath);
    const tWrite = performance.now();
    const out = mdpaWasm.writeMdpaBytesWasm(m);
    const writeMs = performance.now() - tWrite;
    sampleMem();
    const sha = crypto.createHash("sha256").update(out).digest("hex").slice(0, 16);
    summary = { bytes: out.byteLength, sha, writeOnlyMs: writeMs };
  } else if (mode === "ts-scan") {
    const text = fs.readFileSync(filePath, "utf8");
    const tScan = performance.now();
    const scanner = new mdpaParser.MdpaSummaryScanner();
    for (const line of text.split(/\r?\n/)) scanner.feedLine(line);
    const res = scanner.finish();
    const scanMs = performance.now() - tScan;
    sampleMem();
    summary = { nodeCount: res.nodeCount, elemCount: res.blocks[0].count, scanOnlyMs: scanMs };
  } else if (mode === "wasm-scan") {
    const buf = fs.readFileSync(filePath);
    const tScan = performance.now();
    const res = mdpaWasm.scanMdpaBytesWasm(buf);
    const scanMs = performance.now() - tScan;
    sampleMem();
    summary = { nodeCount: res.nodeCount, elemCount: res.blocks[0].count, scanOnlyMs: scanMs };
  }

  clearInterval(timer);
  const elapsedMs = performance.now() - t0;
  const memAfter = process.memoryUsage();
  parentPort.postMessage({
    mode,
    elapsedMs,
    peakRssMb: Math.max(peakRss, memAfter.rss) / (1024 * 1024),
    heapUsedMb: memAfter.heapUsed / (1024 * 1024),
    summary,
  });
} else {
  const tmpFile = path.join(os.tmpdir(), "mdpa-bench-1m.mdpa");
  console.log("Generating 1,000,000-element .mdpa benchmark file...");
  const tGen = performance.now();
  const info = generateLargeMdpa(tmpFile, 1_000_000);
  console.log(
    `Generated ${(info.bytes / (1024 * 1024)).toFixed(1)} MB ` +
      `(${info.nodes.toLocaleString()} nodes, ${info.elements.toLocaleString()} elements, ` +
      `${info.conditions.toLocaleString()} conditions) in ${(performance.now() - tGen).toFixed(0)} ms\n`
  );

  const runWorker = (mode) =>
    new Promise((resolve, reject) => {
      const w = new Worker(__filename, { workerData: { mode, filePath: tmpFile } });
      w.on("message", resolve);
      w.on("error", reject);
      w.on("exit", (code) => {
        if (code !== 0) reject(new Error(`worker ${mode} exited with ${code}`));
      });
    });

  const pairs = [
    ["parseMdpaFile (stream)", "ts-parse-file", "wasm-parse-file", "elapsedMs"],
    ["parseMdpa (in-memory)", "ts-parse-mem", "wasm-parse-mem", "parseOnlyMs"],
    ["writeMdpa (1M elems)", "ts-write", "wasm-write", "writeOnlyMs"],
    ["MdpaSummaryScanner", "ts-scan", "wasm-scan", "scanOnlyMs"],
  ];

  for (const [label, tsMode, wasmMode, metricKey] of pairs) {
    const ts = await runWorker(tsMode);
    const wasm = await runWorker(wasmMode);
    const tsMs = metricKey === "elapsedMs" ? ts.elapsedMs : ts.summary[metricKey];
    const wasmMs = metricKey === "elapsedMs" ? wasm.elapsedMs : wasm.summary[metricKey];
    const speedup = tsMs / wasmMs;
    console.log(`=== ${label} ===`);
    console.log(
      `  TS:   ${tsMs.toFixed(1)} ms  (peak RSS ${ts.peakRssMb.toFixed(0)} MB, heap ${ts.heapUsedMb.toFixed(0)} MB)`
    );
    console.log(
      `  WASM: ${wasmMs.toFixed(1)} ms  (peak RSS ${wasm.peakRssMb.toFixed(0)} MB, heap ${wasm.heapUsedMb.toFixed(0)} MB)`
    );
    console.log(`  Speedup: ${speedup.toFixed(2)}x`);
    if (ts.summary.sha && wasm.summary.sha) {
      console.log(
        `  Write parity: ${ts.summary.sha === wasm.summary.sha ? "IDENTICAL" : "MISMATCH"} ` +
          `(TS=${ts.summary.sha}, WASM=${wasm.summary.sha}, ${wasm.summary.bytes} bytes)`
      );
    }
    console.log();
  }

  fs.unlinkSync(tmpFile);
}
