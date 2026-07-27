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

test("a ragged polygon block (meshio++ >= 8.7.0) is skipped with an accurate count, not silently dropped", () => {
  // Regression guard: a ragged block has no `nodesPerCell`, so treating it as
  // rectangular would compute nCells=0 (stride undefined > 0 is false) and
  // drop it with NO diagnostic at all — worse than the pre-8.7.0 behaviour,
  // where the WASM boundary rejected ragged blocks outright with a JS error.
  const d = diags();
  const m = meshioToModel(
    {
      points: new Float64Array(6 * 3).fill(0),
      dim: 3,
      cells: [
        {
          type: "polygon",
          data: new Int32Array([0, 1, 2, 0, 1, 2, 3]), // a triangle row + a quad row
          rowOffsets: new Int32Array([0, 3, 7]),
        },
      ],
    },
    d
  );
  assert.equal(m.blocks.length, 0);
  assert.equal(d.length, 1);
  assert.match(d[0].message, /Ragged "polygon"/);
  assert.match(d[0].message, /2 cell\(s\)/); // rowOffsets implies 2 rows, not 0
});

test("a ragged polyhedron block is skipped with an accurate count", () => {
  const d = diags();
  const m = meshioToModel(
    {
      points: new Float64Array(8 * 3).fill(0),
      dim: 3,
      cells: [
        {
          type: "polyhedron",
          data: new Int32Array([0, 1, 2, 3]),
          faceOffsets: new Int32Array([0, 4]),
          cellOffsets: new Int32Array([0, 1]),
        },
      ],
    },
    d
  );
  assert.equal(m.blocks.length, 0);
  assert.match(d[0].message, /Ragged "polyhedron"/);
  assert.match(d[0].message, /1 cell\(s\)/);
});

test("cell_data stays aligned when a RAGGED block sits in the middle", () => {
  // Same regression as the pre-existing "skipped block in the MIDDLE" test,
  // but for the new CSR-shaped ragged block rather than a rectangular
  // unmapped-type one — a different code path (isRectangularCellBlock guard).
  const d = diags();
  const mesh: MeshioMesh = {
    points: new Float64Array(6 * 3).fill(0),
    dim: 3,
    cells: [
      { type: "triangle", data: new Int32Array([0, 1, 2]), nodesPerCell: 3 }, // kept
      {
        type: "polygon", // SKIPPED — ragged, 1 row
        data: new Int32Array([0, 1, 2, 3, 4]),
        rowOffsets: new Int32Array([0, 5]),
      },
      { type: "line", data: new Int32Array([3, 4]), nodesPerCell: 2 }, // kept
    ],
    cell_data: {
      mat: [
        new Float64Array([11]), // triangle
        new Float64Array([99]), // ragged polygon — must NOT leak into the line block
        new Float64Array([33]), // line
      ],
    },
  };
  const m = meshioToModel(mesh, d);
  assert.equal(m.blocks.length, 2);
  const mat = m.fields.find((f) => f.variable === "mat");
  assert.ok(mat, "mat field survived");
  assert.deepEqual(Array.from(mat.values), [11, 33]);
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

/**
 * Exodus per-element attributes (meshio++ >= 9.3.0) — a SPHERE's radius.
 *
 * Two things have to hold for issue #63: the `exodus:attr:` namespace does not
 * leak into the variable name, and the NaN meshio++ fills for blocks that do
 * not declare the attribute never becomes a real value.
 */

/** Two vertex blocks: 3 particles with a radius, 2 cells without. */
function sphereMesh(): MeshioMesh {
  return {
    points: new Float64Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0]),
    dim: 3,
    cells: [
      { type: "vertex", data: new Int32Array([0, 1, 2]), nodesPerCell: 1 },
      { type: "vertex", data: new Int32Array([3, 4]), nodesPerCell: 1 },
    ],
    cell_data: {
      "exodus:attr:RADIUS": [
        new Float64Array([0.5, 0.5, 0.25]),
        new Float64Array([NaN, NaN]),
      ],
    },
  };
}

test("an exodus:attr: cell array becomes a plainly-named field", () => {
  const m = meshioToModel(sphereMesh(), diags());
  const f = m.fields.find((x) => x.variable === "RADIUS");
  assert.ok(f, `expected RADIUS, got ${m.fields.map((x) => x.variable)}`);
  assert.equal(f.kind, "Elemental");
  assert.equal(f.components, 1);
  // The prefix must not survive: mdpaWriter emits variable names verbatim, so
  // "exodus_attr_RADIUS" would land in a Kratos file as a non-variable.
  assert.equal(
    m.fields.some((x) => x.variable.includes("exodus")),
    false
  );
});

test("NaN attribute values are dropped, not written as radius 0", () => {
  // Both vertex blocks merge into one EntityBlock (cellType|stride), so this
  // has to filter by VALUE, not by block.
  const m = meshioToModel(sphereMesh(), diags());
  assert.equal(m.blocks.length, 1);
  assert.equal(m.blocks[0].count, 5);

  const f = m.fields.find((x) => x.variable === "RADIUS")!;
  assert.equal(f.ids.length, 3, "sparse: only the cells that have a radius");
  assert.deepEqual(Array.from(f.ids), [1, 2, 3]);
  assert.deepEqual(Array.from(f.values), [0.5, 0.5, 0.25]);
});

test("an all-NaN attribute is dropped entirely with a diagnostic", () => {
  const d = diags();
  const m = meshioToModel(
    {
      ...sphereMesh(),
      cell_data: {
        "exodus:attr:THICKNESS": [
          new Float64Array([NaN, NaN, NaN]),
          new Float64Array([NaN, NaN]),
        ],
      },
    },
    d
  );
  assert.equal(m.fields.length, 0, "no permanently-empty entry in the field pickers");
  assert.equal(d.length, 1);
  assert.match(d[0].message, /no finite values/);
});

test("modelToMeshio restores the exodus:attr: prefix and NaN-fills the gaps", () => {
  const model = meshioToModel(sphereMesh(), diags());
  const mesh = modelToMeshio(model, diags(), { exodusAttributes: true });
  const arrays = mesh.cell_data?.["exodus:attr:RADIUS"];
  assert.ok(arrays, `expected the prefixed key, got ${Object.keys(mesh.cell_data ?? {})}`);
  const flat = Array.from(arrays[0]);
  assert.deepEqual(flat.slice(0, 3), [0.5, 0.5, 0.25]);
  // NaN, not 0 — that is what makes meshio++ leave the attribute off a block
  // that never had one, so a partly-attributed file round-trips unchanged.
  assert.equal(flat.length, 5);
  assert.ok(Number.isNaN(flat[3]) && Number.isNaN(flat[4]));
});

test("the exodus prefix is an export-time rule, not model state", () => {
  const model = meshioToModel(sphereMesh(), diags());
  const mesh = modelToMeshio(model, diags()); // no exodusAttributes
  assert.deepEqual(Object.keys(mesh.cell_data ?? {}), ["RADIUS"]);
  // …and without the flag the uncovered cells keep cellFieldArray's 0.
  assert.equal(Array.from(mesh.cell_data!["RADIUS"][0]).every(Number.isFinite), true);
});

test("a vector cell field is not written as an Exodus attribute", () => {
  // An Exodus attribute is one value per element. The flat JS mesh carries no
  // shape, so meshio++ would silently truncate rather than raise.
  const model = meshioToModel(
    {
      ...sphereMesh(),
      cell_data: {
        VELOCITY: [
          new Float64Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
          new Float64Array([0, 0, 0, 0, 0, 0]),
        ],
      },
    },
    diags()
  );
  const d = diags();
  const mesh = modelToMeshio(model, d, { exodusAttributes: true });
  assert.equal(
    Object.keys(mesh.cell_data ?? {}).some((k) => k.startsWith("exodus:attr:")),
    false
  );
  assert.ok(d.some((x) => /single value per element/.test(x.message)));
});
