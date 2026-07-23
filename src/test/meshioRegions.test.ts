import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { MeshioCellBlock, MeshioMesh, meshioToModel } from "../parser/meshioConvert";
import { MeshioRegion, regionsToParts } from "../parser/meshioRegions";
import { readMeshioModel } from "../parser/meshio";
import { MdpaDiagnostic, MdpaModel, SubModelPart } from "../parser/types";

const FIXTURE_DIR = path.resolve(__dirname, "../../src/test/fixtures/regions");

function readFixture(name: string, ext: string): Promise<MdpaModel> {
  const data = fs.readFileSync(path.join(FIXTURE_DIR, name));
  return readMeshioModel(name, [{ name, data }], ext);
}

function part(model: MdpaModel, name: string): SubModelPart {
  const p = model.subModelParts.find((s) => s.path === name);
  assert.ok(p, `SubModelPart "${name}" exists (have: ${model.subModelParts.map((s) => s.path)})`);
  return p;
}

function block(type: string, conn: number[], nodesPerCell: number): MeshioCellBlock {
  return { type, data: Int32Array.from(conn), nodesPerCell };
}

// ---------------------------------------------------------------------------
// The pure mapping (no wasm)
// ---------------------------------------------------------------------------

test("point regions become SubModelPart nodeIds (0-based -> 1-based)", () => {
  const diagnostics: MdpaDiagnostic[] = [];
  const { subModelParts } = regionsToParts({
    regions: [{ name: "fixed", kind: "point", dim: -1, tag: 7, entries: Int32Array.from([0, 2]) }],
    cells: [block("triangle", [0, 1, 2], 3)],
    kept: [0],
    expansion: [1],
    nodeCount: 3,
    diagnostics,
  });
  assert.equal(subModelParts.length, 1);
  assert.deepEqual(Array.from(subModelParts[0].nodeIds), [1, 3]);
  assert.equal(diagnostics.length, 0);
});

test("cell regions index GLOBAL block-major cells, across several blocks", () => {
  // Block 0: 2 triangles (global 0,1). Block 1: 1 quad (global 2).
  const { subModelParts } = regionsToParts({
    regions: [
      { name: "g", kind: "cell", dim: 2, tag: 1, entries: Int32Array.from([1, 2]) },
    ],
    cells: [block("triangle", [0, 1, 2, 1, 2, 3], 3), block("quad", [0, 1, 2, 3], 4)],
    kept: [0, 1],
    expansion: [1, 1, 1],
    nodeCount: 4,
    diagnostics: [],
  });
  // Entity ids are assigned in cell order: tri0=1, tri1=2, quad=3.
  assert.deepEqual(Array.from(subModelParts[0].elementIds), [2, 3]);
});

test("a dropped block still consumes global cell indices", () => {
  // Block 0 is a type with no VTK equivalent, so meshioToModel skips it — but
  // the region's cell indices are numbered over the ORIGINAL blocks, so cell 2
  // is the first cell of block 1, not of block 0.
  const diagnostics: MdpaDiagnostic[] = [];
  const { subModelParts } = regionsToParts({
    regions: [{ name: "g", kind: "cell", dim: 3, tag: -1, entries: Int32Array.from([0, 2]) }],
    cells: [block("polyhedron", [0, 1, 2, 3, 4, 5], 3), block("triangle", [0, 1, 2, 1, 2, 3], 3)],
    kept: [1], // block 0 was skipped
    expansion: [1, 1],
    nodeCount: 4,
    diagnostics,
  });
  // Global 0 lived in the dropped block; global 2 is block 1's first triangle.
  assert.deepEqual(Array.from(subModelParts[0].elementIds), [1]);
  assert.match(diagnostics[0].message, /cannot draw/);
});

test("a fanned-out cell contributes every entity it became", () => {
  // A 5-gon becomes a 3-triangle fan: expansion[0] = 3.
  const { subModelParts } = regionsToParts({
    regions: [{ name: "g", kind: "cell", dim: 2, tag: -1, entries: Int32Array.from([0]) }],
    cells: [block("polygon", [0, 1, 2, 3, 4], 5)],
    kept: [0],
    expansion: [3],
    nodeCount: 5,
    diagnostics: [],
  });
  assert.deepEqual(Array.from(subModelParts[0].elementIds), [1, 2, 3]);
});

test("regions sharing a name merge into one part (Abaqus NSET + ELSET)", () => {
  const { subModelParts } = regionsToParts({
    regions: [
      { name: "load", kind: "point", dim: -1, tag: -1, entries: Int32Array.from([0, 1]) },
      { name: "load", kind: "cell", dim: -1, tag: -1, entries: Int32Array.from([0]) },
    ],
    cells: [block("triangle", [0, 1, 2], 3)],
    kept: [0],
    expansion: [1],
    nodeCount: 3,
    diagnostics: [],
  });
  assert.equal(subModelParts.length, 1, "one part, not two");
  assert.deepEqual(Array.from(subModelParts[0].nodeIds), [1, 2]);
  assert.deepEqual(Array.from(subModelParts[0].elementIds), [1]);
});

test("side regions materialize facets as Conditions blocks", () => {
  // One tetra; facet 3 is the base (0,2,1) per meshio++'s cell_faces table.
  const { subModelParts, conditionBlocks } = regionsToParts({
    regions: [
      { name: "wall", kind: "side", dim: 2, tag: 4, entries: Int32Array.from([0, 3]) },
    ],
    cells: [block("tetra", [0, 1, 2, 3], 4)],
    kept: [0],
    expansion: [1],
    nodeCount: 4,
    diagnostics: [],
  });
  assert.equal(conditionBlocks.length, 1);
  const cb = conditionBlocks[0];
  assert.equal(cb.kind, "Conditions");
  assert.equal(cb.name, "wall");
  assert.equal(cb.vtkCellType, 5, "triangle");
  assert.deepEqual(Array.from(cb.connectivity), [1, 3, 2], "base face (0,2,1), 1-based");
  assert.deepEqual(Array.from(subModelParts[0].conditionIds), [1]);
});

test("a side region spanning two facet types splits into two named blocks", () => {
  // Wedge facet 0 is a triangle, facet 2 a quad.
  const { conditionBlocks } = regionsToParts({
    regions: [
      { name: "skin", kind: "side", dim: 2, tag: -1, entries: Int32Array.from([0, 0, 0, 2]) },
    ],
    cells: [block("wedge", [0, 1, 2, 3, 4, 5], 6)],
    kept: [0],
    expansion: [1],
    nodeCount: 6,
    diagnostics: [],
  });
  assert.deepEqual(
    conditionBlocks.map((b) => b.name).sort(),
    ["skin:quad", "skin:triangle"]
  );
  // Condition ids are unique across the whole set of materialized facets.
  const ids = conditionBlocks.flatMap((b) => Array.from(b.entityIds));
  assert.equal(new Set(ids).size, ids.length);
});

test("an out-of-range facet index is reported, not silently dropped", () => {
  const diagnostics: MdpaDiagnostic[] = [];
  const { conditionBlocks } = regionsToParts({
    regions: [
      { name: "bad", kind: "side", dim: 2, tag: -1, entries: Int32Array.from([0, 9]) },
    ],
    cells: [block("tetra", [0, 1, 2, 3], 4)],
    kept: [0],
    expansion: [1],
    nodeCount: 4,
    diagnostics,
  });
  assert.equal(conditionBlocks.length, 0);
  assert.match(diagnostics[0].message, /facet table/);
});

test("same name in two dimensions is one group (gmsh allows the collision)", () => {
  // A gmsh physical name may be declared per dimension. They are the same
  // named group to a user, and one addressable path, so they merge.
  const { subModelParts } = regionsToParts({
    regions: [
      { name: "g", kind: "point", dim: 1, tag: 1, entries: Int32Array.from([0]) },
      { name: "g", kind: "point", dim: 2, tag: 2, entries: Int32Array.from([1]) },
    ],
    cells: [block("triangle", [0, 1, 2], 3)],
    kept: [0],
    expansion: [1],
    nodeCount: 3,
    diagnostics: [],
  });
  assert.deepEqual(subModelParts.map((p) => p.path), ["g"]);
  assert.deepEqual(Array.from(subModelParts[0].nodeIds), [1, 2]);
});

test("no regions is a no-op (every format that carries none is unaffected)", () => {
  const mesh: MeshioMesh = {
    points: Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    dim: 3,
    cells: [block("triangle", [0, 1, 2], 3)],
  };
  const model = meshioToModel(mesh, []);
  assert.deepEqual(model.subModelParts, []);
  assert.equal(model.blocks.length, 1);
});

// ---------------------------------------------------------------------------
// End-to-end through the real wasm reader
// ---------------------------------------------------------------------------

test("gmsh physical groups arrive as SubModelParts with their cells", async () => {
  const model = await readFixture("insulated-2.2.msh", ".msh");
  // $PhysicalNames: convection (1D, 21 lines), insulation + wire (2D).
  assert.deepEqual(
    model.subModelParts.map((p) => p.path).sort(),
    ["convection", "insulation", "wire"]
  );
  assert.equal(part(model, "convection").elementIds.length, 21);
  assert.equal(part(model, "insulation").elementIds.length, 66);
  assert.equal(part(model, "wire").elementIds.length, 45);
  // The groups partition the 111 triangles exactly.
  assert.equal(66 + 45, model.blocks.find((b) => b.name === "triangle")?.count);
});

test("Abaqus *ELSET arrives as SubModelParts", async () => {
  const model = await readFixture("element_elset.inp", ".inp");
  assert.deepEqual(model.subModelParts.map((p) => p.path).sort(), ["all", "left", "right"]);
  assert.equal(part(model, "all").elementIds.length, 2);
  assert.equal(part(model, "left").elementIds.length, 1);
});

test("Abaqus *NSET/*ELSET/*SURFACE all survive, surfaces as Conditions", async () => {
  const model = await readFixture("UUea.inp", ".inp");

  // *NSET and *ELSET under one name merge into a single part carrying both.
  const set14 = part(model, "_PickedSet14");
  assert.ok(set14.nodeIds.length > 0 && set14.elementIds.length > 0);

  // *SURFACE became real Conditions blocks (the mesh is 2D, so facets = edges).
  const conditions = model.blocks.filter((b) => b.kind === "Conditions");
  assert.deepEqual(
    conditions.map((b) => b.name).sort(),
    ["_PickedSurf12", "_PickedSurf13", "_PickedSurf18"]
  );
  const surf13 = part(model, "_PickedSurf13");
  assert.equal(surf13.conditionIds.length, 10);

  // Every materialized facet references real nodes and real condition ids.
  const conditionIds = new Set(conditions.flatMap((b) => Array.from(b.entityIds)));
  for (const b of conditions) {
    for (const n of b.connectivity) {
      assert.ok(n >= 1 && n <= model.nodeCount, `node id ${n} in range`);
    }
  }
  for (const p of model.subModelParts) {
    for (const id of p.conditionIds) {
      assert.ok(conditionIds.has(id), `condition ${id} exists`);
    }
  }
});

test("materialized facets lie on the boundary of their owning elements", async () => {
  const model = await readFixture("UUea.inp", ".inp");
  const quads = model.blocks.find((b) => b.name === "quad");
  assert.ok(quads);
  // Every edge of the mesh, as an unordered node-pair key.
  const edgeUse = new Map<string, number>();
  for (let c = 0; c < quads.count; c++) {
    const row = Array.from(quads.connectivity.subarray(c * 4, c * 4 + 4));
    for (let k = 0; k < 4; k++) {
      const a = row[k];
      const b = row[(k + 1) % 4];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    }
  }
  for (const cb of model.blocks.filter((b) => b.kind === "Conditions")) {
    for (let c = 0; c < cb.count; c++) {
      const [a, b] = Array.from(cb.connectivity.subarray(c * cb.stride, c * cb.stride + 2));
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      assert.equal(edgeUse.get(key), 1, `facet ${a}-${b} is a boundary edge of exactly one quad`);
    }
  }
});

test("an Abaqus file with sets exports to .mdpa with its groups intact", async () => {
  // The whole point of the feature: a set-carrying foreign mesh becomes a
  // well-formed Kratos model part, surfaces included as real Conditions.
  const { writeMeshFile } = await import("../parser/writers/meshWriter");
  const { parseMdpa } = await import("../parser/mdpaParser");

  const model = await readFixture("UUea.inp", ".inp");
  const back = parseMdpa(writeMeshFile(model, ".mdpa", {}));

  assert.deepEqual(back.diagnostics, [], "the written .mdpa parses cleanly");
  assert.deepEqual(
    back.subModelParts.map((p) => p.path).sort(),
    model.subModelParts.map((p) => p.path).sort()
  );
  assert.deepEqual(
    back.blocks.filter((b) => b.kind === "Conditions").map((b) => b.name).sort(),
    ["_PickedSurf12", "_PickedSurf13", "_PickedSurf18"]
  );
  const surf13 = back.subModelParts.find((p) => p.path === "_PickedSurf13");
  assert.equal(surf13?.conditionIds.length, 10);
});
