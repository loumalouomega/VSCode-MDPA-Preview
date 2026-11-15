/**
 * meshio++ 20.1.0 over the real WASM: `adaptVolume`, the tetrahedral remesh to a graded size field,
 * adopted in place.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { loadMeshio, meshioPackageVersion } from "../parser/meshio";
import { applyOpAsync, opRecordFromMessage, parseOpsJson, serializeOps } from "../parser/operations";
import { refineModel } from "../parser/refineMesh";
import { parseCommandLine } from "../parser/commandParse";
import { MdpaModel } from "../parser/types";
import { tetBar } from "./fixtures/shapes";

const rec = (msg: Record<string, unknown>) => {
  const r = opRecordFromMessage({ type: "applyOp", ...msg });
  assert.ok(r, `${String(msg.op)} must validate`);
  return r!;
};
const count = (m: MdpaModel, kind: string) => m.blocks.filter((b) => b.kind === kind).reduce((a, b) => a + b.count, 0);

const fineBar = (): MdpaModel => {
  const r = refineModel(tetBar(3), 1);
  return (r as { model?: MdpaModel }).model ?? (r as unknown as MdpaModel);
};

test("the installed kernel is 20.1.x and exposes adaptVolume", async () => {
  assert.match(meshioPackageVersion()!, /^20\.(1|[2-9])/);
  const k = (await loadMeshio()) as unknown as Record<string, unknown>;
  assert.equal(typeof k.adaptVolume, "function");
});

test("adaptVolume remeshes a tetrahedral bar in place and keeps what the kernel can keep", async () => {
  const model = fineBar();
  const before = count(model, "Elements");
  const out = await applyOpAsync(model, rec({ op: "adaptVolume", hmax: 2, hmin: 0.3 }));
  assert.ok(!out.noop, String(out.message));
  assert.match(String(out.message), /Adapted \d+ → \d+ tetrahedra/);
  assert.notEqual(count(out.model, "Elements"), before);
  // Blocks keep Kratos names; SubModelParts survive with elements in them.
  assert.ok(out.model.blocks.some((b) => b.kind === "Elements" && b.name === "Element3D4N"));
  const left = out.model.subModelParts.find((p) => p.name === "Left");
  const right = out.model.subModelParts.find((p) => p.name === "Right");
  assert.ok(left && left.elementIds.length > 0);
  assert.ok(right && right.elementIds.length > 0);
  // The surface Conditions are re-derived from the new skin.
  assert.ok(count(out.model, "Conditions") > 0);
  // The nodal field crosses.
  assert.ok(out.model.fields.some((f) => f.kind === "Nodal" && f.variable === "T"));
});

test("adaptVolume refuses a non-tetrahedral mesh and an unknown size field by name", async () => {
  const hexes = { ...fineBar(), blocks: fineBar().blocks.map((b) => (b.kind === "Elements" ? { ...b, vtkCellType: 12 } : b)) } as MdpaModel;
  const a = await applyOpAsync(hexes, rec({ op: "adaptVolume" }));
  assert.ok(a.noop);
  assert.match(String(a.message), /linear tetrahedra/);
  const b = await applyOpAsync(fineBar(), rec({ op: "adaptVolume", sizeArray: "NOPE" }));
  assert.ok(b.noop);
  assert.match(String(b.message), /not a Nodal field/);
});

test("adaptVolume records validate, round trip and parse from the command line", async () => {
  assert.equal(opRecordFromMessage({ type: "applyOp", op: "adaptVolume", hmin: -1 }), undefined);
  assert.equal(opRecordFromMessage({ type: "applyOp", op: "adaptVolume", hmin: 2, hmax: 1 }), undefined);
  assert.equal(opRecordFromMessage({ type: "applyOp", op: "adaptVolume", qualityMetric: "nope" }), undefined);
  const r = rec({ op: "adaptVolume", hmin: "0.2", hmax: 1, hgrad: 1.3, collapse: "false", qualityMetric: "mean_ratio" });
  assert.equal((r as { collapse?: boolean }).collapse, false);
  const text = serializeOps([r], "x.mdpa");
  const back = parseOpsJson(text);
  assert.deepEqual(back.operations, [r]);
  const line = parseCommandLine("adaptVolume hmin=0.1 hmax=0.5 hgrad=1.3");
  assert.ok(line.ok !== false, JSON.stringify(line));
});

test("adaptVolume on an already conforming mesh with every edit switched off is a noop", async () => {
  const out = await applyOpAsync(fineBar(), rec({ op: "adaptVolume", collapse: false, split: false, swap: false, smooth: false }));
  assert.ok(out.noop);
});

// --- the fitting kernels wired beside adaptVolume ------------------------------------------

import { deriveMesh } from "../parser/deriveMesh";
import { contactPairsReport } from "../parser/analysisOps";
import { icosphere } from "./fixtures/shapes";

test("decimateVolume simplifies a tetrahedral bar and keeps ids, parts and the pinned boundary", async () => {
  const model = fineBar();
  const before = count(model, "Elements");
  const r = await deriveMesh(model, { kind: "decimateVolume", ratio: 0.5 });
  const after = count(r.model, "Elements");
  assert.ok(after < before, `${after} < ${before}`);
  assert.match(r.summary, /Simplified \d+ → \d+ tetrahedra/);
  // Survivors keep their ids and the boundary Conditions stay (the boundary is pinned by default).
  const ids = new Set(model.blocks.find((b) => b.kind === "Elements")!.entityIds);
  assert.ok(r.model.blocks.find((b) => b.kind === "Elements")!.entityIds.every((id) => ids.has(id)));
  assert.equal(count(r.model, "Conditions"), count(model, "Conditions"));
  assert.ok(r.model.subModelParts.find((p) => p.name === "Left")!.elementIds.every((id) => ids.has(id)));
  await assert.rejects(() => deriveMesh(model, { kind: "decimateVolume" }), /exactly one/);
  await assert.rejects(() => deriveMesh(model, { kind: "decimateVolume", ratio: 0.5, maxFaces: 3 }), /surface decimation only/);
});

test("decimateVolume refuses a mesh that is not all tetrahedra by name", async () => {
  const hexes = { ...fineBar(), blocks: fineBar().blocks.map((b) => (b.kind === "Elements" ? { ...b, vtkCellType: 12 } : b)) } as MdpaModel;
  await assert.rejects(() => deriveMesh(hexes, { kind: "decimateVolume", ratio: 0.5 }), /linear tetrahedra/);
});

test("computeNormals writes one unit normal per node of a sphere, outward for outward winding", async () => {
  const sphere = icosphere(2, 2);
  const out = await applyOpAsync(sphere, rec({ op: "computeNormals" }));
  assert.ok(!out.noop, String(out.message));
  const f = out.model.fields.find((x) => x.variable === "NORMAL")!;
  assert.equal(f.components, 3);
  assert.equal(f.ids.length, sphere.nodeCount);
  for (let i = 0; i < 5; i++) {
    const [x, y, z] = [sphere.coords[i * 3], sphere.coords[i * 3 + 1], sphere.coords[i * 3 + 2]];
    const dot = (f.values[i * 3] * x + f.values[i * 3 + 1] * y + f.values[i * 3 + 2] * z) / Math.hypot(x, y, z);
    assert.ok(dot > 0.99, `node ${i} normal points outward (${dot})`);
  }
  const area = await applyOpAsync(sphere, rec({ op: "computeNormals", weight: "area", output: "N_AREA" }));
  assert.ok(area.model.fields.some((x) => x.variable === "N_AREA"));
  const vol = await applyOpAsync(fineBar(), rec({ op: "computeNormals" }));
  assert.ok(vol.noop);
  assert.match(String(vol.message), /surface/);
});

test("findInterface, splitInterface and regionAdjacency work on the SubModelParts of a tetrahedral bar", async () => {
  const bar = fineBar();
  const f = await deriveMesh(bar, { kind: "findInterface", options: { regionA: "Left", regionB: "Right" } });
  assert.match(f.summary, /Interface between Left and Right: \d+ facet pair/);
  assert.ok(f.model.fields.some((x) => x.variable === "INTERFACE_GAP"));
  assert.ok(count(f.model, "Elements") > 0 || f.model.blocks.length > 0);
  const s = await deriveMesh(bar, { kind: "splitInterface", options: { regionA: "Left", regionB: "Right" } });
  assert.match(s.summary, /node\(s\) duplicated/);
  assert.ok(s.model.nodeCount > bar.nodeCount, "nodes were duplicated along the interface");
  const a = await deriveMesh(bar, { kind: "regionAdjacency", options: { regions: ["Left", "Right"] } });
  assert.match(a.summary, /Region adjacency/);
  await assert.rejects(() => deriveMesh(bar, { kind: "findInterface", options: { regionA: "Left" } }), /regionB/);
  await assert.rejects(() => deriveMesh(bar, { kind: "findInterface", options: { regionA: "Left", regionB: "Nope" } }), /not found or holds no elements/);
});

test("contactPairs pairs the nodes of one part with the cells of another and names the ids", async () => {
  const bar = fineBar();
  const slaves = bar.subModelParts.find((p) => p.name === "Left")!.nodeIds.length;
  const none = await contactPairsReport(bar, { slavePart: "Left", masterPart: "Right", tolerance: 0.05 });
  assert.equal(none.numPairs, 0, "nothing lies within 0.05 of the far part");
  assert.equal(none.numUnmatched, slaves);
  const r = await contactPairsReport(bar, { slavePart: "Left", masterPart: "Right", tolerance: 1 });
  assert.equal(r.numPairs + r.numUnmatched, slaves);
  assert.ok(r.numPairs > 0);
  const nodes = new Set(bar.nodeIds);
  for (const p of r.pairs) assert.ok(nodes.has(p.slaveNode));
  await assert.rejects(() => contactPairsReport(bar, { slavePart: "Nope", masterPart: "Right" }), /not found/);
  await assert.rejects(() => contactPairsReport(bar, { slavePart: "Left", masterPart: "Right", tolerance: -1 }), /nonnegative/);
});

test("the MCP tools reach adaptVolume, decimateVolume, the interface kernels and mesh_contact_pairs", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { meshTransform, meshDerive, meshContactPairs, meshCapabilities } = await import("../mcp/tools");
  const { writeMeshFileAsync } = await import("../parser/writers/meshWriter");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp201-"));
  const input = path.join(dir, "bar.mdpa");
  fs.writeFileSync(input, (await writeMeshFileAsync(fineBar(), ".mdpa", {})).data);

  const adapted = path.join(dir, "adapted.mdpa");
  const t = (await meshTransform({ path: input, ops: [{ op: "adaptVolume", hmax: 2, hmin: 0.3 }], outputPath: adapted })) as { outcomes?: { noop?: boolean; message?: string }[] };
  assert.ok(fs.existsSync(adapted), JSON.stringify(t).slice(0, 300));
  assert.ok(!t.outcomes?.[0]?.noop, String(t.outcomes?.[0]?.message));

  const simplified = path.join(dir, "simplified.vtu");
  await meshDerive({ path: input, kind: "decimateVolume", ratio: 0.5, outputPath: simplified } as never);
  assert.ok(fs.existsSync(simplified));
  const iface = path.join(dir, "interface.vtu");
  await meshDerive({ path: input, kind: "findInterface", options: { regionA: "Left", regionB: "Right" }, outputPath: iface } as never);
  assert.ok(fs.existsSync(iface));

  const out = path.join(dir, "pairs.csv");
  const pairs = (await meshContactPairs({ path: input, slavePart: "Left", masterPart: "Right", tolerance: 1, outputPath: out })) as { numPairs: number; pairs: unknown[] };
  assert.ok(pairs.numPairs > 0);
  assert.match(fs.readFileSync(out, "utf8"), /^slaveNode,masterKind,masterEntity/);
  await assert.rejects(() => meshContactPairs({ path: input, slavePart: "Left", masterPart: "Right", outputPath: path.join(dir, "x.txt") }), /\.json or \.csv/);

  const caps = (await meshCapabilities()) as { operations: { available: string[]; unavailable: { name: string }[] } };
  assert.ok(caps.operations.available.some((o) => o.startsWith("adaptVolume")));
  assert.ok(caps.operations.unavailable.some((o) => o.name === "blendSteps"));
});
