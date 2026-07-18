import { test } from "node:test";
import assert from "node:assert";
import { boxStats, computeMeshSize, attachMeshSizeToModel, writeMeshSizeFields } from "../parser/meshSize";
import { applyOp } from "../parser/operations";
import { FieldData, MdpaModel } from "../parser/types";
import { VtkCellType } from "../parser/geometryMap";

// Single-element model from flat node coords (mirrors meshQuality.test.ts).
function makeModel(
  nodes: number[][],
  vtkCellType: number,
  name: string,
  connectivity: number[]
): MdpaModel {
  const nodeCount = nodes.length;
  const coords = new Float32Array(nodeCount * 3);
  const nodeIds = new Int32Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    nodeIds[i] = i + 1;
    coords[i * 3] = nodes[i][0];
    coords[i * 3 + 1] = nodes[i][1];
    coords[i * 3 + 2] = nodes[i][2] ?? 0;
  }
  return {
    nodeCount,
    nodeIds,
    coords,
    blocks: [
      {
        kind: "Elements",
        name,
        vtkCellType,
        count: 1,
        stride: connectivity.length,
        entityIds: new Int32Array([1]),
        propertyIds: new Int32Array([0]),
        connectivity: new Int32Array(connectivity),
      },
    ],
    subModelParts: [],
    meta: [],
    fields: [],
    diagnostics: [],
    is3D: vtkCellType >= VtkCellType.TETRA,
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  };
}

// Many disjoint LINE elements with the given lengths (one line per length,
// each on its own two nodes). Element ids are 1..n in order.
function makeLines(lengths: number[]): MdpaModel {
  const nodes: number[][] = [];
  const connectivity: number[] = [];
  const entityIds: number[] = [];
  for (let i = 0; i < lengths.length; i++) {
    const a = nodes.length + 1;
    nodes.push([i * 1000, 0, 0]);
    const b = nodes.length + 1;
    nodes.push([i * 1000 + lengths[i], 0, 0]);
    connectivity.push(a, b);
    entityIds.push(i + 1);
  }
  const nodeCount = nodes.length;
  const coords = new Float32Array(nodeCount * 3);
  const nodeIds = new Int32Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    nodeIds[i] = i + 1;
    coords[i * 3] = nodes[i][0];
    coords[i * 3 + 1] = nodes[i][1];
    coords[i * 3 + 2] = nodes[i][2];
  }
  return {
    nodeCount,
    nodeIds,
    coords,
    blocks: [
      {
        kind: "Elements",
        name: "Line",
        vtkCellType: VtkCellType.LINE,
        count: lengths.length,
        stride: 2,
        entityIds: new Int32Array(entityIds),
        propertyIds: new Int32Array(entityIds.map(() => 0)),
        connectivity: new Int32Array(connectivity),
      },
    ],
    subModelParts: [],
    meta: [],
    fields: [],
    diagnostics: [],
    is3D: false,
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  };
}

function close(actual: number, expected: number, tol = 1e-3): void {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `expected ${actual} to be within ${tol} of ${expected}`
  );
}

function valueForId(field: FieldData, id: number): number | undefined {
  for (let i = 0; i < field.ids.length; i++) if (field.ids[i] === id) return field.values[i];
  return undefined;
}

test("right-isosceles triangle: NODAL_H and element size", () => {
  const m = makeModel([[0, 0], [1, 0], [0, 1]], VtkCellType.TRIANGLE, "Triangle2D3", [1, 2, 3]);
  const r = computeMeshSize(m);

  // Every node's min incident pair distance is 1 (the two unit legs).
  close(valueForId(r.nodalH, 1)!, 1);
  close(valueForId(r.nodalH, 2)!, 1);
  close(valueForId(r.nodalH, 3)!, 1);

  // Element size = mean edge length = (1 + 1 + sqrt(2)) / 3.
  close(valueForId(r.elementSize, 1)!, (2 + Math.SQRT2) / 3);
  close(r.elementStats.min, (2 + Math.SQRT2) / 3);
  assert.equal(r.analyzedCount, 1);
  assert.deepEqual(r.elementTypes, ["Triangle2D3"]);
});

test("regular tetrahedron: NODAL_H equals the edge length", () => {
  // Regular tetra with unit edge length.
  const a = 1;
  const h = Math.sqrt(2 / 3) * a;
  const nodes = [
    [0, 0, 0],
    [a, 0, 0],
    [a / 2, (Math.sqrt(3) / 2) * a, 0],
    [a / 2, (Math.sqrt(3) / 6) * a, h],
  ];
  const m = makeModel(nodes, VtkCellType.TETRA, "Tetra3D4", [1, 2, 3, 4]);
  const r = computeMeshSize(m);
  for (const id of [1, 2, 3, 4]) close(valueForId(r.nodalH, id)!, 1, 1e-4);
  close(valueForId(r.elementSize, 1)!, 1, 1e-4); // all 6 edges = 1
});

test("boxStats matches hand-computed quartiles", () => {
  const s = boxStats([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(s.count, 9);
  close(s.min, 1);
  close(s.q1, 3);
  close(s.median, 5);
  close(s.q3, 7);
  close(s.max, 9);
  close(s.mean, 5);
  close(s.std, Math.sqrt(60 / 9)); // population std of 1..9 = sqrt(mean((x-5)^2))
  close(s.iqr, 4);
  close(s.whiskerLo, 1); // max(min, q1 - 1.5*iqr) = max(1, -3)
  close(s.whiskerHi, 9); // min(max, q3 + 1.5*iqr) = min(9, 13)
});

test("empty boxStats is all-NaN with zero count", () => {
  const s = boxStats([]);
  assert.equal(s.count, 0);
  assert.ok(Number.isNaN(s.median));
  assert.ok(Number.isNaN(s.std));
});

test("IQR outliers: tiny and huge elements are flagged small/big", () => {
  // Ten lines of size 5, one tiny (0.5), one huge (50). The equal middle
  // collapses the IQR to 0, so the fences sit at 5: 0.5 < 5 (small), 50 > 5
  // (big), the fives sit exactly on the fence (neither).
  const lengths = [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 0.5, 50];
  const r = computeMeshSize(makeLines(lengths));
  assert.deepEqual(r.smallElementIds, [11]); // the 0.5 line (11th element)
  assert.deepEqual(r.bigElementIds, [12]); // the 50 line (12th element)
  assert.equal(r.analyzedCount, 12);
});

test("attachMeshSizeToModel populates the derived slot without touching fields", () => {
  const m = makeModel([[0, 0], [1, 0], [0, 1]], VtkCellType.TRIANGLE, "Triangle2D3", [1, 2, 3]);
  const r = computeMeshSize(m);
  attachMeshSizeToModel(m, r);
  assert.ok(m.derived?.nodalH);
  assert.ok(m.derived?.elementSize);
  assert.equal(m.derived!.nodalH!.variable, "NODAL_H");
  assert.equal(m.derived!.elementSize!.variable, "ELEMENT_H");
  assert.equal(m.fields.length, 0); // never serializes
});

test("writeMeshSizeFields appends fields (pure) and dedups on re-run", () => {
  const m = makeModel([[0, 0], [1, 0], [0, 1]], VtkCellType.TRIANGLE, "Triangle2D3", [1, 2, 3]);
  const r1 = writeMeshSizeFields(m, "both");
  assert.equal(r1.added, 2);
  assert.equal(m.fields.length, 0); // input untouched
  const vars = r1.model.fields.map((f) => f.variable).sort();
  assert.deepEqual(vars, ["ELEMENT_H", "NODAL_H"]);
  // Re-running replaces rather than duplicates.
  const r2 = writeMeshSizeFields(r1.model, "both");
  assert.equal(r2.model.fields.filter((f) => f.variable === "NODAL_H").length, 1);
});

test("writeMeshSizeFields op dispatches through applyOp", () => {
  const m = makeModel([[0, 0], [1, 0], [0, 1]], VtkCellType.TRIANGLE, "Triangle2D3", [1, 2, 3]);
  const out = applyOp(m, { op: "writeMeshSizeFields", target: "nodal" });
  assert.ok(!out.noop);
  assert.ok(out.model.fields.some((f) => f.variable === "NODAL_H"));
  assert.ok(!out.model.fields.some((f) => f.variable === "ELEMENT_H"));
});
