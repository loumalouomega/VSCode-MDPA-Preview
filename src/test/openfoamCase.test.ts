/**
 * The two halves upstream does not give us: the `boundary` dictionary's patch
 * names, and the join that puts them on the model.
 *
 * Pure — no wasm, no disk. The end-to-end proof lives in meshio.test.ts; these
 * pin the behaviours that are easy to get subtly wrong and impossible to see
 * from a round-trip that happens to pass.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyOpenFoamPatches,
  openFoamCaseDir,
  parseOpenFoamBoundary,
  wouldOverwriteOpenFoamCase,
} from "../parser/openfoamCase";
import { MdpaDiagnostic, MdpaModel } from "../parser/types";

const diag = (): MdpaDiagnostic[] => [];

/** Exactly what this extension's own exporter writes. */
const WRITER_BOUNDARY = `/*--------------------------------*- C++ -*----------------------------------*\\
| =========                 |                                                 |
\\*---------------------------------------------------------------------------*/
FoamFile
{
    version     2.0;
    format      ascii;
    class       polyBoundaryMesh;
    location    "constant/polyMesh";
    object      boundary;
}
// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

1
(
    defaultFaces
    {
        type            patch;
        nFaces          6;
        startFace       0;
    }
)
`;

test("parseOpenFoamBoundary reads what our own writer emits", () => {
  const d = diag();
  assert.deepEqual(parseOpenFoamBoundary(WRITER_BOUNDARY, d), [
    { name: "defaultFaces", type: "patch", nFaces: 6, startFace: 0 },
  ]);
  assert.deepEqual(d, [], "a well-formed file warns about nothing");
});

test("parseOpenFoamBoundary handles a real multi-patch file", () => {
  // inGroups is a list inside a body, which is why the list's own extent is
  // found by the LAST paren rather than the first balanced one.
  const d = diag();
  const patches = parseOpenFoamBoundary(
    `FoamFile { class polyBoundaryMesh; object boundary; }
     // the cavity tutorial's shape
     3
     (
         movingWall
         {
             type            wall;
             inGroups        1 (wall);
             nFaces          20;
             startFace       760;
         }
         fixedWalls
         {
             type            wall;
             inGroups        (wall);
             nFaces          60;
             startFace       780;
         }
         /* an empty patch, as a 2D case has */
         frontAndBack
         {
             type            empty;
             nFaces          800;
             startFace       840;
         }
     )`,
    d
  );
  assert.deepEqual(
    patches.map((p) => [p.name, p.type, p.nFaces]),
    [
      ["movingWall", "wall", 20],
      ["fixedWalls", "wall", 60],
      ["frontAndBack", "empty", 800],
    ]
  );
  assert.deepEqual(d, []);
});

test("a malformed entry keeps its INDEX rather than being skipped", () => {
  // The whole reason this parser exists in this shape. The join is positional —
  // a face tagged -3 is the third patch — so dropping one entry would silently
  // rename every patch after it, which is indistinguishable from success.
  const d = diag();
  const patches = parseOpenFoamBoundary(
    `3
     (
         inlet  { type patch; nFaces 3; startFace 0; }
         broken { type patch; nFaces 3;
         outlet { type wall; nFaces 3; startFace 6; }
     )`,
    d
  );
  assert.equal(patches.length, 2, "parsing stops at the unterminated body");
  assert.equal(patches[0].name, "inlet");
  assert.equal(patches[1].synthesized, true, "the broken entry still holds index 1");
  assert.match(patches[1].name, /^patch_1$/);
  assert.ok(d.some((x) => /unterminated/.test(x.message)));
});

test("parseOpenFoamBoundary degrades, never throws", () => {
  for (const text of ["", "not a foam file at all", "FoamFile { }", "12345"]) {
    const d = diag();
    assert.deepEqual(parseOpenFoamBoundary(text, d), [], JSON.stringify(text));
    assert.ok(d.length > 0, "and says why");
  }
  // A count that disagrees with the entries keeps the entries.
  const d = diag();
  const p = parseOpenFoamBoundary("3 ( a { type patch; } b { type wall; } )", d);
  assert.deepEqual(p.map((x) => x.name), ["a", "b"]);
  assert.ok(d.some((x) => /declares 3 patch/.test(x.message)));
});

test("an unresolved #include is named as the likely cause", () => {
  const d = diag();
  parseOpenFoamBoundary('2 ( #include "extraPatches" a { type patch; } )', d);
  assert.ok(d.some((x) => /#include/.test(x.message)));
});

// ---- the join ---------------------------------------------------------------

/** One hex (id 1, tag 0) plus six faces (ids 2..7) split across two patches. */
function taggedModel(tags: number[]): MdpaModel {
  return {
    nodeCount: 8,
    nodeIds: Int32Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
    coords: new Float32Array(24),
    blocks: [
      {
        kind: "Elements", name: "hexahedron", vtkCellType: 12, count: 1, stride: 8,
        entityIds: Int32Array.from([1]), connectivity: new Int32Array(8),
      },
      {
        kind: "Elements", name: "quad", vtkCellType: 9, count: 6, stride: 4,
        entityIds: Int32Array.from([2, 3, 4, 5, 6, 7]), connectivity: new Int32Array(24),
      },
    ],
    fields: [
      {
        kind: "Elemental", variable: "cell_tags", components: 1,
        ids: Int32Array.from([1, 2, 3, 4, 5, 6, 7]),
        values: Float64Array.from(tags),
      },
    ],
    subModelParts: [],
    meta: [],
    diagnostics: [],
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    is3D: true,
  } as unknown as MdpaModel;
}

test("cell_tags become named Conditions SubModelParts", () => {
  const d = diag();
  const out = applyOpenFoamPatches(
    taggedModel([0, -1, -1, -1, -2, -2, -2]),
    [
      { name: "inlet", type: "patch", nFaces: 3, startFace: 0 },
      { name: "outlet", type: "wall", nFaces: 3, startFace: 3 },
    ],
    d
  );

  const hex = out.blocks[0];
  const quad = out.blocks[1];
  assert.equal(hex.kind, "Elements", "the volume block is untouched");
  assert.deepEqual(Array.from(hex.entityIds), [1], "and keeps its id");
  assert.equal(quad.kind, "Conditions", "the all-boundary block flips");
  assert.deepEqual(
    Array.from(quad.entityIds),
    [1, 2, 3, 4, 5, 6],
    "Conditions get their own id space, which may overlap the Elements'"
  );

  assert.deepEqual(out.subModelParts.map((p) => p.name), ["inlet", "outlet"]);
  assert.deepEqual(Array.from(out.subModelParts[0].conditionIds), [1, 2, 3]);
  assert.deepEqual(Array.from(out.subModelParts[1].conditionIds), [4, 5, 6]);

  assert.ok(!out.fields.some((f) => f.variable === "cell_tags"), "the tag array is dropped");
  assert.deepEqual(d, [], "a consistent case warns about nothing");
});

test("a tag the boundary file does not declare is reported, not guessed", () => {
  const d = diag();
  const out = applyOpenFoamPatches(
    taggedModel([0, -1, -1, -1, -9, -9, -9]),
    [{ name: "inlet", type: "patch", nFaces: 3, startFace: 0 }],
    d
  );
  assert.deepEqual(out.subModelParts.map((p) => p.name), ["inlet"]);
  assert.deepEqual(Array.from(out.subModelParts[0].conditionIds), [1, 2, 3]);
  assert.ok(d.some((x) => /does not declare/.test(x.message)));
});

test("an nFaces mismatch warns that the names may not line up", () => {
  // The one guard against a tag convention we have not measured. Better a loud
  // maybe-wrong than a silent definitely-wrong.
  const d = diag();
  applyOpenFoamPatches(
    taggedModel([0, -1, -1, -1, -2, -2, -2]),
    [
      { name: "inlet", type: "patch", nFaces: 99, startFace: 0 },
      { name: "outlet", type: "wall", nFaces: 3, startFace: 3 },
    ],
    d
  );
  assert.ok(d.some((x) => /may not line up/.test(x.message)));
});

test("a block mixing interior and boundary faces is left alone", () => {
  const d = diag();
  const out = applyOpenFoamPatches(
    taggedModel([0, -1, -1, 0, -2, -2, -2]),
    [{ name: "inlet", type: "patch" }],
    d
  );
  assert.equal(out.blocks[1].kind, "Elements", "not flipped");
  assert.ok(d.some((x) => /mixes interior and boundary/.test(x.message)));
});

test("no cell_tags: the model comes back untouched", () => {
  const m = taggedModel([0, -1, -1, -1, -2, -2, -2]);
  const stripped = { ...m, fields: [] } as MdpaModel;
  const d = diag();
  const out = applyOpenFoamPatches(stripped, [{ name: "inlet", type: "patch" }], d);
  assert.equal(out, stripped, "same reference — nothing to do");
  assert.ok(d.some((x) => /no cell_tags/.test(x.message)));
});

test("a zero-face patch produces no SubModelPart", () => {
  // Legal and common in a real case; an empty part would just be noise.
  const d = diag();
  const out = applyOpenFoamPatches(
    taggedModel([0, -1, -1, -1, -1, -1, -1]),
    [
      { name: "inlet", type: "patch", nFaces: 6, startFace: 0 },
      { name: "unused", type: "patch", nFaces: 0, startFace: 6 },
    ],
    d
  );
  assert.deepEqual(out.subModelParts.map((p) => p.name), ["inlet"]);
});

// ---- paths ------------------------------------------------------------------

test("openFoamCaseDir resolves a marker to its case", () => {
  assert.equal(openFoamCaseDir("/runs/cavity/run.foam"), "/runs/cavity");
  assert.equal(openFoamCaseDir("/runs/cavity"), "/runs/cavity", "a directory is its own case");
});

test("wouldOverwriteOpenFoamCase compares DIRECTORIES, not paths", () => {
  // Exporting to a different .foam name in the same case still rewrites the
  // same constant/polyMesh — a path comparison would wave that through.
  assert.equal(wouldOverwriteOpenFoamCase("/c/run.foam", "/c/run.foam"), true);
  assert.equal(wouldOverwriteOpenFoamCase("/c/run.foam", "/c/other.foam"), true);
  assert.equal(wouldOverwriteOpenFoamCase("/c/run.foam", "/elsewhere/run.foam"), false);
  assert.equal(wouldOverwriteOpenFoamCase("/c/run.foam", "/c/out.vtu"), false);
  assert.equal(wouldOverwriteOpenFoamCase("/c/mesh.vtu", "/c/run.foam"), false);
});
