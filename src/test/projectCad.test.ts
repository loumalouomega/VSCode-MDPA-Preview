/**
 * `projectToCad` (meshio++ 17.23.0) as a coordinate-only oracle op, over the real
 * WASM: a Mesh-CAD-faces surface whose nodes were pushed off the CAD comes back
 * onto it, nothing but coordinates changes, and the refusals name their cause.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { applyOpAsync, opRecordFromMessage, parseOpsJson, serializeOps } from "../parser/operations";
import { parseMeshFile } from "../parser/meshFileParser";
import { deriveMesh } from "../parser/deriveMesh";
import { generateMesh } from "../parser/kernelMeshes";
import { extractSkinModel } from "../parser/extractSkin";
import { simplexifyModel } from "../parser/simplexify";
import { writeMdpa } from "../parser/writers/mdpaWriter";
import { meshConvert, meshTransform, meshCapabilities } from "../mcp/tools";
import { MdpaModel } from "../parser/types";

async function cubeCadFile(dir: string): Promise<string> {
  const box = await generateMesh({ kind: "generate", shape: "box", params: { dims: [2, 2, 2] } });
  const tris = simplexifyModel(extractSkinModel(box.model).model).model;
  const skin = { ...tris, blocks: tris.blocks.map((b) => ({ ...b, kind: "Conditions" as const, name: "SurfaceCondition3D3N" })) };
  const mdpa = path.join(dir, "cube.mdpa");
  fs.writeFileSync(mdpa, writeMdpa(skin));
  await meshConvert({ path: mdpa, outputPath: path.join(dir, "box.step") });
  return path.join(dir, "box.cad.json");
}

/** The CAD surface mesh of the file plus a copy whose nodes were pushed off the CAD. */
async function surfaceAndPushed(cadFile: string): Promise<{ clean: MdpaModel; pushed: MdpaModel }> {
  const cad = await parseMeshFile(cadFile);
  const r = await deriveMesh(cad, { kind: "cadSurface", targetSize: 0.4 });
  const clean = r.model;
  const coords = new Float32Array(clean.coords);
  for (let i = 0; i < coords.length; i++) coords[i] += Math.sin(i * 12.9) * 0.01;
  return { clean, pushed: { ...clean, coords } };
}

/** How far the node at index `i` is from the surface of the [0,1]^3 cube (the CAD of the fixture). */
const offCube = (m: MdpaModel, i: number) => {
  let near = Infinity;
  for (let k = 0; k < 3; k++) near = Math.min(near, Math.abs(m.coords[i * 3 + k]), Math.abs(m.coords[i * 3 + k] - 1));
  return near;
};
const worstOffCube = (m: MdpaModel) => {
  let d = 0;
  for (let i = 0; i < m.nodeCount; i++) d = Math.max(d, offCube(m, i));
  return d;
};
const movedNodes = (a: MdpaModel, b: MdpaModel) => {
  let n = 0;
  for (let i = 0; i < a.nodeCount; i++) if (Math.abs(a.coords[i * 3] - b.coords[i * 3]) + Math.abs(a.coords[i * 3 + 1] - b.coords[i * 3 + 1]) + Math.abs(a.coords[i * 3 + 2] - b.coords[i * 3 + 2]) > 0) n++;
  return n;
};

test("projectToCad brings pushed CAD-surface nodes back onto the B-rep and changes nothing else", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pcad-"));
  const cadFile = await cubeCadFile(dir);
  const { clean, pushed } = await surfaceAndPushed(cadFile);
  assert.ok(worstOffCube(clean) < 1e-4, "the unperturbed CAD mesh lies on the cube");
  assert.ok(worstOffCube(pushed) > 0.003, "the fixture really pushed nodes off the CAD");

  const out = await applyOpAsync(pushed, { op: "projectToCad", path: cadFile });
  assert.ok(!out.noop, out.message ?? "");
  assert.match(out.message ?? "", /Projected \d+ node\(s\) onto the CAD/);
  assert.ok(worstOffCube(out.model) < 1e-4, `back on the CAD (off by ${worstOffCube(out.model)})`);
  // Coordinate-only: identity of everything else.
  assert.equal(out.model.blocks, pushed.blocks);
  assert.equal(out.model.subModelParts, pushed.subModelParts);
  assert.equal(out.model.fields, pushed.fields);
  assert.equal(out.model.nodeIds, pushed.nodeIds);
});

test("projectToCad pinPart holds nodes and maxDistance leaves distant ones", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pcad-"));
  const cadFile = await cubeCadFile(dir);
  const surface = await surfaceAndPushed(cadFile);
  const part = { name: "Held", path: "Held", nodeIds: Int32Array.from(surface.pushed.nodeIds.slice(0, 5)), elementIds: new Int32Array(0), conditionIds: new Int32Array(0), geometryIds: new Int32Array(0), constraintIds: new Int32Array(0), children: [] };
  const pushed = { ...surface.pushed, subModelParts: [...surface.pushed.subModelParts, part] };
  const held = await applyOpAsync(pushed, { op: "projectToCad", path: cadFile, pinPart: part.path });
  const idx = new Map<number, number>();
  pushed.nodeIds.forEach((id, i) => idx.set(id, i));
  for (const id of part.nodeIds) {
    const i = idx.get(id)!;
    for (let k = 0; k < 3; k++) assert.equal(held.model.coords[i * 3 + k], pushed.coords[i * 3 + k]);
  }
  assert.match(held.message ?? "", /5 not selected to move/);
  assert.ok(movedNodes(pushed, held.model) > 0 && movedNodes(pushed, held.model) <= pushed.nodeCount - 5);

  const far = await applyOpAsync(pushed, { op: "projectToCad", path: cadFile, maxDistance: 1e-6 });
  assert.ok(far.noop, "nothing within 1e-6 is projected");
  assert.match(far.message ?? "", /No node was projected/);
});

test("projectToCad refuses by name: no face field, not a B-rep, unreadable file, unknown part", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pcad-"));
  const cadFile = await cubeCadFile(dir);
  const { pushed } = await surfaceAndPushed(cadFile);

  const noTag = { ...pushed, fields: pushed.fields.filter((f) => f.variable !== "CAD_FACE") };
  const a = await applyOpAsync(noTag, { op: "projectToCad", path: cadFile });
  assert.ok(a.noop);
  assert.match(a.message ?? "", /no CAD_FACE field/);

  const notBrep = path.join(dir, "cube.mdpa");
  const b = await applyOpAsync(pushed, { op: "projectToCad", path: notBrep });
  assert.ok(b.noop);
  assert.match(b.message ?? "", /carries no CAD B-rep/);

  const c = await applyOpAsync(pushed, { op: "projectToCad", path: path.join(dir, "missing.cad.json") });
  assert.ok(c.noop);
  assert.match(c.message ?? "", /Could not read/);

  const d = await applyOpAsync(pushed, { op: "projectToCad", path: cadFile, pinPart: "Nope" });
  assert.ok(d.noop);
  assert.match(d.message ?? "", /"Nope".*not found/);
});

test("projectToCad records validate and survive a recipe round trip", () => {
  const rec = opRecordFromMessage({ op: "projectToCad", path: "a.cad.json", maxDistance: "0.5", pinPart: "Fixed", trimSamples: "8" });
  assert.deepEqual(rec, { op: "projectToCad", path: "a.cad.json", maxDistance: 0.5, pinPart: "Fixed", trimSamples: 8 });
  assert.equal(opRecordFromMessage({ op: "projectToCad" }), undefined, "path is required");
  assert.equal(opRecordFromMessage({ op: "projectToCad", path: "a.cad.json", maxDistance: -1 }), undefined);
  const back = parseOpsJson(serializeOps([rec!], "test"));
  assert.deepEqual(back.operations, [rec]);
  assert.equal(back.warnings.length, 0);
});

test("mesh_transform runs projectToCad and mesh_capabilities lists it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pcad-"));
  const cadFile = await cubeCadFile(dir);
  const { pushed } = await surfaceAndPushed(cadFile);
  const mdpa = path.join(dir, "pushed.mdpa");
  fs.writeFileSync(mdpa, writeMdpa(pushed));
  const out = path.join(dir, "projected.mdpa");
  const r = (await meshTransform({ path: mdpa, outputPath: out, ops: [{ op: "projectToCad", path: cadFile }] })) as { outcomes?: { message?: string; noop?: boolean }[] };
  assert.ok(fs.existsSync(out));
  assert.match(JSON.stringify(r), /Projected \d+ node/);

  const caps = (await meshCapabilities()) as { operations: { available: string[]; unavailable: { name: string }[] } };
  assert.ok(caps.operations.available.includes("projectToCad"));
  assert.ok(!caps.operations.unavailable.some((u) => u.name === "projectToCad"));
});
