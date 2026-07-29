import { test } from "node:test";
import assert from "node:assert";
import { thresholdCells } from "../parser/thresholdCells";
import { FieldData, MdpaModel } from "../parser/types";
import { VtkCellType } from "../parser/geometryMap";

// A 4-node chain (ids 1..4 at x=0,1,2,3) with 3 LINE elements (1-2, 2-3, 3-4,
// ids 10/20/30) and one matching Conditions block (id 40, covering nodes 1-2).
function makeChainModel(): MdpaModel {
  const nodeCount = 4;
  const coords = new Float32Array(nodeCount * 3);
  const nodeIds = new Int32Array([1, 2, 3, 4]);
  for (let i = 0; i < nodeCount; i++) coords[i * 3] = i;
  return {
    nodeCount,
    nodeIds,
    coords,
    blocks: [
      {
        kind: "Elements",
        name: "Line2D2",
        vtkCellType: VtkCellType.LINE,
        count: 3,
        stride: 2,
        entityIds: new Int32Array([10, 20, 30]),
        connectivity: new Int32Array([1, 2, 2, 3, 3, 4]),
      },
      {
        kind: "Conditions",
        name: "Line2D2",
        vtkCellType: VtkCellType.LINE,
        count: 1,
        stride: 2,
        entityIds: new Int32Array([40]),
        connectivity: new Int32Array([1, 2]),
      },
    ],
    subModelParts: [],
    meta: [],
    fields: [],
    diagnostics: [],
    bounds: { min: [0, 0, 0], max: [3, 0, 0] },
    is3D: false,
  };
}

function nodalField(values: number[]): FieldData {
  return {
    kind: "Nodal",
    variable: "TEMPERATURE",
    components: 1,
    ids: Int32Array.from([1, 2, 3, 4]),
    values: Float64Array.from(values),
  };
}

function elementalField(ids: number[], values: number[]): FieldData {
  return {
    kind: "Elemental",
    variable: "PRESSURE",
    components: 1,
    ids: Int32Array.from(ids),
    values: Float64Array.from(values),
  };
}

test("thresholdCells: nodal 'all' rule requires every node in range", () => {
  const model = makeChainModel();
  // node values: 1=0, 2=5, 3=5, 4=10 — only element 20 (nodes 2,3) has both in [4,6]
  const field = nodalField([0, 5, 5, 10]);
  const { elementIds, conditionIds } = thresholdCells(model, field, "mag", [4, 6], "all");
  assert.deepStrictEqual(elementIds, [20]);
  assert.deepStrictEqual(conditionIds, []); // condition 40 covers nodes 1(=0),2(=5) — 0 fails "all"
});

test("thresholdCells: nodal 'any' rule requires at least one node in range", () => {
  const model = makeChainModel();
  const field = nodalField([0, 5, 5, 10]);
  const { elementIds, conditionIds } = thresholdCells(model, field, "mag", [4, 6], "any");
  // element 10 (nodes 1,2 = 0,5): node 2 passes -> included
  // element 20 (nodes 2,3 = 5,5): both pass -> included
  // element 30 (nodes 3,4 = 5,10): node 3 passes -> included
  assert.deepStrictEqual(elementIds, [10, 20, 30]);
  assert.deepStrictEqual(conditionIds, [40]); // node 2 = 5 passes
});

test("thresholdCells: elemental field tests the cell's own value, rule is irrelevant", () => {
  const model = makeChainModel();
  const field = elementalField([10, 20, 30], [1, 5, 9]);
  const { elementIds } = thresholdCells(model, field, "mag", [4, 6]);
  assert.deepStrictEqual(elementIds, [20]);
});

test("thresholdCells: a cell missing a value never passes (sparse field)", () => {
  const model = makeChainModel();
  // Only element 20 has a value at all.
  const field = elementalField([20], [5]);
  const { elementIds } = thresholdCells(model, field, "mag", [0, 100]);
  assert.deepStrictEqual(elementIds, [20]);
});

test("thresholdCells: swapped range bounds are normalized", () => {
  const model = makeChainModel();
  const field = elementalField([10, 20, 30], [1, 5, 9]);
  const a = thresholdCells(model, field, "mag", [6, 4]);
  const b = thresholdCells(model, field, "mag", [4, 6]);
  assert.deepStrictEqual(a, b);
});

test("thresholdCells: vector component selection", () => {
  const model = makeChainModel();
  const field: FieldData = {
    kind: "Elemental",
    variable: "FORCE",
    components: 3,
    ids: Int32Array.from([10, 20, 30]),
    values: Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 5]),
  };
  // Component Z: [0, 0, 5] — only element 30 in [4,6]; magnitude would differ.
  const { elementIds } = thresholdCells(model, field, 2, [4, 6]);
  assert.deepStrictEqual(elementIds, [30]);
});
