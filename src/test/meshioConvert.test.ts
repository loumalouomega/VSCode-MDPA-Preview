import assert from "node:assert/strict";
import test from "node:test";

import {
  MeshioMesh,
  meshioToModel,
  modelToMeshio,
  sanitizeVariable,
} from "../parser/meshioConvert";
import { MESHIO_TO_VTK_ORDER } from "../parser/meshioFormats";
import { MdpaDiagnostic } from "../parser/types";

function diags(): MdpaDiagnostic[] {
  return [];
}

/** A unit tetra: 4 points, 1 tetra cell. */
function tetMesh(): MeshioMesh {
  return {
    points: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    dim: 3,
    cells: [{ type: "tetra", data: new Int32Array([0, 1, 2, 3]), nodesPerCell: 4 }],
  };
}

test("points: 0-based connectivity becomes 1-based, coords interleave", () => {
  const m = meshioToModel(tetMesh(), diags());
  assert.equal(m.nodeCount, 4);
  assert.deepEqual(Array.from(m.coords), [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.equal(m.blocks.length, 1);
  assert.equal(m.blocks[0].vtkCellType, 10);
  assert.equal(m.blocks[0].name, "tetra");
  // 0-based [0,1,2,3] -> 1-based [1,2,3,4]
  assert.deepEqual(Array.from(m.blocks[0].connectivity), [1, 2, 3, 4]);
});

test("dim=2 meshes pad z with 0 and stay 2D", () => {
  const m = meshioToModel(
    {
      points: new Float64Array([0, 0, 1, 0, 0, 1]),
      dim: 2,
      cells: [{ type: "triangle", data: new Int32Array([0, 1, 2]), nodesPerCell: 3 }],
    },
    diags()
  );
  assert.equal(m.nodeCount, 3);
  assert.deepEqual(Array.from(m.coords), [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  assert.equal(m.is3D, false);
});

test("wedge connectivity is permuted meshio -> VTK order", () => {
  // Distinct node ids so the permutation is observable.
  const mesh: MeshioMesh = {
    points: new Float64Array(6 * 3).fill(0),
    dim: 3,
    cells: [{ type: "wedge", data: new Int32Array([0, 1, 2, 3, 4, 5]), nodesPerCell: 6 }],
  };
  const m = meshioToModel(mesh, diags());
  // perm [0,2,1,3,5,4]: VTK position k takes meshio index perm[k]; +1 for 1-based.
  assert.deepEqual(Array.from(m.blocks[0].connectivity), [1, 3, 2, 4, 6, 5]);
});

test("wedge permutation round-trips back to meshio order", () => {
  const original = tetlessWedge();
  const model = meshioToModel(original, diags());
  const back = modelToMeshio(model, diags());
  assert.equal(back.cells.length, 1);
  assert.equal(back.cells[0].type, "wedge");
  assert.deepEqual(Array.from(back.cells[0].data), Array.from(original.cells[0].data));
});

function tetlessWedge(): MeshioMesh {
  return {
    points: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1]),
    dim: 3,
    cells: [{ type: "wedge", data: new Int32Array([0, 1, 2, 3, 4, 5]), nodesPerCell: 6 }],
  };
}

test("the wedge permutation is self-inverse", () => {
  const p = MESHIO_TO_VTK_ORDER.wedge;
  const twice = p.map((_, k) => p[p[k]]);
  assert.deepEqual(Array.from(twice), [0, 1, 2, 3, 4, 5]);
});

test("cell types with no VTK equivalent are skipped with a diagnostic", () => {
  const d = diags();
  const m = meshioToModel(
    {
      points: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      dim: 3,
      cells: [
        { type: "VTK_LAGRANGE_TETRAHEDRON", data: new Int32Array([0, 1, 2]), nodesPerCell: 3 },
      ],
    },
    d
  );
  assert.equal(m.blocks.length, 0);
  assert.match(d[0].message, /VTK_LAGRANGE_TETRAHEDRON/);
  assert.match(d[0].message, /skipped/);
});

test("cell_data stays aligned when a skipped block sits in the MIDDLE", () => {
  // Regression guard: cell_data arrays are indexed against the ORIGINAL
  // mesh.cells, not the surviving blocks. A skipped block between two kept
  // ones must not shift the values.
  const d = diags();
  const mesh: MeshioMesh = {
    points: new Float64Array(6 * 3).fill(0),
    dim: 3,
    cells: [
      { type: "triangle", data: new Int32Array([0, 1, 2]), nodesPerCell: 3 }, // kept
      { type: "polyhedron", data: new Int32Array([0, 1, 2, 3]), nodesPerCell: 4 }, // SKIPPED
      { type: "line", data: new Int32Array([3, 4]), nodesPerCell: 2 }, // kept
    ],
    cell_data: {
      mat: [
        new Float64Array([11]), // triangle
        new Float64Array([99]), // polyhedron — must NOT leak into the line block
        new Float64Array([33]), // line
      ],
    },
  };
  const m = meshioToModel(mesh, d);
  assert.equal(m.blocks.length, 2);
  const mat = m.fields.find((f) => f.variable === "mat");
  assert.ok(mat, "mat field survived");
  assert.equal(mat.kind, "Elemental");
  // triangle then line — 99 belongs to the dropped block and must be gone.
  assert.deepEqual(Array.from(mat.values), [11, 33]);
  assert.deepEqual(Array.from(mat.ids), [1, 2]);
});

test("point_data component count is inferred; ragged arrays are rejected", () => {
  const d = diags();
  const m = meshioToModel(
    {
      ...tetMesh(),
      point_data: {
        T: new Float64Array([1, 2, 3, 4]), // scalar
        V: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1]), // vector3
        BAD: new Float64Array([1, 2, 3]), // 3 values / 4 nodes -> reject
      },
    },
    d
  );
  const T = m.fields.find((f) => f.variable === "T");
  const V = m.fields.find((f) => f.variable === "V");
  assert.equal(T?.components, 1);
  assert.equal(V?.components, 3);
  assert.equal(m.fields.find((f) => f.variable === "BAD"), undefined);
  assert.ok(d.some((x) => /BAD/.test(x.message)));
});

test("gmsh's injected keys are sanitized into valid Kratos variable names", () => {
  const m = meshioToModel(
    {
      ...tetMesh(),
      point_data: { "gmsh:dim_tags": new Float64Array([3, 3, 3, 3]) },
      cell_data: { "gmsh:physical": [new Float64Array([7])] },
    },
    diags()
  );
  assert.ok(m.fields.some((f) => f.variable === "gmsh_dim_tags"));
  assert.ok(m.fields.some((f) => f.variable === "gmsh_physical"));
});

test("sanitizeVariable strips punctuation and leading digits", () => {
  assert.equal(sanitizeVariable("gmsh:physical"), "gmsh_physical");
  assert.equal(sanitizeVariable("a-b c"), "a_b_c");
  assert.equal(sanitizeVariable("2fast"), "_2fast");
  assert.equal(sanitizeVariable("OK_1"), "OK_1");
});

test("a fixed-width polygon block is fanned into triangles and cell_data follows", () => {
  const d = diags();
  const m = meshioToModel(
    {
      points: new Float64Array(5 * 3).fill(0),
      dim: 3,
      // one pentagon -> 3 triangles via buildBlocksFromOffsets' fan
      cells: [{ type: "polygon", data: new Int32Array([0, 1, 2, 3, 4]), nodesPerCell: 5 }],
      cell_data: { mat: [new Float64Array([42])] },
    },
    d
  );
  assert.equal(m.blocks.length, 1);
  assert.equal(m.blocks[0].vtkCellType, 5); // TRIANGLE
  assert.equal(m.blocks[0].count, 3);
  const mat = m.fields.find((f) => f.variable === "mat");
  // expandCellField replicates the pentagon's value across its 3 triangles.
  assert.deepEqual(Array.from(mat!.values), [42, 42, 42]);
  assert.deepEqual(Array.from(mat!.ids), [1, 2, 3]);
});

test("field_data is dropped with a diagnostic", () => {
  const d = diags();
  meshioToModel({ ...tetMesh(), field_data: { blah: new Float64Array([1]) } }, d);
  assert.ok(d.some((x) => /field_data/.test(x.message) && /blah/.test(x.message)));
});

test("meshioToModel -> modelToMeshio round-trips geometry and data", () => {
  const src: MeshioMesh = {
    ...tetMesh(),
    point_data: { T: new Float64Array([1, 2, 3, 4]) },
    cell_data: { mat: [new Float64Array([7])] },
  };
  const model = meshioToModel(src, diags());
  const back = modelToMeshio(model, diags());

  assert.equal(back.dim, 3);
  assert.deepEqual(Array.from(back.points), Array.from(src.points));
  assert.equal(back.cells.length, 1);
  assert.equal(back.cells[0].type, "tetra");
  assert.deepEqual(Array.from(back.cells[0].data), [0, 1, 2, 3]);
  assert.deepEqual(Array.from(back.point_data!.T), [1, 2, 3, 4]);
  assert.deepEqual(Array.from(back.cell_data!.mat[0]), [7]);
});

test("modelToMeshio emits 2D points for a planar model", () => {
  const model = meshioToModel(
    {
      points: new Float64Array([0, 0, 1, 0, 0, 1]),
      dim: 2,
      cells: [{ type: "triangle", data: new Int32Array([0, 1, 2]), nodesPerCell: 3 }],
    },
    diags()
  );
  const back = modelToMeshio(model, diags());
  assert.equal(back.dim, 2);
  assert.deepEqual(Array.from(back.points), [0, 0, 1, 0, 0, 1]);
});
