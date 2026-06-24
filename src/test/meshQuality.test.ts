import { test } from "node:test";
import assert from "node:assert";
import { computeMeshQuality, MetricResult, QualityReport } from "../parser/meshQuality";
import { MdpaModel } from "../parser/types";
import { VtkCellType } from "../parser/geometryMap";

// Build a minimal one-block model from flat node coords and a single element.
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
    nodeIds[i] = i + 1; // 1-based ids
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
    diagnostics: [],
    is3D: vtkCellType >= VtkCellType.TETRA,
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  };
}

function metric(report: QualityReport, key: string): MetricResult {
  const m = report.metrics.find((x) => x.key === key);
  assert.ok(m, `metric ${key} present`);
  return m!;
}

function close(actual: number, expected: number, tol = 1e-3): void {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `expected ${actual} to be within ${tol} of ${expected}`
  );
}

test("equilateral triangle: 60deg angles, edge ratio 1", () => {
  const r = computeMeshQuality(
    makeModel(
      [
        [0, 0, 0],
        [1, 0, 0],
        [0.5, Math.sqrt(3) / 2, 0],
      ],
      VtkCellType.TRIANGLE,
      "Element2D3N",
      [1, 2, 3]
    )
  );
  assert.equal(r.analyzedCount, 1);
  close(metric(r, "edgeRatio").min, 1);
  close(metric(r, "minAngle").min, 60);
  close(metric(r, "maxAngle").max, 60);
});

test("right-isosceles triangle: 90deg max, edge ratio sqrt(2)", () => {
  const r = computeMeshQuality(
    makeModel(
      [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
      VtkCellType.TRIANGLE,
      "Element2D3N",
      [1, 2, 3]
    )
  );
  close(metric(r, "maxAngle").max, 90);
  close(metric(r, "minAngle").min, 45);
  close(metric(r, "edgeRatio").max, Math.SQRT2);
});

test("regular tetrahedron: dihedral ~70.53deg, edge ratio 1", () => {
  const r = computeMeshQuality(
    makeModel(
      [
        [1, 1, 1],
        [1, -1, -1],
        [-1, 1, -1],
        [-1, -1, 1],
      ],
      VtkCellType.TETRA,
      "Element3D4N",
      [1, 2, 3, 4]
    )
  );
  const expected = Math.acos(1 / 3) * (180 / Math.PI); // 70.5288...
  close(metric(r, "edgeRatio").max, 1);
  close(metric(r, "minAngle").min, expected, 1e-2);
  close(metric(r, "maxAngle").max, expected, 1e-2);
});

test("stretched triangle: edge ratio unacceptable, mesh not OK", () => {
  const r = computeMeshQuality(
    makeModel(
      [
        [0, 0, 0],
        [100, 0, 0],
        [0, 1, 0],
      ],
      VtkCellType.TRIANGLE,
      "Element2D3N",
      [1, 2, 3]
    )
  );
  const er = metric(r, "edgeRatio");
  assert.ok(er.max > 50, "edge ratio exceeds 50");
  assert.equal(er.bands.unacceptable, 1);
  assert.equal(er.badEntityIds.length, 1);
  assert.equal(er.badEntityIds[0], 1);
  assert.equal(r.overallOk, false);
});
