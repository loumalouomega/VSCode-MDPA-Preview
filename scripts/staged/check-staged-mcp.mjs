// Roadmap item 7 (KKSS "embedded artifact matrix" increment): run the SHIPPED
// MCP server from a staged distribution that has no access to the checkout's
// node_modules, drive it over stdio, and check it against the in-process core.
//
//   npm run compile && npm run build:tests && npm run check:staged
//   STAGED_WITHOUT=meshio npm run check:staged     # expect FAIL: proves the checks can fail
//
// Needs Node only (no VS Code, no browser). Prints PASS / FAIL / UNVERIFIED per
// step and writes out/staged/staged.json; exits non-zero on any FAIL or when
// nothing could be verified. Not part of `npm test` (it spawns processes, loads
// the wasm several times and takes a minute).
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { stageDistribution } from "./stage.mjs";
import {
  ALLOWED_BARE_REQUIRES, createFramer, diffInvariants, missingArtifacts, pathsUnder, summarize, unexpectedRequires,
} from "./stagedCheck.mjs";

const REPO = resolve(new URL("../..", import.meta.url).pathname);
const require = createRequire(import.meta.url);
const work = mkdtempSync(join(tmpdir(), "kkss-staged-work-"));
const results = [];

function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status.padEnd(10)} ${name}${detail ? " — " + detail : ""}`);
}
/** A step returns nothing (PASS), a string (PASS with detail) or {unverified: why}; a throw is FAIL. */
async function step(name, fn) {
  try {
    const r = await fn();
    if (r && typeof r === "object" && "unverified" in r) record(name, "UNVERIFIED", r.unverified);
    else record(name, "PASS", typeof r === "string" ? r : "");
  } catch (e) {
    record(name, "FAIL", String(e?.message ?? e).split("\n")[0].slice(0, 400));
  }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

// --- fixtures ----------------------------------------------------------------
// A unit cube cut into Kuhn tetrahedra (positively oriented), n cells a side.
// TEMP = x + 2y + 3z is linear, so a probe and a P1 interpolation are exact.
function gridMdpa(n) {
  const at = (i, j, k) => i + (n + 1) * (j + (n + 1) * k) + 1;
  const nodes = [], temp = [], bottom = [];
  for (let k = 0; k <= n; k++) for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    nodes.push(`${at(i, j, k)} ${i / n} ${j / n} ${k / n}`);
    temp.push(`${at(i, j, k)} 0 ${i / n + 2 * j / n + 3 * k / n}`);
    if (k === 0) bottom.push(at(i, j, k));
  }
  const det = (a, b, c, d) => {
    const u = b.map((x, i) => x - a[i]), v = c.map((x, i) => x - a[i]), w = d.map((x, i) => x - a[i]);
    return u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0]);
  };
  const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const els = []; let id = 1;
  for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) for (const p of perms) {
    const pts = [[i, j, k]]; let cur = [i, j, k];
    for (const a of p) { cur = cur.slice(); cur[a]++; pts.push(cur); }
    const ids = pts.map((q) => at(...q));
    if (det(...pts) < 0) [ids[1], ids[2]] = [ids[2], ids[1]];
    els.push(`${id++} 1 ${ids.join(" ")}`);
  }
  return `Begin Properties 1\nEnd Properties\nBegin Nodes\n${nodes.join("\n")}\nEnd Nodes\n` +
    `Begin Elements Element3D4N\n${els.join("\n")}\nEnd Elements\nBegin NodalData TEMP\n${temp.join("\n")}\nEnd NodalData\n` +
    `Begin SubModelPart Bottom\nBegin SubModelPartNodes\n${bottom.join("\n")}\nEnd SubModelPartNodes\nEnd SubModelPart\n`;
}
const GRID = join(work, "grid.mdpa");
writeFileSync(GRID, gridMdpa(3));       // 64 nodes, 162 tetrahedra
const BIG = join(work, "big.mdpa");
writeFileSync(BIG, gridMdpa(14));       // 3375 nodes, 16 464 tetrahedra: long enough to cancel

// --- the in-process reference (the checkout's own core) -----------------------
const core = require(join(REPO, "out", "mcp", "tools.js"));
const viaJson = (v) => JSON.parse(JSON.stringify(v));
const IGNORE = ["path", "outputPath", "elapsedMs", "durationMs"];

// --- an MCP stdio client with no SDK -----------------------------------------
function startServer(stage, { trace } = {}) {
  const env = { PATH: process.env.PATH ?? "", HOME: work, TMPDIR: work }; // no NODE_PATH, nothing pointing at the repo
  const args = [...(trace ? ["--require", trace.preload] : []), join(stage.root, "dist", "mcpServer.js")];
  const proc = spawn(process.execPath, args, { cwd: work, env, stdio: ["pipe", "pipe", "pipe"] });
  const framer = createFramer(); const waiting = new Map(); const stray = []; let stderr = ""; let next = 1;
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (c) => {
    const { messages, malformed } = framer.push(c);
    stray.push(...malformed);
    for (const m of messages) if (m.id != null && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  });
  proc.stderr.setEncoding("utf8"); proc.stderr.on("data", (c) => { stderr += c; });
  const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
  const request = (method, params, timeoutMs = 120000) => new Promise((res, rej) => {
    const id = next++;
    const t = setTimeout(() => { waiting.delete(id); rej(new Error(`${method} timed out after ${timeoutMs} ms`)); }, timeoutMs);
    waiting.set(id, (m) => { clearTimeout(t); res(m); });
    send({ jsonrpc: "2.0", id, method, params });
  });
  const exited = new Promise((r) => proc.on("exit", (code, sig) => r({ code, sig })));
  return {
    proc, stray, stderr: () => stderr, exited,
    async init() {
      const r = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "staged-check", version: "1" } });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      return r.result;
    },
    /** Resolves {ok, value|error}: a tool error is data here, not a throw. */
    async call(name, args, timeoutMs) {
      const m = await request("tools/call", { name, arguments: args }, timeoutMs);
      const text = m.result?.content?.[0]?.text ?? m.error?.message ?? "";
      if (m.error || m.result?.isError) return { ok: false, error: text };
      try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: true, value: text }; }
    },
    /** Fire a call without awaiting it; returns its request id (for cancellation). */
    callNoWait(name, args) {
      const id = next++;
      waiting.set(id, () => {});
      send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
      return id;
    },
    cancel(requestId) { send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId, reason: "staged check" } }); },
    async close() { try { proc.stdin.end(); } catch {} proc.kill("SIGTERM"); await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]); proc.kill("SIGKILL"); },
  };
}
const ok = async (server, name, args, t) => {
  const r = await server.call(name, args, t);
  if (!r.ok) throw new Error(`${name}: ${r.error}`);
  return r.value;
};

// --- records the checkout must NOT be reached through ------------------------
const traceLog = join(work, "resolved.log");
const preload = join(work, "trace-resolve.cjs");
writeFileSync(preload, `
const fs = require("fs"), Module = require("module");
const log = ${JSON.stringify(traceLog)};
const note = (p) => { try { fs.appendFileSync(log, p + "\\n"); } catch {} };
const resolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { const r = resolve.call(this, req, ...rest); if (r.includes("/") || r.includes("\\\\")) note(r); return r; };
const read = fs.readFileSync;
fs.readFileSync = function (p, ...rest) { if (typeof p === "string" && /\\.(wasm|mjs|node)$/.test(p)) note(p); return read.call(this, p, ...rest); };
`);

let full, fullServer;
const repoVersion = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;

try {
  // ============================================================== the full stage
  // STAGED_WITHOUT=mmg-worker,meshio removes artifacts from the MAIN stage, to
  // show the positive checks can fail (the negative cases below prove detection).
  const without = (process.env.STAGED_WITHOUT ?? "").split(",").filter(Boolean);
  full = stageDistribution({ repo: REPO, without });
  console.log(`staged ${full.files.length} files, ${(full.bytes / 1e6).toFixed(1)} MB at ${full.root}`);

  await step("stage layout: every required artifact present, no node_modules", async () => {
    const missing = missingArtifacts(full.files);
    must(missing.length === 0, "missing: " + missing.join(", "));
    must(!full.files.some((f) => f.includes("node_modules")), "stage carries a node_modules directory");
    for (let d = dirname(full.root); d !== dirname(d); d = dirname(d)) {
      must(!existsSync(join(d, "node_modules", "@meshioplusplus")), `an ancestor (${d}) carries @meshioplusplus — the stage is not isolated`);
    }
    must(!(full.root + sep).startsWith(REPO + sep), "stage is inside the repository");
  });

  await step("bundles name no package outside the documented allow-list", async () => {
    const bad = {};
    // The server and the workers it spawns. extension.js (vscode) and the Flowgraph
    // server (express's optional deps) are other products of the same dist/.
    const reachable = (x) => x === "dist/mcpServer.js" || /^dist\/(mmg|oracleOp|derived|meshioRead|meshioWrite)Worker\.js$/.test(x);
    for (const f of full.files.filter(reachable)) {
      const un = unexpectedRequires(readFileSync(join(full.root, f), "utf8"));
      if (un.length) bad[f] = un;
    }
    must(Object.keys(bad).length === 0, JSON.stringify(bad));
    return "allowed: " + Object.keys(ALLOWED_BARE_REQUIRES).join(", ");
  });

  fullServer = startServer(full, { trace: { preload } });
  const server = fullServer;
  let info;
  await step("server starts from the stage and answers initialize", async () => {
    info = await server.init();
    must(info?.serverInfo?.name === "kratos-mdpa", "unexpected serverInfo " + JSON.stringify(info?.serverInfo));
    must(info.serverInfo.version === repoVersion, `server reports ${info.serverInfo.version}, package.json says ${repoVersion}`);
  });

  let caps;
  await step("identity: kernel version, wiring and capabilities match the checkout", async () => {
    caps = await ok(server, "mesh_capabilities", {});
    const ref = viaJson(await core.meshCapabilities());
    const stagedPkg = JSON.parse(readFileSync(join(full.root, "dist", "meshio", "package.json"), "utf8"));
    const repoPkg = JSON.parse(readFileSync(join(REPO, "node_modules", "@meshioplusplus", "wasm", "package.json"), "utf8"));
    must(stagedPkg.version === repoPkg.version, `staged kernel ${stagedPkg.version} != installed ${repoPkg.version}`);
    must(caps.packageVersion === stagedPkg.version, `server loaded kernel ${caps.packageVersion}, staged copy is ${stagedPkg.version}`);
    must(caps.runtime?.meshio?.source === "bundled", "kernel tree not resolved from the bundled copy: " + JSON.stringify(caps.runtime?.meshio));
    must(pathsUnder(full.root, [caps.runtime.meshio.dir]).length === 1 || caps.runtime.meshio.dir === join(full.root, "dist", "meshio"), "kernel tree is outside the stage: " + caps.runtime.meshio.dir);
    const notWorker = Object.entries(caps.runtime.workers).filter(([, m]) => m !== "worker");
    must(notWorker.length === 0, "fell back in-process: " + notWorker.map(([k]) => k).join(", "));
    must(caps.runtime.mmgWasm === "bundled", "MMG wasm not fed from the staged file");
    const d = diffInvariants(caps.live, ref.live);
    must(d.length === 0, "reader/writer keys differ from the checkout: " + d.slice(0, 3).join("; "));
    must(caps.full?.installed === true, "the full (OpenCASCADE) artifact is not installed in the stage");
    return `kernel ${caps.packageVersion}, backend ${caps.backend}, ${caps.live.readers.length} readers / ${caps.live.writers.length} writers`;
  });

  await step("stdout carries only JSON-RPC (no stray output from the server or its workers)", async () => {
    must(server.stray.length === 0, "non-JSON on stdout: " + JSON.stringify(server.stray.slice(0, 2)));
  });

  // ------------------------------------------------------------ the matrix
  await step("mesh_info: counts, bounds, SubModelPart and field agree with the core", async () => {
    const v = await ok(server, "mesh_info", { path: GRID });
    must(v.nodeCount === 64 && v.elementCount === 162, `counts ${v.nodeCount}/${v.elementCount}`);
    must(v.subModelParts?.[0]?.name === "Bottom" && v.subModelParts[0].counts.nodes === 16, "SubModelPart Bottom lost");
    must(v.fields?.some((f) => f.variable === "TEMP" && f.kind === "Nodal"), "TEMP field lost");
    const d = diffInvariants(v, viaJson(await core.meshInfo({ path: GRID })), { ignore: IGNORE });
    must(d.length === 0, d.slice(0, 3).join("; "));
  });

  await step("mesh_quality agrees with the core", async () => {
    const v = await ok(server, "mesh_quality", { path: GRID });
    must(v.overallOk === true && v.analyzedCount === 162, "unexpected quality verdict");
    const d = diffInvariants(v, viaJson(await core.meshQuality({ path: GRID })), { ignore: IGNORE, abs: 1e-6, rel: 1e-6 });
    must(d.length === 0, d.slice(0, 3).join("; "));
  });

  await step("mesh_probe: a linear field is reproduced and the CSV is written", async () => {
    const csv = join(work, "probe.csv");
    const args = { path: GRID, points: [[0, 0, 0.5], [1, 0, 0.5]], variable: "TEMP", samples: 5 };
    const v = await ok(server, "mesh_probe", { ...args, outputPath: csv });
    v.rows.forEach((r, i) => must(Math.abs(r.values[0] - (1.5 + i / 4)) < 1e-5, `row ${i}: ${r.values[0]}`));
    must(v.uncovered === 0, "uncovered samples");
    must(readFileSync(csv, "utf8").trim().split("\n").length === 6, "CSV should have a header and 5 rows");
    const d = diffInvariants(v, viaJson(await core.meshProbe(args)), { ignore: IGNORE, abs: 1e-6, rel: 1e-6 });
    must(d.length === 0, d.slice(0, 3).join("; "));
  });

  await step("mesh_select: a formula seed returns the Bottom elements the core returns", async () => {
    const args = { path: GRID, seed: { kind: "formula", expr: "z <= 0.34", rule: "all" } };
    const v = await ok(server, "mesh_select", args);
    const d = diffInvariants(v, viaJson(await core.meshSelect(args)), { ignore: IGNORE });
    must(d.length === 0, d.slice(0, 3).join("; "));
  });

  await step("mesh_transform: edits compose, delete reduces, set property reads back, undo restores", async () => {
    const out = join(work, "edited.mdpa");
    const r = await ok(server, "mesh_transform", {
      path: GRID, outputPath: out,
      ops: [{ op: "translate", dx: 2, dy: 0, dz: 0 }, { op: "translate", dx: -2, dy: 0, dz: 0 },
        { op: "setProperty", propertyId: 1, name: "DENSITY", value: 7800 }, { op: "deleteEntities", elements: [1, 2] }],
    });
    must(r.outcomes?.length === 4, "expected four outcomes");
    const v = await ok(server, "mesh_info", { path: out });
    must(v.elementCount === 160, `deleteEntities left ${v.elementCount} elements`);
    must(JSON.stringify(v.bounds) === JSON.stringify({ min: [0, 0, 0], max: [1, 1, 1] }), "translate then translate back moved the mesh: " + JSON.stringify(v.bounds));
    must(v.properties?.find((p) => p.id === 1)?.values?.DENSITY === 7800, "property edit not saved");
    must(v.fields?.some((f) => f.variable === "TEMP"), "TEMP lost");
  });

  const roundTrips = [[".vtu", "VtkCell_10"], [".msh", null], [".mdpa", "Element3D4N"]];
  for (const [ext] of roundTrips) {
    await step(`mesh_convert ${ext}: written by the write worker and reopened by the read worker`, async () => {
      const out = join(work, "rt" + ext);
      await ok(server, "mesh_convert", { path: GRID, outputPath: out });
      const v = await ok(server, "mesh_info", { path: out });
      must(v.nodeCount === 64 && v.elementCount === 162, `reopened ${v.nodeCount}/${v.elementCount}`);
      must(v.fields?.some((f) => f.variable === "TEMP"), "TEMP field lost on the round trip");
      must(JSON.stringify(v.bounds) === JSON.stringify({ min: [0, 0, 0], max: [1, 1, 1] }), "bounds changed");
    });
  }

  await step("oracle op (smooth, fixed boundary) runs in its worker and keeps the topology", async () => {
    const out = join(work, "smooth.mdpa");
    await ok(server, "mesh_transform", { path: GRID, outputPath: out, ops: [{ op: "smooth", iterations: 3, fixBoundary: true }] });
    const v = await ok(server, "mesh_info", { path: out });
    must(v.nodeCount === 64 && v.elementCount === 162, "topology changed");
    for (let i = 0; i < 3; i++) must(Math.abs(v.bounds.min[i]) < 1e-6 && Math.abs(v.bounds.max[i] - 1) < 1e-6, "bounds moved");
  });

  await step("derived mesh (slice at z = 0.5) runs in its worker", async () => {
    const out = join(work, "slice.vtu");
    await ok(server, "mesh_derive", { path: GRID, kind: "slice", origin: [0, 0, 0.5], normal: [0, 0, 1], outputPath: out });
    const v = await ok(server, "mesh_info", { path: out });
    must(v.elementCount > 0 && Math.abs(v.bounds.min[2] - 0.5) < 1e-6 && Math.abs(v.bounds.max[2] - 0.5) < 1e-6, "slice is not planar at z = 0.5: " + JSON.stringify(v.bounds));
  });

  await step("MMG remesh (hsiz 0.2) refines the mesh and keeps the bounds and the volume", async () => {
    const out = join(work, "remesh.mdpa");
    await ok(server, "mesh_transform", { path: GRID, outputPath: out, ops: [{ op: "remesh", mode: "hsiz", hsiz: 0.2 }] });
    const v = await ok(server, "mesh_info", { path: out });
    must(v.elementCount > 162 * 3, `only ${v.elementCount} elements after refining`);
    for (let i = 0; i < 3; i++) must(Math.abs(v.bounds.min[i]) < 1e-6 && Math.abs(v.bounds.max[i] - 1) < 1e-6, "bounds changed");
    must(Math.abs(v.measure.value - 1) < 1e-6, "volume changed: " + v.measure.value);
  });

  // --------------------------------------------------- cancel during pending work
  await step("cancelling a running remesh frees the worker and leaves the mesh unchanged", async () => {
    const out = join(work, "cancelled.mdpa");
    const id = server.callNoWait("mesh_transform", { path: BIG, outputPath: out, ops: [{ op: "remesh", mode: "hsiz", hsiz: 0.02 }] });
    await new Promise((r) => setTimeout(r, 1500));
    server.cancel(id);
    // The MMG runs are serialized by a lock: this only returns promptly when the cancelled worker is gone.
    const t0 = Date.now();
    const quick = await ok(server, "mesh_transform", { path: GRID, outputPath: join(work, "after.mdpa"), ops: [{ op: "remesh", mode: "optimize" }] }, 40000);
    await ok(server, "mesh_info", { path: GRID }, 10000);
    await new Promise((r) => setTimeout(r, 500));
    must(quick.outcomes?.length === 1 && !quick.outcomes[0].noop, "follow-up remesh did not run");
    // An aborted operation is a noop outcome, and mesh_transform writes the
    // unchanged model for it: whatever exists at outputPath must be the input.
    if (existsSync(out)) {
      const v = await ok(server, "mesh_info", { path: out });
      must(v.nodeCount === 3375 && v.elementCount === 16464, `the cancelled remesh left ${v.nodeCount}/${v.elementCount}, not the input's 3375/16464`);
    }
    return `server answered ${Date.now() - t0} ms after the cancel` + (existsSync(out) ? "; output is the unchanged input" : "; nothing written");
  });

  await step("no resolution reached the checkout", async () => {
    await fullServer.close(); fullServer = undefined;
    if (!existsSync(traceLog)) return { unverified: "the resolution trace recorded nothing (preload not applied)" };
    const seen = readFileSync(traceLog, "utf8").split("\n").filter(Boolean);
    const inRepo = pathsUnder(REPO, seen);
    must(inRepo.length === 0, `${inRepo.length} paths resolved inside the repository, e.g. ${inRepo[0]}`);
    const wasm = seen.filter((p) => p.endsWith(".wasm"));
    if (!wasm.some((p) => p.startsWith(full.root))) return { unverified: `no .wasm read was traced (saw ${seen.length} paths, none in the repository)` };
    return `${seen.length} traced paths, ${wasm.length} wasm reads, all inside the stage`;
  });

  // ================================================== negative cases: one file lost
  // The defect class: today a packaged distribution that lost a file still
  // passes, because every runner has an in-process fallback and the kernel tree
  // can be found in node_modules. Each case below must be DETECTED.
  const SEED_MSH = join(work, "rt.msh");
  const negatives = [
    ["meshio", "the kernel tree", async (s) => {
      const r = await s.call("mesh_info", { path: SEED_MSH });
      must(!r.ok, "reading a .msh succeeded without the kernel tree");
      must(/meshio|@meshioplusplus/i.test(r.error), "the failure does not name the missing kernel: " + r.error.slice(0, 200));
      const c = await s.call("mesh_capabilities", {});
      must(!c.ok || c.value.runtime?.meshio == null, "capabilities still report a kernel tree");
    }],
    ["mmg-wasm", "the MMG wasm", async (s) => {
      const c = await ok(s, "mesh_capabilities", {});
      must(c.runtime.mmgWasm === "package", "capabilities do not report the missing staged wasm");
      const r = await s.call("mesh_transform", { path: GRID, outputPath: join(work, "neg.mdpa"), ops: [{ op: "remesh", mode: "optimize" }] }, 60000);
      // A worker failure is reported as a noop outcome, not a tool error.
      const o = r.ok ? r.value.outcomes?.[0] : undefined;
      must(r.ok ? o?.noop === true && /mmg-core\.wasm/.test(o.message ?? "") : r.error.length > 0,
        "a remesh neither failed nor named the missing wasm: " + JSON.stringify(o ?? r.error).slice(0, 200));
    }],
    ["mmg-worker", "the MMG worker", async (s) => (await ok(s, "mesh_capabilities", {})).runtime.workers.mmg === "in-process" || Promise.reject(new Error("not reported"))],
    ["oracle-worker", "the oracle worker", async (s) => (await ok(s, "mesh_capabilities", {})).runtime.workers.oracle === "in-process" || Promise.reject(new Error("not reported"))],
    ["derived-worker", "the derived-mesh worker", async (s) => (await ok(s, "mesh_capabilities", {})).runtime.workers.derived === "in-process" || Promise.reject(new Error("not reported"))],
    ["read-worker", "the read worker", async (s) => (await ok(s, "mesh_capabilities", {})).runtime.workers.meshioRead === "in-process" || Promise.reject(new Error("not reported"))],
    ["write-worker", "the write worker", async (s) => (await ok(s, "mesh_capabilities", {})).runtime.workers.meshioWrite === "in-process" || Promise.reject(new Error("not reported"))],
  ];
  for (const [name, label, check] of negatives) {
    await step(`missing ${label} is detected, not silently covered`, async () => {
      if (name === "meshio" && !existsSync(SEED_MSH)) return { unverified: "no .msh was written by the earlier round-trip step to read back" };
      const stage = stageDistribution({ repo: REPO, without: [name], prefix: "kkss-staged-neg-" });
      const s = startServer(stage);
      try {
        const missing = missingArtifacts(stage.files);
        must(missing.length > 0, "the stage was not actually missing anything");
        await s.init();
        await check(s);
        return `absent: ${missing.join(", ")}`;
      } finally { await s.close(); stage.remove(); }
    });
  }
} catch (e) {
  record("harness", "FAIL", String(e?.stack ?? e).split("\n").slice(0, 3).join(" | "));
} finally {
  if (fullServer) await fullServer.close();
  full?.remove();
  rmSync(work, { recursive: true, force: true });
}

const summary = summarize(results);
mkdirSync(join(REPO, "out", "staged"), { recursive: true });
writeFileSync(join(REPO, "out", "staged", "staged.json"), JSON.stringify({ when: new Date().toISOString(), node: process.version, summary, results }, null, 2));
console.log(`\n${summary.pass} passed, ${summary.fail} failed, ${summary.unverified} unverified`);
if (!summary.ok) process.exit(1);
if (!summary.verified) { console.error("nothing was verified"); process.exit(1); }
