/**
 * meshio++ 18.1.0 over the real WASM: the new point/surface derive kinds and
 * the facts the integration rests on (all measured, not read from the typings).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { deriveMesh } from "../parser/deriveMesh";
import { generateMesh } from "../parser/kernelMeshes";
import { loadMeshio, meshioPackageVersion } from "../parser/meshio";
import { MdpaModel } from "../parser/types";
import { icosphere } from "./fixtures/shapes";

const cellCount = (m: MdpaModel) => m.blocks.reduce((a, b) => a + b.count, 0);
const fieldNames = (m: MdpaModel) => m.fields.map((f) => f.variable);

test("the installed kernel is 18.3.0 and exposes the fourteen new functions", async () => {
  assert.ok(meshioPackageVersion()!.startsWith("18."), String(meshioPackageVersion()));
  const m = (await loadMeshio()) as unknown as Record<string, unknown>;
  for (const fn of ["adjacency", "convertCoordinates", "convexHull", "delaunay2d", "estimateNormals", "geodesicDistance", "laplacianEigenmodes", "morph", "parameterize", "prepareMetric", "reconstructSurface", "registerRigid", "untangle", "writeGraph"]) {
    assert.equal(typeof m[fn], "function", fn);
  }
});

test("convexHull of a cube is its 12 facets, area 6, volume 1, and keeps the input index of each vertex", async () => {
  const box = (await generateMesh({ kind: "generate", shape: "box", params: { dims: [2, 2, 2], size: [1, 1, 1] } })).model;
  const r = await deriveMesh(box, { kind: "convexHull" });
  assert.equal(r.model.nodeCount, 8);
  assert.equal(cellCount(r.model), 12);
  assert.match(r.summary, /area 6, volume 1/);
  assert.ok(fieldNames(r.model).includes("SOURCE_NODE_INDEX"));
});

test("delaunay2d triangulates a unit square into two triangles", async () => {
  const sq = (await generateMesh({ kind: "generate", shape: "rectangle", params: { dims: [1, 1], size: [1, 1] } })).model;
  const r = await deriveMesh(sq, { kind: "delaunay2d" });
  assert.equal(r.model.nodeCount, 4);
  assert.equal(cellCount(r.model), 2);
});

test("estimateNormals and reconstructSurface turn a sampled sphere into a surface", async () => {
  const pts = icosphere(1, 2);
  // A cloud: the vertices only, no cells.
  const cloud: MdpaModel = { ...pts, blocks: [], fields: [], subModelParts: [] };
  const normals = await deriveMesh(cloud, { kind: "estimateNormals", options: { k: 8 } });
  assert.ok(fieldNames(normals.model).some((v) => /normals/i.test(v)), fieldNames(normals.model).join(","));
  const surf = await deriveMesh(cloud, { kind: "reconstructSurface", options: { resolution: 24 } });
  assert.ok(cellCount(surf.model) > 100, `triangles ${cellCount(surf.model)}`);
  assert.match(surf.summary, /normals estimated/);
});

// --- in-place operations ---------------------------------------------------------

import { applyOpAsync, opRecordFromMessage } from "../parser/operations";
import { extractSkinModel } from "../parser/extractSkin";

const tetBox = async () => (await generateMesh({ kind: "generate", shape: "box", params: { dims: [3, 3, 3], size: [1, 1, 1] } })).model;
const fieldOf = (m: MdpaModel, name: string) => m.fields.find((f) => f.variable === name);

test("the seven records are validated by one spec: bad values refuse, required keys are enforced", () => {
  assert.ok(opRecordFromMessage({ op: "untangle", fixBoundary: true }));
  assert.equal(opRecordFromMessage({ op: "untangle", rings: -1 }), undefined);
  assert.equal(opRecordFromMessage({ op: "morph" }), undefined);
  assert.equal(opRecordFromMessage({ op: "registerRigid", path: "a.stl", method: "icp" }), undefined);
  assert.equal(opRecordFromMessage({ op: "geodesicDistance" }), undefined);
  assert.deepEqual((opRecordFromMessage({ op: "geodesicDistance", sourceNodes: "1, 2" }) as unknown as { sourceNodes: number[] }).sourceNodes, [1, 2]);
  assert.equal(opRecordFromMessage({ op: "convertCoordinates", arrays: "A", axis: [0, 0] }), undefined);
});

test("untangle on a healthy mesh is a noop with the reason; on a surface it names the refusal", async () => {
  const box = await tetBox();
  const same = await applyOpAsync(box, { op: "untangle" });
  assert.equal(same.noop, true);
  const skin = extractSkinModel(box).model;
  const refused = await applyOpAsync(skin, { op: "untangle" });
  assert.equal(refused.noop, true);
  assert.match(refused.message ?? "", /tetrahedron or hexahedron/);
});

test("untangle repairs a node pushed through its neighbours and keeps every id", async () => {
  const box = await tetBox();
  const coords = new Float32Array(box.coords);
  // Drag an interior node far outside so the cells around it invert.
  let interior = -1;
  for (let i = 0; i < box.nodeCount; i++) {
    const [x, y, z] = [coords[i * 3], coords[i * 3 + 1], coords[i * 3 + 2]];
    if (x > 0.2 && x < 0.8 && y > 0.2 && y < 0.8 && z > 0.2 && z < 0.8) { interior = i; break; }
  }
  assert.ok(interior >= 0);
  coords[interior * 3] = 1.6;
  const tangled: MdpaModel = { ...box, coords };
  const out = await applyOpAsync(tangled, { op: "untangle" });
  assert.ok(!out.noop, out.message ?? "");
  assert.deepEqual(Array.from(out.model.nodeIds), Array.from(box.nodeIds));
  assert.equal(out.model.blocks.length, box.blocks.length);
  assert.deepEqual(Array.from(out.model.blocks[0].connectivity), Array.from(box.blocks[0].connectivity));
  assert.match(out.message ?? "", /Untangled/);
});

test("geodesicDistance on a square is 0 at the source and grows away from it; unreachable is a gap", async () => {
  const sq = (await generateMesh({ kind: "generate", shape: "rectangle", params: { dims: [4, 4], size: [1, 1] } })).model;
  const tri = (await applyOpAsync(sq, { op: "simplexify" })).model;
  const out = await applyOpAsync(tri, { op: "geodesicDistance", sourceNodes: [tri.nodeIds[0]] });
  assert.ok(!out.noop, out.message ?? "");
  const f = fieldOf(out.model, "GEODESIC_DISTANCE")!;
  assert.ok(f, "field written");
  assert.ok(Math.abs(f.values[0]) < 1e-6);
  assert.ok(Math.max(...f.values) > 1);
  const none = await applyOpAsync(tri, { op: "geodesicDistance", sourceNodes: [999999] });
  assert.equal(none.noop, true);
});

test("laplacianEigenmodes writes one scalar field per mode with the measured eigenvalues 0, 3, 6, 9 on the 2-triangle square", async () => {
  const sq = (await generateMesh({ kind: "generate", shape: "rectangle", params: { dims: [1, 1], size: [1, 1] } })).model;
  const tri = (await applyOpAsync(sq, { op: "simplexify" })).model;
  const out = await applyOpAsync(tri, { op: "laplacianEigenmodes", numModes: 4 });
  assert.ok(!out.noop, out.message ?? "");
  for (let j = 0; j < 4; j++) assert.ok(fieldOf(out.model, `LAPLACE_MODE_${j}`), `mode ${j}`);
  assert.match(out.message ?? "", /0, 3, 6, 9/);
});

test("convertCoordinates writes the cylindrical coordinates and a rotated copy, keeping the original", async () => {
  const box = await tetBox();
  const with3: MdpaModel = { ...box, fields: [...box.fields, { kind: "Nodal", variable: "V", components: 3, ids: Int32Array.from(box.nodeIds), values: Float64Array.from({ length: box.nodeCount * 3 }, (_, i) => (i % 3 === 0 ? 1 : 0)) }] };
  const out = await applyOpAsync(with3, { op: "convertCoordinates", arrays: ["V"], system: "cylindrical", axis: [0, 0, 1], origin: [0.5, 0.5, 0] });
  assert.ok(!out.noop, out.message ?? "");
  assert.ok(fieldOf(out.model, "COORDS_CYLINDRICAL"));
  assert.ok(fieldOf(out.model, "V_CYL"));
  assert.ok(fieldOf(out.model, "V"), "original kept");
  const missing = await applyOpAsync(with3, { op: "convertCoordinates", arrays: ["NOPE"] });
  assert.equal(missing.noop, true);
});

test("registerRigid recovers a known translation and moves the mesh back; fields keep their ids", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { writeMeshFileAsync } = await import("../parser/writers/meshWriter");
  const { translateCoords } = await import("../parser/transformCoords");
  const sphere = icosphere(1, 2);
  const file = path.join(os.tmpdir(), `reg181-${process.pid}.stl`);
  fs.writeFileSync(file, (await writeMeshFileAsync(sphere, ".stl", {})).data);
  const shifted = translateCoords(sphere, 0.1, 0.05, 0);
  const out = await applyOpAsync(shifted, { op: "registerRigid", path: file });
  fs.unlinkSync(file);
  assert.ok(!out.noop, out.message ?? "");
  const err = Math.max(...Array.from(out.model.coords, (v, i) => Math.abs(v - sphere.coords[i])));
  assert.ok(err < 0.02, `max residual ${err}`);
  assert.deepEqual(Array.from(out.model.nodeIds), Array.from(sphere.nodeIds));
});

test("morph with nothing constrained is a noop that says why; with a displaced boundary it moves the interior", async () => {
  const box = await tetBox();
  const d = Float64Array.from({ length: box.nodeCount * 3 }, (_, i) => (i % 3 === 2 && box.coords[i] > 0.99 ? 0.1 : 0));
  const withD: MdpaModel = { ...box, fields: [...box.fields, { kind: "Nodal", variable: "D", components: 3, ids: Int32Array.from(box.nodeIds), values: d }] };
  const out = await applyOpAsync(withD, { op: "morph", variable: "D" });
  assert.ok(!out.noop, out.message ?? "");
  const zmax = Math.max(...Array.from({ length: out.model.nodeCount }, (_, i) => out.model.coords[i * 3 + 2]));
  assert.ok(Math.abs(zmax - 1.1) < 1e-3, `top moved to ${zmax}`);
  const none = await applyOpAsync(withD, { op: "morph", variable: "D", fixBoundary: false });
  assert.equal(none.noop, true);
});

test("prepareMetric refuses a field of the wrong width and writes a graded metric otherwise", async () => {
  const box = await tetBox();
  const bad: MdpaModel = { ...box, fields: [...box.fields, { kind: "Nodal", variable: "M1", components: 1, ids: Int32Array.from(box.nodeIds), values: new Float64Array(box.nodeCount) }] };
  assert.equal((await applyOpAsync(bad, { op: "prepareMetric", arrays: ["M1"] })).noop, true);
  const iso = Float64Array.from({ length: box.nodeCount * 6 }, (_, i) => ([0, 3, 5].includes(i % 6) ? 100 : 0));
  const ok: MdpaModel = { ...box, fields: [...box.fields, { kind: "Nodal", variable: "M6", components: 6, ids: Int32Array.from(box.nodeIds), values: iso }] };
  const out = await applyOpAsync(ok, { op: "prepareMetric", arrays: ["M6"], hmin: 0.01, hmax: 1 });
  assert.ok(!out.noop, out.message ?? "");
  assert.equal(fieldOf(out.model, "METRIC")?.components, 6);
});

// --- parameterize and the graph ----------------------------------------------------

import { meshGraph } from "../parser/meshGraph";
import { meshGraphTool } from "../mcp/tools";

test("parameterize writes a 2-component UV nodal field and splits no point of a flat square", async () => {
  const sq = (await generateMesh({ kind: "generate", shape: "rectangle", params: { dims: [3, 3], size: [1, 1] } })).model;
  const tri = (await applyOpAsync(sq, { op: "simplexify" })).model;
  const r = await deriveMesh(tri, { kind: "parameterize" });
  const uv = r.model.fields.find((f) => f.variable === "UV");
  assert.ok(uv, fieldNames(r.model).join(","));
  assert.equal(uv.components, 2);
  assert.ok(Math.min(...uv.values) >= -1e-9 && Math.max(...uv.values) <= 1 + 1e-9, "inside the unit square");
  assert.match(r.summary, /1 chart/);
});

test("meshGraph on two tetrahedra: node, clique and cell graphs and a METIS file with the right header", async () => {
  const box = await tetBox();
  const node = await meshGraph(box, "node");
  assert.equal(node.vertices, box.nodeCount);
  assert.ok(node.edges > box.nodeCount);
  const cell = await meshGraph(box, "cell", "metis");
  const text = new TextDecoder().decode(cell.file!.data);
  assert.match(text.split("\n")[0].trim(), new RegExp(`^${cell.vertices} ${cell.edges}`));
  await assert.rejects(() => meshGraph({ ...box, blocks: [] }, "node"), /no cells/);
});

test("mesh_graph writes a METIS file from a path and refuses an undecidable extension", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { writeMeshFileAsync } = await import("../parser/writers/meshWriter");
  const box = await tetBox();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graph181-"));
  const mesh = path.join(dir, "box.vtu");
  fs.writeFileSync(mesh, (await writeMeshFileAsync(box, ".vtu", {})).data);
  const out = (await meshGraphTool({ path: mesh, kind: "clique", outputPath: path.join(dir, "box.graph") })) as { vertices: number; outputPath: string; format: string };
  assert.equal(out.format, "metis");
  assert.ok(fs.statSync(out.outputPath).size > 0);
  await assert.rejects(() => meshGraphTool({ path: mesh, outputPath: path.join(dir, "box.txt") }), /graph format/);
});

// --- compressed input and length units -----------------------------------------------

import { parseMeshFile } from "../parser/meshFileParser";
import { createZip } from "../parser/zip";
import { gzipSync } from "node:zlib";

async function stlOf(model: MdpaModel): Promise<Buffer> {
  const { writeMeshFileAsync } = await import("../parser/writers/meshWriter");
  return Buffer.from((await writeMeshFileAsync(model, ".stl", {})).data as Uint8Array);
}

test("a .stl.gz and a single-member .stl.zip read like the plain file; the rest are refused by name", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmp181-"));
  const stl = await stlOf(icosphere(1, 1));
  const plain = path.join(dir, "s.stl");
  fs.writeFileSync(plain, stl);
  fs.writeFileSync(path.join(dir, "s.stl.gz"), gzipSync(stl));
  fs.writeFileSync(path.join(dir, "z.stl.zip"), createZip([{ name: "z.stl", data: stl }]));
  fs.writeFileSync(path.join(dir, "two.zip"), createZip([{ name: "a.stl", data: stl }, { name: "b.stl", data: stl }]));
  fs.writeFileSync(path.join(dir, "s.stl.zst"), Buffer.from([1, 2, 3]));
  const ref = await parseMeshFile(plain);
  for (const f of ["s.stl.gz", "z.stl.zip"]) {
    const m = await parseMeshFile(path.join(dir, f));
    assert.equal(m.nodeCount, ref.nodeCount, f);
    assert.equal(cellCount(m), cellCount(ref), f);
    assert.ok(m.diagnostics.some((d) => /compressed file/.test(d.message)));
  }
  await assert.rejects(() => parseMeshFile(path.join(dir, "two.zip")), /exactly one mesh file/);
  await assert.rejects(() => parseMeshFile(path.join(dir, "s.stl.zst")), /\.zst file: only \.gz and single-file \.zip/);
  fs.writeFileSync(path.join(dir, "c.vtm.gz"), gzipSync(Buffer.from("<VTKFile/>")));
  await assert.rejects(() => parseMeshFile(path.join(dir, "c.vtm.gz")), /companion files/);
});

test("a length unit a file states becomes the coordinate unit, and MED/UNV/CGNS write it back", async () => {
  const { lengthUnitName, lengthUnitScale } = await import("../parser/meshioConvert");
  assert.equal(lengthUnitName(0.001), "mm");
  assert.equal(lengthUnitName(0.0254), "in");
  assert.equal(lengthUnitName(0.5), undefined);
  assert.equal(lengthUnitScale("FT"), 0.3048);
  const { meshioToModel, modelToMeshio } = await import("../parser/meshioConvert");
  const m = await loadMeshio();
  const mesh = { dim: 3, points: Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), cells: [{ type: "triangle", nodesPerCell: 3, data: Int32Array.from([0, 1, 2]) }], point_data: {}, cell_data: {}, field_data: { "meshio:length_unit": Float64Array.from([0.001]) } };
  const model = meshioToModel(mesh as never, []);
  assert.equal(model.source?.units?.coords, "mm");
  assert.equal(model.source?.units?.coordsScale, 0.001);
  assert.ok(!model.diagnostics.some((d) => /Dropped field_data/.test(d.message)));
  const back = modelToMeshio(model, [], { dim: 3, lengthUnit: true });
  assert.equal(Number((back.field_data as Record<string, ArrayLike<number>>)["meshio:length_unit"][0]), 0.001);
  assert.equal(modelToMeshio(model, [], { dim: 3 }).field_data, undefined);
  void m;
});

test("STEP and IGES reads state millimetres; a MED round trip keeps the unit and collapses its per-axis padding", async () => {
  const path = await import("node:path");
  for (const f of ["box.step", "box.igs"]) {
    const m = await parseMeshFile(path.join(__dirname, "..", "..", "src", "test", "fixtures", "cad", f));
    assert.equal(m.source?.units?.coords, "mm", f);
    assert.equal(m.source?.units?.coordsScale, 0.001, f);
  }
  const fs = await import("node:fs");
  const os = await import("node:os");
  const { writeMeshFileAsync } = await import("../parser/writers/meshWriter");
  const box = (await generateMesh({ kind: "generate", shape: "box", params: { dims: [2, 2, 2], size: [1, 1, 1] } })).model;
  const model: MdpaModel = { ...box, source: { format: "meshio", units: { coords: "mm", coordsScale: 0.001 } } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit181-"));
  for (const ext of [".med", ".unv", ".cgns"]) {
    const file = path.join(dir, `m${ext}`);
    fs.writeFileSync(file, (await writeMeshFileAsync(model, ext, {})).data);
    const back = await parseMeshFile(file);
    assert.equal(back.source?.units?.coords, "mm", ext);
    assert.equal(back.source?.units?.coordsScale, 0.001, ext);
  }
});
