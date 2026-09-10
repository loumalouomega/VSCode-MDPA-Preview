/**
 * Native OpenFOAM field files: the `vol*Field` / `point*Field` dictionaries
 * upstream never reads, plus the numeric time-directory listing behind the
 * `.foam` timeline.
 *
 * Pure except for temp-dir tests of the directory listing (node:fs only, no
 * wasm, no vscode).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  augmentMeshioWithFoamFields,
  isOpenFoamTimeName,
  listOpenFoamTimesSync,
} from "../parser/openfoamCase";
import { parseFoamField } from "../parser/openfoamFields";
import type { MeshioMesh } from "../parser/meshioConvert";
import type { MdpaDiagnostic } from "../parser/types";

const diag = (): MdpaDiagnostic[] => [];

const SCALAR_P = `FoamFile
{
    version 2.0;
    format ascii;
    class volScalarField;
    object p;
}
dimensions [0 2 -2 0 0 0 0];
internalField uniform 101325;
boundaryField
{
    inlet { type fixedValue; value uniform 101325; }
    outlet { type zeroGradient; }
}
`;

const VECTOR_U = `FoamFile
{
    version 2.0;
    format ascii;
    class volVectorField;
    object U;
}
dimensions [0 1 -1 0 0 0 0];
internalField nonuniform List<vector> 2((1 0 0)(0 2 0));
boundaryField
{
    inlet { type fixedValue; value uniform (1 0 0); }
}
`;

test("parseFoamField reads a uniform scalar with a uniform patch value", () => {
  const d = diag();
  const f = parseFoamField(SCALAR_P, "p", d);
  assert.ok(f);
  assert.equal(f.object, "p");
  assert.equal(f.domain, "vol");
  assert.equal(f.components, 1);
  assert.deepEqual(f.internal, { kind: "uniform", values: [101325] });
  assert.deepEqual(f.boundaryUniform.get("inlet"), [101325]);
  assert.ok(!f.boundaryUniform.has("outlet"), "zeroGradient has no value to take");
});

test("parseFoamField reads a nonuniform vector", () => {
  const d = diag();
  const f = parseFoamField(VECTOR_U, "U", d);
  assert.ok(f);
  assert.equal(f.components, 3);
  assert.equal(f.internal?.kind, "nonuniform");
  if (f.internal?.kind === "nonuniform") {
    assert.equal(f.internal.count, 2);
    assert.deepEqual([...f.internal.values], [1, 0, 0, 0, 2, 0]);
  }
  assert.deepEqual(f.boundaryUniform.get("inlet"), [1, 0, 0]);
});

test("parseFoamField refuses binary, includes and substitution", () => {
  for (const [name, text] of [
    ["b", "FoamFile { format binary; class volScalarField; object p; } internalField uniform 1;"],
    ["i", "#include \"initial\"\nFoamFile { format ascii; class volScalarField; object p; } internalField uniform 1;"],
    ["s", "FoamFile { format ascii; class volScalarField; object p; } internalField uniform $inlet;"],
    ["t", "FoamFile { format ascii; class volTensorField; object tau; } internalField uniform 1;"],
    ["surf", "FoamFile { format ascii; class surfaceScalarField; object phi; } internalField uniform 1;"],
  ] as const) {
    const d = diag();
    assert.equal(parseFoamField(text, name, d), undefined, name);
    assert.ok(d.length > 0, `${name} warns`);
  }
});

test("parseFoamField fails a count-mismatched list, not shifted", () => {
  const d = diag();
  const text = `FoamFile { format ascii; class volScalarField; object p; }
internalField nonuniform List<scalar> 3(1 2);`;
  assert.equal(parseFoamField(text, "p", d), undefined);
  assert.match(d[0].message, /declares 3/);
});

test("parseFoamField reads scientific and negative values, rejects NaN", () => {
  const d = diag();
  const f = parseFoamField(
    `FoamFile { format ascii; class volScalarField; object T; } internalField nonuniform List<scalar> 2(-1.5e3 2.5E-2);`,
    "T",
    d
  );
  assert.ok(f?.internal?.kind === "nonuniform");
  const bad = diag();
  assert.equal(
    parseFoamField(
      `FoamFile { format ascii; class volScalarField; object T; } internalField nonuniform List<scalar> 1(nan);`,
      "T",
      bad
    ),
    undefined
  );
});

test("isOpenFoamTimeName accepts numerics and rejects the rest", () => {
  for (const n of ["0", "0.5", "2", "10", "1e-3", "-0.1", ".5", "1E+05"]) {
    assert.equal(isOpenFoamTimeName(n), true, n);
  }
  for (const n of ["constant", "system", "processor0", "0.orig", "abc", "", "1,5"]) {
    assert.equal(isOpenFoamTimeName(n), false, n);
  }
});

test("listOpenFoamTimesSync sorts numerically and excludes non-times", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foam-times-"));
  try {
    for (const n of ["10", "0", "0.5", "2", "constant", "system", "processor0", "0.orig"]) {
      fs.mkdirSync(path.join(dir, n));
    }
    fs.writeFileSync(path.join(dir, "stray"), "x");
    assert.deepEqual(
      listOpenFoamTimesSync(dir).map((t) => t.name),
      ["0", "0.5", "2", "10"]
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Two volume quads then one boundary quad (negative tag). */
function taggedMesh(): MeshioMesh {
  return {
    points: new Float64Array([0, 0, 1, 0, 1, 1, 0, 1, 2, 0, 2, 1]),
    dim: 2,
    cells: [
      { type: "quad", data: new Int32Array([0, 1, 2, 3, 1, 4, 5, 2]), nodesPerCell: 4 },
      { type: "quad", data: new Int32Array([3, 2, 5, 0]), nodesPerCell: 4 },
    ],
    cell_data: {
      cell_tags: [new Float64Array([0, 0]), new Float64Array([-1])],
    },
  };
}

test("augmentMeshioWithFoamFields consumes volume rows and NaN-fills boundary", () => {
  const d = diag();
  const mesh = taggedMesh();
  const u = parseFoamField(VECTOR_U, "U", diag());
  assert.ok(u);
  augmentMeshioWithFoamFields(mesh, [u], d);
  const arr = mesh.cell_data?.["U"];
  assert.ok(arr);
  assert.deepEqual([...arr[0]], [1, 0, 0, 0, 2, 0]);
  assert.ok(arr[1].every((v) => Number.isNaN(v)), "boundary rows are NaN for the sparse path");
  assert.equal(mesh.cell_data_components?.["U"], 3);
});

test("augment refuses a count mismatch and a mixed-type nonuniform field", () => {
  const d1 = diag();
  const bad = parseFoamField(
    `FoamFile { format ascii; class volScalarField; object p; } internalField nonuniform List<scalar> 5(1 2 3 4 5);`,
    "p",
    diag()
  );
  assert.ok(bad);
  const m1 = taggedMesh();
  augmentMeshioWithFoamFields(m1, [bad], d1);
  assert.ok(!m1.cell_data?.["p"], "nothing partial is left behind");
  assert.match(d1[0].message, /declares 5/);

  const d2 = diag();
  const mesh = taggedMesh();
  mesh.cells.push({ type: "triangle", data: new Int32Array([0, 1, 2]), nodesPerCell: 3 });
  (mesh.cell_data as Record<string, Float64Array[]>).cell_tags.push(new Float64Array([0]));
  const f = parseFoamField(
    `FoamFile { format ascii; class volScalarField; object p; } internalField nonuniform List<scalar> 3(1 2 3);`,
    "p",
    diag()
  );
  assert.ok(f);
  augmentMeshioWithFoamFields(mesh, [f], d2);
  assert.ok(!mesh.cell_data?.["p"]);
  assert.match(d2[0].message, /mixed volume cell types/);
});

test("augment skips volume fields without cell_tags instead of guessing", () => {
  const d = diag();
  const mesh = taggedMesh();
  delete mesh.cell_data?.["cell_tags"];
  const f = parseFoamField(SCALAR_P, "p", diag());
  assert.ok(f);
  augmentMeshioWithFoamFields(mesh, [f], d);
  assert.ok(!mesh.cell_data?.["p"]);
  assert.match(d[0].message, /no cell_tags/);
});
