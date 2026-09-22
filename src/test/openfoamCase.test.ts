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

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  applyOpenFoamPatches,
  listOpenFoamProcessors,
  listOpenFoamRegions,
  openFoamCaseDir,
  parseAsciiLabelList,
  parseOpenFoamBoundary,
  wouldOverwriteOpenFoamCase,
} from "../parser/openfoamCase";
import { MdpaDiagnostic, MdpaModel } from "../parser/types";

function tmpCaseDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openfoam-case-"));
}

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

  // roadmap item 3: types reach model.source, keyed by the final part name,
  // so openfoamWrite.ts can look them up by SubModelPart name on write.
  assert.deepEqual(out.source, {
    format: "openfoam",
    openfoam: { patchTypes: { inlet: "patch", outlet: "wall" } },
  });
});

test("a patch with no declared type contributes nothing to source.openfoam.patchTypes", () => {
  const d = diag();
  const out = applyOpenFoamPatches(
    taggedModel([0, -1, -1, -1, -1, -1, -1]),
    [{ name: "inlet", type: "", nFaces: 6, startFace: 0 }],
    d
  );
  assert.equal(out.source, undefined, "nothing recovered, so no source at all");
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

// ---- multi-region / decomposed discovery (roadmap item 3, Step 5) ---------
// Pure/fs-only: no wasm needed to enumerate directories. The actual
// reconstruction is wasm-driven and proved end to end in meshio.test.ts
// against the committed fixtures/openfoam-multiregion and
// fixtures/openfoam-decomposed cases.

test("listOpenFoamRegions finds every constant/<name>/polyMesh, sorted", () => {
  const dir = tmpCaseDir();
  fs.mkdirSync(path.join(dir, "constant", "solid", "polyMesh"), { recursive: true });
  fs.mkdirSync(path.join(dir, "constant", "fluid", "polyMesh"), { recursive: true });
  // A constant/ entry with no polyMesh (e.g. transportProperties) is not a region.
  fs.mkdirSync(path.join(dir, "constant", "notARegion"), { recursive: true });
  assert.deepEqual(listOpenFoamRegions(dir), ["fluid", "solid"]);
});

test("listOpenFoamRegions is [] for an ordinary single-region case or a missing constant/", () => {
  const dir = tmpCaseDir();
  fs.mkdirSync(path.join(dir, "constant", "polyMesh"), { recursive: true });
  assert.deepEqual(listOpenFoamRegions(dir), []);
  assert.deepEqual(listOpenFoamRegions(tmpCaseDir()), []);
});

test("listOpenFoamProcessors finds every processorN/constant/polyMesh, numerically sorted", () => {
  const dir = tmpCaseDir();
  fs.mkdirSync(path.join(dir, "processor10", "constant", "polyMesh"), { recursive: true });
  fs.mkdirSync(path.join(dir, "processor2", "constant", "polyMesh"), { recursive: true });
  // A processor-looking dir with no polyMesh yet (mid-decomposePar) is skipped.
  fs.mkdirSync(path.join(dir, "processor3"), { recursive: true });
  // Not a processor dir at all.
  fs.mkdirSync(path.join(dir, "processorX", "constant", "polyMesh"), { recursive: true });
  assert.deepEqual(listOpenFoamProcessors(dir), [2, 10], "numeric order, not lexicographic (2 before 10)");
});

test("parseAsciiLabelList reads a plain labelList, malformed input is undefined", () => {
  const text =
    "FoamFile\n{\n    version 2.0;\n    format ascii;\n    class labelList;\n    object pointProcAddressing;\n}\n" +
    "4\n(\n0\n1\n2\n3\n)\n";
  assert.deepEqual(parseAsciiLabelList(text), [0, 1, 2, 3]);
  assert.equal(parseAsciiLabelList("not a labelList at all"), undefined);
  assert.deepEqual(parseAsciiLabelList("0\n(\n)\n"), [], "an empty list is a legal, non-undefined answer");
});
