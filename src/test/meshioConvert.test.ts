import assert from "node:assert/strict";
import test from "node:test";

import {
  MeshioMesh,
  meshioBlockRowCount,
  meshioToModel,
  modelToMeshio,
  sanitizeVariable,
} from "../parser/meshioConvert";
import { MESHIO_TO_VTK_ORDER } from "../parser/meshioFormats";
import { MdpaDiagnostic } from "../parser/types";

function diags(): MdpaDiagnostic[] {
  return [];
}

/**
 * A unit cube as ONE polyhedron: 8 points, 6 outward-wound quad faces, in the
 * 2-level ragged CSR meshio++ hands a `polyhedron<N>` block over as.
 */
function cubePolyhedron(): MeshioMesh {
  // 0..3 = z=0 face (ccw seen from below), 4..7 = z=1 face.
  const points = new Float64Array([
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
    0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
  ]);
  const faces = [
    [0, 3, 2, 1], // bottom
    [4, 5, 6, 7], // top
    [0, 1, 5, 4], // y=0
    [1, 2, 6, 5], // x=1
    [2, 3, 7, 6], // y=1
    [3, 0, 4, 7], // x=0
  ];
  const data: number[] = [];
  const faceOffsets: number[] = [0];
  for (const f of faces) {
    data.push(...f);
    faceOffsets.push(data.length);
  }
  return {
    points,
    dim: 3,
    cells: [
      {
        type: "polyhedron6",
        data: Int32Array.from(data),
        faceOffsets: Int32Array.from(faceOffsets),
        cellOffsets: new Int32Array([0, faces.length]),
      },
    ],
  };
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

test("a ragged polygon block (meshio++ >= 8.7.0) is drawn, not skipped", () => {
  // It used to be diagnosed-and-skipped, so a polygonal mesh opened empty. A
  // 1-level ragged block needs no decomposition at all: the flat arrays
  // meshioToModel builds are already end-offset based, and
  // buildBlocksFromOffsets normalizes a POLYGON exactly as it does for a VTK
  // PolyData polygon — a 3-gon becomes a triangle, a 4-gon a quad.
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
  const total = m.blocks.reduce((n, b) => n + b.count, 0);
  assert.equal(total, 2, "both rows produced a cell");
  const strides = m.blocks.map((b) => b.stride).sort();
  assert.deepEqual(strides, [3, 4], "normalized into a triangle and a quad");
});

test("a degenerate polygon row is dropped without shifting the rest", () => {
  const d = diags();
  const m = meshioToModel(
    {
      points: new Float64Array(6 * 3).fill(0),
      dim: 3,
      cells: [
        {
          type: "polygon",
          data: new Int32Array([0, 1, 0, 1, 2]), // a 2-node row, then a triangle
          rowOffsets: new Int32Array([0, 2, 5]),
        },
      ],
      cell_data: { mat: [new Float64Array([99, 7])] },
    },
    d
  );
  assert.equal(
    m.blocks.reduce((n, b) => n + b.count, 0),
    1,
    "only the triangle survives"
  );
  const mat = m.fields.find((f) => f.variable === "mat");
  assert.deepEqual(Array.from(mat!.values), [7], "the surviving row keeps ITS value");
});

test("an all-degenerate polygon block does not shift the blocks after it", () => {
  // Regression: the block is skipped, so its rows must NOT be counted when
  // folding flat cells back onto source rows — otherwise every later block's
  // cell data (and every region index) shifts by that many entries.
  const d = diags();
  const m = meshioToModel(
    {
      points: new Float64Array(6 * 3).fill(0),
      dim: 3,
      cells: [
        { type: "triangle", data: new Int32Array([0, 1, 2]), nodesPerCell: 3 },
        {
          type: "polygon", // two 2-node rows: nothing drawable
          data: new Int32Array([0, 1, 2, 3]),
          rowOffsets: new Int32Array([0, 2, 4]),
        },
        { type: "line", data: new Int32Array([3, 4]), nodesPerCell: 2 },
      ],
      cell_data: {
        mat: [new Float64Array([11]), new Float64Array([99, 98]), new Float64Array([33])],
      },
    },
    d
  );
  const mat = m.fields.find((f) => f.variable === "mat");
  assert.ok(mat, "mat survived");
  assert.deepEqual(Array.from(mat.values), [11, 33], "the skipped block's values stay out");
  assert.ok(
    d.some((x) => /every row has fewer than 3 nodes/.test(x.message)),
    `expected a diagnostic, got ${d.map((x) => x.message)}`
  );
});

test("a ragged polyhedron block is decomposed into tetrahedra", () => {
  // A unit cube as 6 quad faces. The old behaviour opened it empty with a
  // diagnostic; it is now drawable, at the cost of the polyhedron identity.
  const d = diags();
  const m = meshioToModel({ ...cubePolyhedron() }, d);
  assert.equal(m.blocks.length, 1);
  assert.equal(m.blocks[0].stride, 4, "tetrahedra");
  // 6 quad faces x 4 edges = 24 tets; 1 cell apex + 6 face apexes = 7 new nodes.
  assert.equal(m.blocks[0].count, 24);
  assert.equal(m.nodeCount, 8 + 7);
  assert.match(d[0].message, /decomposed into 24 tetrahedra/);
  assert.match(d[0].message, /not preserved on export/);
});

test("the decomposed tetrahedra reproduce the polyhedron's volume exactly", () => {
  // The point of fanning about the corner average rather than the first listed
  // node: the decomposition must fill the cell, with no sliver and no overlap.
  const m = meshioToModel({ ...cubePolyhedron() }, diags());
  const b = m.blocks[0];
  let volume = 0;
  const p = (i: number): number[] => [
    m.coords[i * 3],
    m.coords[i * 3 + 1],
    m.coords[i * 3 + 2],
  ];
  for (let c = 0; c < b.count; c++) {
    // connectivity holds node IDS (1-based here, synthesized by finalizeModel).
    const [a, bb, cc, dd] = [0, 1, 2, 3].map((k) => b.connectivity[c * 4 + k] - 1);
    const [A, B, C, D] = [p(a), p(bb), p(cc), p(dd)];
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const w = [D[0] - A[0], D[1] - A[1], D[2] - A[2]];
    volume +=
      (w[0] * (u[1] * v[2] - u[2] * v[1]) +
        w[1] * (u[2] * v[0] - u[0] * v[2]) +
        w[2] * (u[0] * v[1] - u[1] * v[0])) /
      6;
  }
  assert.ok(Math.abs(volume - 1) < 1e-6, `unit cube volume, got ${volume}`);
  assert.ok(volume > 0, "every tet was oriented positively");
});

test("a polyhedron's cell data is replicated to its tetrahedra", () => {
  const d = diags();
  const m = meshioToModel({ ...cubePolyhedron(), cell_data: { mat: [new Float64Array([7])] } }, d);
  const mat = m.fields.find((f) => f.variable === "mat");
  assert.ok(mat, "mat survived");
  assert.equal(mat.values.length, 24, "one value per emitted tet");
  assert.ok(Array.from(mat.values).every((v) => v === 7));
});

test("a polyhedron's point data is interpolated at the invented apex nodes", () => {
  const d = diags();
  const m = meshioToModel(
    { ...cubePolyhedron(), point_data: { T: new Float64Array([0, 0, 0, 0, 1, 1, 1, 1]) } },
    d
  );
  const t = m.fields.find((f) => f.variable === "T");
  assert.ok(t, "T survived");
  assert.equal(t.values.length, 15, "extended to cover the apex nodes");
  // The cell apex is the mean over all 8 corners of a field that is 0 on the
  // z=0 face and 1 on the z=1 face.
  assert.ok(Math.abs(t.values[8] - 0.5) < 1e-9, `cell apex, got ${t.values[8]}`);
});

test("cell_data stays aligned when a ragged block sits in the middle", () => {
  // The ragged block is no longer skipped, so this now guards the opposite
  // hazard: its value must land on ITS cells and not bleed into the line block.
  const d = diags();
  const mesh: MeshioMesh = {
    points: new Float64Array(6 * 3).fill(0),
    dim: 3,
    cells: [
      { type: "triangle", data: new Int32Array([0, 1, 2]), nodesPerCell: 3 },
      {
        type: "polygon", // a pentagon: fans into 3 triangles
        data: new Int32Array([0, 1, 2, 3, 4]),
        rowOffsets: new Int32Array([0, 5]),
      },
      { type: "line", data: new Int32Array([3, 4]), nodesPerCell: 2 },
    ],
    cell_data: {
      mat: [new Float64Array([11]), new Float64Array([99]), new Float64Array([33])],
    },
  };
  const m = meshioToModel(mesh, d);
  const mat = m.fields.find((f) => f.variable === "mat");
  assert.ok(mat, "mat field survived");
  // 1 triangle + the pentagon's 3 fan triangles + 1 line, in that order.
  assert.deepEqual(Array.from(mat.values), [11, 99, 99, 99, 33]);
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
  // An Exodus attribute is one value per element, so a vector stays out of the
  // namespace — but since meshio++ 9.9.0 it is no longer lost by staying out:
  // ordinary cell_data is written as an element variable, and the declared
  // component count is what stops that from being truncated to its first value.
  const model = meshioToModel(
    {
      ...sphereMesh(),
      cell_data: {
        VELOCITY: [
          new Float64Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
          new Float64Array([0, 0, 0, 0, 0, 0]),
        ],
      },
      cell_data_components: { VELOCITY: 3 },
    },
    diags()
  );
  const d = diags();
  const mesh = modelToMeshio(model, d, { exodusAttributes: true });
  assert.equal(
    Object.keys(mesh.cell_data ?? {}).some((k) => k.startsWith("exodus:attr:")),
    false
  );
  assert.equal(mesh.cell_data_components?.["VELOCITY"], 3);
  assert.equal(
    d.some((x) => /single value per element/.test(x.message)),
    false
  );
});

test("a declared component count wins over dividing, and a bogus one is rejected", () => {
  // meshio++ >= 9.9.0 declares the width of every non-scalar array. Dividing
  // agrees with it for a well-formed array, so what the declaration really buys
  // is catching the case where the two DISAGREE — an array that would otherwise
  // be silently reinterpreted at some other width.
  const d = diags();
  const m = meshioToModel(
    {
      ...tetMesh(),
      point_data: {
        V: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1]),
        LIES: new Float64Array([1, 2, 3, 4, 5, 6, 7, 8]), // 8 values, 4 nodes
      },
      point_data_components: { V: 3, LIES: 3 }, // 3 * 4 !== 8
    },
    d
  );
  assert.equal(m.fields.find((f) => f.variable === "V")?.components, 3);
  assert.equal(m.fields.find((f) => f.variable === "LIES"), undefined);
  assert.ok(d.some((x) => /LIES/.test(x.message)));
});

test("a declared cell_data width applies to every block", () => {
  const d = diags();
  const m = meshioToModel(
    {
      points: new Float64Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
      dim: 3,
      cells: [
        { type: "triangle", data: new Int32Array([0, 1, 2]), nodesPerCell: 3 },
        { type: "line", data: new Int32Array([0, 3]), nodesPerCell: 2 },
      ],
      cell_data: { F: [new Float64Array([1, 2, 3]), new Float64Array([4, 5, 6])] },
      cell_data_components: { F: 3 },
    },
    d
  );
  const F = m.fields.find((f) => f.variable === "F");
  assert.equal(F?.components, 3);
  assert.deepEqual(Array.from(F!.values), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(d, []);
});

test("exodus:time is dropped SILENTLY — it is not the user's field_data", () => {
  // Every Exodus read carries it since meshio++ 9.9.0, so reporting it would
  // put a diagnostic on every Exodus file for something nobody wrote.
  const d = diags();
  meshioToModel({ ...tetMesh(), field_data: { "exodus:time": new Float64Array([0.5]) } }, d);
  assert.deepEqual(d, []);
  // A genuine field_data key alongside it is still reported, and alone.
  const d2 = diags();
  meshioToModel(
    {
      ...tetMesh(),
      field_data: { "exodus:time": new Float64Array([0.5]), blah: new Float64Array([1]) },
    },
    d2
  );
  assert.equal(d2.length, 1);
  assert.ok(/blah/.test(d2[0].message));
  assert.ok(!/exodus:time/.test(d2[0].message));
});

test("modelToMeshio declares the width of every vector field", () => {
  const model = meshioToModel(
    {
      ...tetMesh(),
      point_data: {
        T: new Float64Array([1, 2, 3, 4]),
        V: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1]),
      },
      point_data_components: { V: 3 },
      cell_data: { S: [new Float64Array([1, 2, 3, 4, 5, 6])] },
      cell_data_components: { S: 6 },
    },
    diags()
  );
  const back = modelToMeshio(model, diags());
  // A scalar gets NO entry: absent means one component, which is what keeps a
  // scalar-only mesh byte-identical to what pre-9.9.0 callers produced.
  assert.equal(back.point_data_components?.T, undefined);
  assert.equal(back.point_data_components?.V, 3);
  assert.equal(back.cell_data_components?.S, 6);
});

/** Two same-type blocks of different KINDS, plus a nested SubModelPart tree. */
function groupedModel() {
  const { parseMdpa } = require("../parser/mdpaParser") as typeof import("../parser/mdpaParser");
  return parseMdpa(
    [
      "Begin Nodes",
      " 1 0.0 0.0 0.0",
      " 2 1.0 0.0 0.0",
      " 3 1.0 1.0 0.0",
      " 4 0.0 1.0 0.0",
      "End Nodes",
      "Begin Elements Element2D3N",
      " 1 0 1 2 3",
      " 2 0 1 3 4",
      "End Elements",
      "Begin Conditions SurfaceCondition3D3N",
      " 10 0 1 2 3",
      "End Conditions",
      "Begin SubModelPart Inlets",
      " Begin SubModelPartNodes",
      "  1",
      "  2",
      " End SubModelPartNodes",
      " Begin SubModelPartElements",
      "  1",
      " End SubModelPartElements",
      " Begin SubModelPart Inner",
      "  Begin SubModelPartNodes",
      "   2",
      "  End SubModelPartNodes",
      " End SubModelPart",
      "End SubModelPart",
      "",
    ].join("\n")
  );
}

test("same-type blocks of different kinds stay separate blocks on the way out", () => {
  // Grouping by (type, stride, SOURCE BLOCK) rather than (type, stride): both of
  // these are meshio `triangle`/3, and fusing them would make the `Cell` region
  // for either one cover half a block — which is exactly the shape Exodus
  // refuses to name.
  const back = modelToMeshio(groupedModel(), diags());
  assert.equal(back.cells.length, 2);
  assert.deepEqual(back.cells.map((c) => c.type), ["triangle", "triangle"]);
  assert.deepEqual(back.cells.map(meshioBlockRowCount), [2, 1]);
});

test("modelToMeshio emits a Cell region per block and a region pair per SubModelPart", () => {
  const back = modelToMeshio(groupedModel(), diags());
  const named = (n: string, k: string) =>
    (back.regions ?? []).find((r) => r.name === n && r.kind === k);

  // One per emitted block, entries the block's contiguous global range — the
  // only shape Exodus can turn back into an `eb_names` entry.
  assert.deepEqual(Array.from(named("Element2D3N", "cell")!.entries), [0, 1]);
  assert.deepEqual(Array.from(named("SurfaceCondition3D3N", "cell")!.entries), [2]);
  assert.equal(named("Element2D3N", "cell")!.dim, 2, "triangles are 2-dimensional");

  // One cell + one point region per part, sharing a name so a name-keyed format
  // (MED, Abaqus) treats them as one group.
  assert.deepEqual(Array.from(named("Inlets", "cell")!.entries), [0]);
  assert.deepEqual(Array.from(named("Inlets", "point")!.entries), [0, 1]);
  // Nested parts use the dotted path: a "/" would reach an HDF5 group name.
  assert.deepEqual(Array.from(named("Inlets.Inner", "point")!.entries), [1]);
  assert.equal(named("Inlets.Inner", "cell"), undefined, "no cells, so no cell region");
  assert.equal(named("Inlets.Inner", "point")!.dim, 0);
});

test("a SubModelPart name colliding with a block name is suffixed, not merged", () => {
  const model = groupedModel();
  model.subModelParts[0].name = "Element2D3N";
  model.subModelParts[0].path = "Element2D3N";
  const back = modelToMeshio(model, diags());
  const names = (back.regions ?? []).map((r) => r.name);
  // The block region is emitted first, so the part takes the suffix. Merging
  // them would silently union two unrelated groups in every name-keyed format.
  assert.ok(names.includes("Element2D3N"));
  assert.ok(names.includes("Element2D3N_2"), `have: ${names.join(", ")}`);
});

// --- partial cell-field coverage on export ---------------------------------
//
// A cell field that does not cover every cell of its kind is zero-filled in the
// gaps, and cellFieldArray's 0 is indistinguishable from a real 0 on read. Only
// the Exodus attribute path escapes that, by NaN-filling — and that path is
// scalars-only, so a sparse VECTOR always takes the zero-fill branch.

test("a partly-covered cell field is reported rather than silently zero-filled", () => {
  // sphereMesh's RADIUS covers 3 of its 5 one-node cells.
  const model = meshioToModel(sphereMesh(), diags());
  const d = diags();
  modelToMeshio(model, d); // no exodusAttributes → the zero-fill branch

  const hit = d.find((x) => /covers 3 of 5/.test(x.message));
  assert.ok(hit, `expected a coverage diagnostic, got ${d.map((x) => x.message)}`);
  assert.match(hit.message, /RADIUS/);
  assert.match(hit.message, /cannot be told from a real 0/);
});

test("the Exodus attribute path NaN-fills instead, so it is not reported", () => {
  const model = meshioToModel(sphereMesh(), diags());
  const d = diags();
  modelToMeshio(model, d, { exodusAttributes: true });
  assert.equal(
    d.some((x) => /covers \d+ of \d+/.test(x.message)),
    false,
    "a NaN-filled attribute is omitted per block by meshio++, not fabricated"
  );
});

test("a sparse VECTOR is reported even under exodusAttributes", () => {
  // A vector is deliberately left unprefixed (an attribute is one value per
  // element), so it takes the zero-fill branch whatever the target format.
  const model = meshioToModel(
    {
      ...sphereMesh(),
      cell_data: {
        VELOCITY: [
          new Float64Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
          new Float64Array([NaN, NaN, NaN, NaN, NaN, NaN]),
        ],
      },
      cell_data_components: { VELOCITY: 3 },
    },
    diags()
  );
  const d = diags();
  modelToMeshio(model, d, { exodusAttributes: true });
  assert.ok(
    d.some((x) => /VELOCITY/.test(x.message) && /covers/.test(x.message)),
    `expected a VELOCITY coverage diagnostic, got ${d.map((x) => x.message)}`
  );
});

test("a fully-covered cell field is not reported", () => {
  const model = meshioToModel(
    {
      ...sphereMesh(),
      cell_data: {
        MASS: [new Float64Array([1, 2, 3]), new Float64Array([4, 5])],
      },
    },
    diags()
  );
  const d = diags();
  modelToMeshio(model, d);
  assert.equal(
    d.some((x) => /covers \d+ of \d+/.test(x.message)),
    false
  );
});
