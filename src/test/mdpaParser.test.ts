import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseMdpa } from "../parser/mdpaParser";
import { EntityBlock, SubModelPart } from "../parser/types";
import { VtkCellType } from "../parser/geometryMap";

const REPO_ROOT = path.resolve(__dirname, "../../../../../");

function fixture(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

function findBlock(blocks: EntityBlock[], name: string): EntityBlock | undefined {
  return blocks.find((b) => b.name === name);
}

function findPart(parts: SubModelPart[], name: string): SubModelPart | undefined {
  for (const p of parts) {
    if (p.name === name) return p;
    const child = findPart(p.children, name);
    if (child) return child;
  }
  return undefined;
}

// Helpers to read one entity's connectivity from a block
function entityNodeIds(block: EntityBlock, entityIndex: number): number[] {
  const start = entityIndex * block.stride;
  return Array.from(block.connectivity.subarray(start, start + block.stride));
}

const READ_FIXTURE =
  "kratos/tests/auxiliar_files_for_python_unittest/mdpa_files/test_model_part_io_read.mdpa";

test("parses nodes, elements, conditions and geometries", () => {
  const model = parseMdpa(fixture(READ_FIXTURE));

  assert.equal(model.nodeCount, 6);

  const elements = findBlock(model.blocks, "Element2D3N");
  assert.ok(elements, "Element2D3N block present");
  assert.equal(elements!.count, 4);
  assert.equal(elements!.vtkCellType, VtkCellType.TRIANGLE);
  assert.deepEqual(entityNodeIds(elements!, 0), [1, 2, 3]);
  assert.equal(elements!.propertyIds![0], 1);

  const conditions = findBlock(model.blocks, "LineCondition2D2N");
  assert.ok(conditions);
  assert.equal(conditions!.count, 5);
  assert.equal(conditions!.vtkCellType, VtkCellType.LINE);

  const tris = findBlock(model.blocks, "Triangle2D3");
  const lines = findBlock(model.blocks, "Line2D2");
  assert.equal(tris!.count, 4);
  assert.equal(lines!.count, 5);
  assert.equal(tris!.propertyIds, undefined); // Geometries carry no propertyIds
  assert.deepEqual(entityNodeIds(tris!, 0), [1, 2, 3]);
});

test("builds the nested SubModelPart tree", () => {
  const model = parseMdpa(fixture(READ_FIXTURE));

  const inlets = findPart(model.subModelParts, "Inlets");
  assert.ok(inlets, "Inlets present at root");
  assert.equal(inlets!.path, "Inlets");
  assert.deepEqual(Array.from(inlets!.nodeIds), [1, 2]);
  assert.deepEqual(Array.from(inlets!.elementIds), [1]);
  assert.deepEqual(Array.from(inlets!.conditionIds), [1, 1800]);
  assert.equal(inlets!.children.length, 2);

  const inlet1 = inlets!.children.find((c) => c.name === "Inlet1");
  assert.ok(inlet1);
  assert.equal(inlet1!.path, "Inlets/Inlet1");
  assert.deepEqual(Array.from(inlet1!.nodeIds), [1, 3]);

  const inlet2 = inlets!.children.find((c) => c.name === "Inlet2");
  assert.ok(inlet2);
  assert.deepEqual(Array.from(inlet2!.conditionIds), [1800, 1801]);

  const outlet = findPart(model.subModelParts, "Outlet");
  assert.ok(outlet, "Outlet present at root");
  assert.deepEqual(Array.from(outlet!.conditionIds), [1948]);
});

test("detects 2D model and computes bounds", () => {
  const model = parseMdpa(fixture(READ_FIXTURE));
  assert.equal(model.is3D, false);
  assert.equal(model.bounds.min[2], 0);
  assert.equal(model.bounds.max[2], 0);
  assert.ok(model.bounds.max[0] >= model.bounds.min[0]);
});

test("produces no fatal diagnostics on the reference file", () => {
  const model = parseMdpa(fixture(READ_FIXTURE));
  const unclosed = model.diagnostics.filter((d) => /not closed|Stray|outside any/.test(d.message));
  assert.deepEqual(unclosed, []);
});

test("parses additional real fixtures without unbalanced blocks", () => {
  const files = [
    "applications/MetisApplication/tests/quads.mdpa",
    "applications/OptimizationApplication/tests/mdpas/shell.mdpa",
    "applications/MeshingApplication/tests/cube_with_5_faces.mdpa",
  ];
  for (const f of files) {
    const model = parseMdpa(fixture(f));
    assert.ok(model.nodeCount > 0, `${f}: has nodes`);
    assert.ok(model.blocks.length > 0, `${f}: has entity blocks`);
    const unbalanced = model.diagnostics.filter((d) => /not closed|Stray/.test(d.message));
    assert.deepEqual(unbalanced, [], `${f}: balanced Begin/End`);
  }
});

test("handles flag-form NodalData and irregular whitespace", () => {
  const text = [
    "Begin Nodes",
    "\t1\t  0.0   0.0\t0.0",
    "  2 1.0 0.0 0.0",
    "End Nodes",
    "Begin NodalData BOUNDARY",
    "1",
    "2",
    "End NodalData",
    "Begin NodalData DISPLACEMENT_X",
    "1 1 0.5",
    "End NodalData",
  ].join("\n");
  const model = parseMdpa(text);
  assert.equal(model.nodeCount, 2);
  assert.equal(model.nodeIds[0], 1);
  const boundary = model.meta.find((m) => m.label.includes("BOUNDARY"));
  assert.ok(boundary);
  assert.equal(boundary!.lineCount, 2);
});

test("parses node-only SubModelPart (boundary-condition pattern)", () => {
  const text = [
    "Begin Nodes",
    "1 0.0 0.0 0.0",
    "2 1.0 0.0 0.0",
    "3 1.0 1.0 0.0",
    "4 0.0 1.0 0.0",
    "End Nodes",
    "Begin Elements Element2D3N",
    "1 1 1 2 3",
    "2 1 1 3 4",
    "End Elements",
    "Begin SubModelPart Wall",
    "  Begin SubModelPartNodes",
    "  2",
    "  3",
    "  End SubModelPartNodes",
    "End SubModelPart",
  ].join("\n");

  const model = parseMdpa(text);
  assert.equal(model.nodeCount, 4);
  assert.equal(model.blocks.length, 1);
  assert.equal(model.blocks[0].count, 2);

  const wall = model.subModelParts[0];
  assert.ok(wall, "Wall SubModelPart exists");
  assert.deepEqual(Array.from(wall.nodeIds), [2, 3]);
  assert.equal(wall.elementIds.length, 0, "parser stores no explicit elements");

  const nodeSet = new Set(Array.from(wall.nodeIds));
  const block = model.blocks[0];
  let inducedCount = 0;
  for (let i = 0; i < block.count; i++) {
    const nids = entityNodeIds(block, i);
    if (nids.every((nid) => nodeSet.has(nid))) {
      inducedCount++;
    }
  }
  assert.equal(inducedCount, 0, "no element is fully within the 2-node wall set");
});

test("performance: parses the large cube fixture quickly", () => {
  const text = fixture("applications/MetisApplication/tests/cube.mdpa");
  const start = Date.now();
  const model = parseMdpa(text);
  const elapsed = Date.now() - start;
  const totalEntities = model.blocks.reduce((s, b) => s + b.count, 0);
  assert.ok(model.nodeCount > 100, "node count");
  assert.ok(totalEntities > 1000, "large entity count");
  assert.ok(elapsed < 2000, `parsed in ${elapsed}ms`);
});
