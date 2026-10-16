/**
 * OpenFOAM field export (roadmap item 3, Step 5): writes an Elemental field
 * covering every volume cell as `0/<VAR>`.
 *
 * Pure — no wasm, no disk. The cell-order correspondence this module rests
 * on was measured against the live writer (see openfoamFieldWrite.ts's own
 * doc comment); the end-to-end write→read round trip lives in meshio.test.ts.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { MeshioCompanionFile } from "../parser/meshio";
import {
  isCellCentredTimeZeroFile,
  volumeCellIdsInWriteOrder,
  writeOpenFoamFields,
} from "../parser/openfoamFieldWrite";
import type { EntityBlock, FieldData, MdpaModel } from "../parser/types";

function hexBlock(name: string, entityId: number, connStart: number): EntityBlock {
  return {
    name,
    kind: "Elements",
    vtkCellType: 12, // hexahedron
    count: 1,
    stride: 8,
    entityIds: new Int32Array([entityId]),
    connectivity: new Int32Array(Array.from({ length: 8 }, (_, i) => connStart + i)),
    propertyIds: new Int32Array([0]),
  };
}

function quadBlock(name: string, entityId: number, connStart: number): EntityBlock {
  return {
    name,
    kind: "Conditions",
    vtkCellType: 9, // quad
    count: 1,
    stride: 4,
    entityIds: new Int32Array([entityId]),
    connectivity: new Int32Array(Array.from({ length: 4 }, (_, i) => connStart + i)),
    propertyIds: new Int32Array([0]),
  };
}

function baseModel(blocks: EntityBlock[], fields: FieldData[]): MdpaModel {
  return {
    nodeCount: 16,
    nodeIds: new Int32Array(Array.from({ length: 16 }, (_, i) => i + 1)),
    coords: new Float32Array(48),
    blocks,
    fields,
    subModelParts: [],
    is3D: true,
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    diagnostics: [],
    meta: [],
  };
}

const BOUNDARY_ONE_PATCH: MeshioCompanionFile = {
  name: "constant/polyMesh/boundary",
  data: new TextEncoder().encode(
    "FoamFile\n{\n    version 2.0;\n    format ascii;\n    class polyBoundaryMesh;\n    object boundary;\n}\n" +
      "1\n(\n    inlet\n    {\n        type patch;\n        nFaces 4;\n        startFace 0;\n    }\n)\n"
  ),
};

function baseCompanions(): MeshioCompanionFile[] {
  return [{ name: "constant/polyMesh/points", data: new Uint8Array() }, BOUNDARY_ONE_PATCH];
}

test("volumeCellIdsInWriteOrder walks blocks in array order, volume cells only", () => {
  const model = baseModel(
    [hexBlock("HexA", 1, 1), quadBlock("Face", 1, 1), hexBlock("HexB", 2, 5)],
    []
  );
  assert.deepEqual(volumeCellIdsInWriteOrder(model), [1, 2]);
});

test("writes a scalar field covering every volume cell as 0/<VAR>", () => {
  const model = baseModel(
    [hexBlock("HexA", 1, 1), hexBlock("HexB", 2, 5)],
    [
      {
        kind: "Elemental",
        variable: "TEMP",
        components: 1,
        ids: new Int32Array([2, 1]), // deliberately out of order
        values: new Float64Array([222, 111]),
      },
    ]
  );
  const { companions, diagnostics } = writeOpenFoamFields(baseCompanions(), model, []);
  assert.deepEqual(diagnostics, []);
  const field = companions.find((c) => c.name === "0/TEMP");
  assert.ok(field, "0/TEMP companion written");
  const text = Buffer.from(field!.data).toString("utf8");
  assert.match(text, /class\s+volScalarField/);
  assert.match(text, /object\s+TEMP/);
  // Cell 1's value (111) first, cell 2's (222) second — write order, not
  // field.ids order.
  assert.match(text, /nonuniform List<scalar>\n2\n\(\n111\n222\n\)/);
  assert.match(text, /inlet\n\s*{\n\s*type\s+zeroGradient;/);
});

test("writes a vector field with parenthesized rows and a tensor field with 9-wide rows", () => {
  const model = baseModel(
    [hexBlock("HexA", 1, 1)],
    [
      {
        kind: "Elemental",
        variable: "VEL",
        components: 3,
        ids: new Int32Array([1]),
        values: new Float64Array([1, 2, 3]),
      },
      {
        kind: "Elemental",
        variable: "STRESS",
        components: 9,
        ids: new Int32Array([1]),
        values: new Float64Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
      },
    ]
  );
  const { companions } = writeOpenFoamFields(baseCompanions(), model, []);
  const vel = Buffer.from(companions.find((c) => c.name === "0/VEL")!.data).toString("utf8");
  assert.match(vel, /class\s+volVectorField/);
  assert.match(vel, /\(1 2 3\)/);
  const stress = Buffer.from(companions.find((c) => c.name === "0/STRESS")!.data).toString("utf8");
  assert.match(stress, /class\s+volTensorField/);
  assert.match(stress, /\(1 2 3 4 5 6 7 8 9\)/);
});

test("a field not covering every volume cell is named and skipped, not written as 0", () => {
  const model = baseModel(
    [hexBlock("HexA", 1, 1), hexBlock("HexB", 2, 5)],
    [
      {
        kind: "Elemental",
        variable: "PARTIAL",
        components: 1,
        ids: new Int32Array([1]),
        values: new Float64Array([9]),
      },
    ]
  );
  const { companions, diagnostics } = writeOpenFoamFields(baseCompanions(), model, []);
  assert.ok(!companions.some((c) => c.name === "0/PARTIAL"));
  assert.ok(diagnostics.some((d) => /does not cover every volume cell/.test(d.message)));
});

test("a component count other than 1/3/9 is named and skipped", () => {
  const model = baseModel(
    [hexBlock("HexA", 1, 1)],
    [
      {
        kind: "Elemental",
        variable: "WEIRD",
        components: 2,
        ids: new Int32Array([1]),
        values: new Float64Array([1, 2]),
      },
    ]
  );
  const { companions, diagnostics } = writeOpenFoamFields(baseCompanions(), model, []);
  assert.ok(!companions.some((c) => c.name === "0/WEIRD"));
  assert.ok(diagnostics.some((d) => /only scalar.*vector.*tensor/i.test(d.message)));
});

test("a Nodal or Conditional field is silently skipped — no diagnostic flood", () => {
  const model = baseModel(
    [hexBlock("HexA", 1, 1)],
    [
      {
        kind: "Nodal",
        variable: "P",
        components: 1,
        ids: new Int32Array([1, 2, 3, 4]),
        values: new Float64Array([1, 2, 3, 4]),
      },
    ]
  );
  const { companions, diagnostics } = writeOpenFoamFields(baseCompanions(), model, []);
  assert.ok(!companions.some((c) => c.name === "0/P"));
  assert.deepEqual(diagnostics, []);
});

test("a duplicate variable name keeps the first and names the rest", () => {
  const model = baseModel(
    [hexBlock("HexA", 1, 1)],
    [
      { kind: "Elemental", variable: "T", components: 1, ids: new Int32Array([1]), values: new Float64Array([1]) },
      { kind: "Elemental", variable: "T", components: 1, ids: new Int32Array([1]), values: new Float64Array([2]) },
    ]
  );
  const { companions, diagnostics } = writeOpenFoamFields(baseCompanions(), model, []);
  const t = companions.filter((c) => c.name === "0/T");
  assert.equal(t.length, 1);
  assert.match(Buffer.from(t[0].data).toString("utf8"), /\n1\n\(\n1\n\)/);
  assert.ok(diagnostics.some((d) => /duplicate field name "T"/.test(d.message)));
});

test("no volume cells: nothing is written, no diagnostics", () => {
  const model = baseModel(
    [quadBlock("Face", 1, 1)],
    [{ kind: "Elemental", variable: "T", components: 1, ids: new Int32Array([1]), values: new Float64Array([1]) }]
  );
  const before = baseCompanions();
  const { companions, diagnostics } = writeOpenFoamFields(before, model, []);
  assert.equal(companions, before, "same reference — nothing to do");
  assert.deepEqual(diagnostics, []);
});

test("no boundary companion: the boundaryField block is empty, not a throw", () => {
  const model = baseModel(
    [hexBlock("HexA", 1, 1)],
    [{ kind: "Elemental", variable: "T", components: 1, ids: new Int32Array([1]), values: new Float64Array([5]) }]
  );
  const { companions } = writeOpenFoamFields(
    [{ name: "constant/polyMesh/points", data: new Uint8Array() }],
    model,
    []
  );
  const text = Buffer.from(companions.find((c) => c.name === "0/T")!.data).toString("utf8");
  assert.match(text, /boundaryField\n\{\n\}\n/);
});

/** A time-zero file of the kind meshio++ 17.3.0 writes for a field of its own. */
function upstreamTimeZero(variable: string, cls: string, marker: string): MeshioCompanionFile {
  const text =
    `FoamFile\n{\n    version     2.0;\n    format      ascii;\n    class       ${cls};\n    object      ${variable};\n}\n` +
    `// ${marker}\ndimensions      [0 0 0 0 0 0 0];\n`;
  return { name: `0/${variable}`, data: new TextEncoder().encode(text) };
}

test("isCellCentredTimeZeroFile picks out volField copies under 0/ and nothing else", () => {
  assert.equal(isCellCentredTimeZeroFile(upstreamTimeZero("A", "volVectorField", "x")), true);
  assert.equal(isCellCentredTimeZeroFile(upstreamTimeZero("A", "pointScalarField", "x")), false);
  assert.equal(
    isCellCentredTimeZeroFile({ name: "constant/polyMesh/owner", data: new TextEncoder().encode("class volScalarField;") }),
    false,
    "only time-zero files"
  );
});

test("the writer's own copy replaces meshio++'s cell-centred copy; a point-centred copy is kept", () => {
  const model = baseModel(
    [hexBlock("HexA", 1, 1), hexBlock("HexB", 2, 5)],
    [{ kind: "Elemental", variable: "TEMP", components: 1, ids: new Int32Array([1, 2]), values: new Float64Array([111, 222]) }]
  );
  const { companions, diagnostics } = writeOpenFoamFields(
    [
      ...baseCompanions(),
      upstreamTimeZero("TEMP", "volScalarField", "upstream-copy"),
      upstreamTimeZero("NODAL", "pointScalarField", "upstream-point"),
    ],
    model,
    []
  );
  assert.deepEqual(diagnostics, []);
  const temp = companions.filter((c) => c.name === "0/TEMP");
  assert.equal(temp.length, 1, "one time-zero file per field name");
  const tempText = Buffer.from(temp[0].data).toString("utf8");
  assert.doesNotMatch(tempText, /upstream-copy/);
  assert.match(tempText, /nonuniform List<scalar>\n2\n\(\n111\n222\n\)/);
  const nodal = companions.find((c) => c.name === "0/NODAL");
  assert.ok(nodal && /upstream-point/.test(Buffer.from(nodal.data).toString("utf8")), "point-centred copy kept as written");
});

test("a refused cell-centred field leaves no zero-filled copy of meshio++'s behind", () => {
  const model = baseModel(
    [hexBlock("HexA", 1, 1), hexBlock("HexB", 2, 5)],
    [{ kind: "Elemental", variable: "Q", components: 1, ids: new Int32Array([1]), values: new Float64Array([7]) }]
  );
  const { companions, diagnostics } = writeOpenFoamFields(
    [...baseCompanions(), upstreamTimeZero("Q", "volScalarField", "upstream-copy")],
    model,
    []
  );
  assert.equal(companions.some((c) => c.name === "0/Q"), false);
  assert.ok(
    diagnostics.some((d) => /"Q" does not cover every volume cell \(1 of 2\)/.test(d.message)),
    JSON.stringify(diagnostics)
  );
});

test("a Conditional field's meshio++ copy (one zero-valued cell) is dropped, and the field is skipped silently", () => {
  const model = baseModel(
    [hexBlock("HexA", 1, 1), quadBlock("Bottom", 1, 1)],
    [{ kind: "Conditional", variable: "C", components: 1, ids: new Int32Array([1]), values: new Float64Array([5]) }]
  );
  const { companions, diagnostics } = writeOpenFoamFields(
    [...baseCompanions(), upstreamTimeZero("C", "volScalarField", "upstream-copy")],
    model,
    []
  );
  assert.equal(companions.some((c) => c.name === "0/C"), false);
  assert.deepEqual(diagnostics, []);
});

import { patchBoundaryEntry } from "../parser/openfoamFieldWrite";

test("patchBoundaryEntry writes fixedValue for a uniform Conditional value, else zeroGradient", () => {
  const field = { kind: "Elemental", variable: "U", components: 3, ids: new Int32Array([1]), values: new Float64Array(3) } as never;
  const cond = (vals: number[]) =>
    ({ fields: [{ kind: "Conditional", variable: "U", components: 3, ids: new Int32Array([10, 11]), values: new Float64Array(vals) }] }) as never;
  const part = { name: "inlet", conditionIds: new Int32Array([10, 11]) };
  assert.match(patchBoundaryEntry(cond([1, 0, 0, 1, 0, 0]), field, part), /fixedValue;\s+value\s+uniform \(1 0 0\);/);
  assert.match(patchBoundaryEntry(cond([1, 0, 0, 2, 0, 0]), field, part), /zeroGradient/);
  assert.match(patchBoundaryEntry({ fields: [] } as never, field, part), /zeroGradient/);
});
