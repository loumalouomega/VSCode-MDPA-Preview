/**
 * The write half upstream does not give us: meshio++'s registry writer takes
 * no `OpenFoamInfo`, so every case it writes carries one synthesized
 * `defaultFaces` patch. `rewriteOpenFoamPatches` recovers the model's own
 * patch names onto the companions instead.
 *
 * Pure — no wasm, no disk. Companions are synthetic but meshio-shaped (the
 * byte layout the live writer was probed to emit: ascii `FoamFile` headers,
 * `n(...)` faces, one label per line). The end-to-end proof — a real case
 * read, written and re-read with its names intact — lives in meshio.test.ts.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { MeshioCompanionFile } from "../parser/meshio";
import { rewriteOpenFoamPatches } from "../parser/openfoamWrite";
import { parseOpenFoamBoundary } from "../parser/openfoamCase";
import type { MdpaModel, SubModelPart } from "../parser/types";

const enc = new TextEncoder();

function foamFile(cls: string, object: string, count: number, body: string): string {
  return (
    "FoamFile\n{\n    version     2.0;\n    format      ascii;\n" +
    `    class       ${cls};\n    location    "constant/polyMesh";\n    object      ${object};\n}\n` +
    `${count}\n(\n${body}\n)\n`
  );
}

/** Six boundary faces of a unit cube, deliberately interleaved by patch. */
const POINTS: Array<[number, number, number]> = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];
// Faces alternate inlet/outlet/inlet/outlet/… so a rewrite must reorder.
const FACES = [
  [0, 3, 2, 1], // bottom (inlet)
  [4, 5, 6, 7], // top (outlet)
  [0, 1, 5, 4], // front (inlet)
  [1, 2, 6, 5], // right (outlet)
  [2, 3, 7, 6], // back (inlet)
  [3, 0, 4, 7], // left (outlet)
];

function companionsOf(faces: number[][] = FACES, boundary?: string): MeshioCompanionFile[] {
  const points = POINTS.map((p) => `(${p.join(" ")})`).join("\n");
  const faceLines = faces.map((f) => `${f.length}(${f.join(" ")})`).join("\n");
  const owner = faces.map(() => "0").join("\n");
  const bnd =
    boundary ??
    "FoamFile\n{\n    version     2.0;\n    format      ascii;\n" +
      '    class       polyBoundaryMesh;\n    location    "constant/polyMesh";\n    object      boundary;\n}\n' +
      "1\n(\n    defaultFaces\n    {\n        type            patch;\n        nFaces          6;\n        startFace       0;\n    }\n)\n";
  const put = (base: string, text: string): MeshioCompanionFile => ({
    name: `constant/polyMesh/${base}`,
    data: enc.encode(text),
  });
  return [
    put("points", foamFile("vectorField", "points", POINTS.length, points)),
    put("faces", foamFile("faceList", "faces", faces.length, faceLines)),
    put("owner", foamFile("labelList", "owner", faces.length, owner)),
    put("neighbour", foamFile("labelList", "neighbour", 0, "")),
    { name: "constant/polyMesh/boundary", data: enc.encode(bnd) },
  ];
}

function part(path: string, conditionIds: number[]): SubModelPart {
  return {
    name: path,
    path,
    nodeIds: new Int32Array(0),
    elementIds: new Int32Array(0),
    conditionIds: Int32Array.from(conditionIds),
    geometryIds: new Int32Array(0),
    constraintIds: new Int32Array(0),
    children: [],
  };
}

/** Model whose conditions 1-3 are inlet faces, 4-6 outlet faces (by FACES order). */
function modelWith(parts: SubModelPart[]): MdpaModel {
  const coords = new Float32Array(POINTS.flat());
  return {
    nodeCount: POINTS.length,
    nodeIds: Int32Array.from(POINTS.map((_, i) => i + 1)),
    coords,
    blocks: [
      {
        kind: "Conditions",
        name: "quad",
        vtkCellType: 9,
        count: FACES.length,
        stride: 4,
        entityIds: Int32Array.from(FACES.map((_, i) => i + 1)),
        connectivity: Int32Array.from(FACES.flatMap((f) => f.map((p) => p + 1))),
      },
    ],
    subModelParts: parts,
    meta: [],
    fields: [],
    diagnostics: [],
    is3D: true,
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  };
}

const textOf = (companions: MeshioCompanionFile[], base: string): string =>
  Buffer.from(companions.find((c) => c.name === `constant/polyMesh/${base}`)!.data).toString(
    "utf8"
  );

test("two patches are recovered with accumulated startFace, faces regrouped", () => {
  const model = modelWith([part("inlet", [1, 3, 5]), part("outlet", [2, 4, 6])]);
  const { companions, diagnostics } = rewriteOpenFoamPatches(companionsOf(), model);

  const patches = parseOpenFoamBoundary(textOf(companions, "boundary"), []);
  assert.deepEqual(patches.map((p) => [p.name, p.nFaces, p.startFace]), [
    ["inlet", 3, 0],
    ["outlet", 3, 3],
  ]);

  // Faces were interleaved inlet/outlet; each patch must now be contiguous.
  const faces = textOf(companions, "faces");
  const rows = [...faces.matchAll(/4\(([^()]*)\)/g)].map((m) => m[1].trim());
  assert.deepEqual(rows.slice(0, 3), ["0 3 2 1", "0 1 5 4", "2 3 7 6"]);
  assert.deepEqual(rows.slice(3), ["4 5 6 7", "1 2 6 5", "3 0 4 7"]);

  // Owner followed its faces (all zeros here, but the length must still agree).
  const owner = textOf(companions, "owner");
  assert.equal(owner.match(/^0$/gm)!.length, 6);
  // Points and neighbour are untouched.
  assert.match(textOf(companions, "points"), /\(0 0 0\)/);
  assert.match(textOf(companions, "neighbour"), /^0$/m);
  assert.ok(diagnostics.some((d) => /inlet, outlet/.test(d.message)));
  assert.ok(diagnostics.some((d) => /defaulted to "patch"/.test(d.message)));
});

test("a part matching nothing is skipped with a diagnostic", () => {
  const model = modelWith([part("inlet", [1, 3, 5]), part("ghost", [41, 42])]);
  const { companions, diagnostics } = rewriteOpenFoamPatches(companionsOf(), model);
  const patches = parseOpenFoamBoundary(textOf(companions, "boundary"), []);
  assert.deepEqual(patches.map((p) => p.name), ["inlet", "defaultFaces"]);
  assert.deepEqual(patches.map((p) => [p.nFaces, p.startFace]), [[3, 0], [3, 3]]);
  assert.ok(diagnostics.some((d) => /"ghost".*skipped/.test(d.message)));
});

test("a model with no patch parts keeps the writer's output silently", () => {
  const before = companionsOf();
  const { companions, diagnostics } = rewriteOpenFoamPatches(before, modelWith([]));
  assert.deepEqual(companions, before);
  assert.deepEqual(diagnostics, []);
});

test("a missing companion falls back with a diagnostic, never half-written", () => {
  const before = companionsOf().filter((c) => !c.name.endsWith("owner"));
  const { companions, diagnostics } = rewriteOpenFoamPatches(
    before,
    modelWith([part("inlet", [1])])
  );
  assert.deepEqual(companions, before);
  assert.ok(diagnostics.some((d) => /missing/.test(d.message)));
});

test("a non-ascii companion falls back with a diagnostic", () => {
  const before = companionsOf().map((c) =>
    c.name.endsWith("faces")
      ? { ...c, data: enc.encode("FoamFile\n{\n    format      binary;\n}\n0\n(\n)\n") }
      : c
  );
  const { companions, diagnostics } = rewriteOpenFoamPatches(
    before,
    modelWith([part("inlet", [1])])
  );
  assert.deepEqual(companions, before);
  assert.ok(diagnostics.some((d) => /not ascii/.test(d.message)));
});

test("a boundary that already names two patches is left alone silently", () => {
  const two = companionsOf(
    FACES,
    "FoamFile\n{\n    version     2.0;\n    format      ascii;\n" +
      '    class       polyBoundaryMesh;\n    location    "constant/polyMesh";\n    object      boundary;\n}\n' +
      "2\n(\n    inlet\n    {\n        type patch;\n        nFaces 3;\n        startFace 0;\n    }\n" +
      "    outlet\n    {\n        type wall;\n        nFaces 3;\n        startFace 3;\n    }\n)\n"
  );
  const { companions, diagnostics } = rewriteOpenFoamPatches(
    two,
    modelWith([part("inlet", [1, 3, 5]), part("outlet", [2, 4, 6])])
  );
  assert.deepEqual(companions, two);
  assert.deepEqual(diagnostics, []);
});
