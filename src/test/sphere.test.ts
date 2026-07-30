/**
 * SPHERE / particle element support (issue #63).
 *
 * The fixture `fixtures/exodus/DCBmodel_PD_solid.e` is the file from the issue:
 * a real PeriLab peridynamics run — 504 one-node `SPHERE` particles in four
 * element blocks, 2-D, nine nodal fields, ten time steps. See the fixture
 * directory's README for its provenance and licence.
 *
 * Two properties of it drive the whole feature:
 *
 *  1. It used to fail the read outright, because NetCDF.jl counts the C
 *     string's terminating NUL in the `elem_type` attribute's length, so the
 *     type arrived as `"SPHERE\0"` and matched no key. Fixed in meshio++ 9.3.0
 *     — the first test here is that regression.
 *
 *  2. It carries NO radius: no Exodus `attrib` variables, and none of its nodal
 *     fields is a radius or a volume. So the constant-radius fallback and the
 *     editable radius are not decoration — they are the only way this file ever
 *     renders as spheres.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import { readMeshioModel } from "../parser/meshio";
import { readMeshTimeSteps } from "../parser/meshFileParser";
import { MdpaModel, SubModelPart } from "../parser/types";

const FIXTURE = path.resolve(
  __dirname,
  "../../src/test/fixtures/exodus/DCBmodel_PD_solid.e"
);

function readFixture(timeStep?: number): Promise<MdpaModel> {
  const data = fs.readFileSync(FIXTURE);
  return readMeshioModel(
    "DCBmodel_PD_solid.e",
    [{ name: "DCBmodel_PD_solid.e", data }],
    ".e",
    undefined,
    timeStep
  );
}

function part(model: MdpaModel, name: string): SubModelPart {
  const p = model.subModelParts.find((s) => s.path === name);
  assert.ok(p, `SubModelPart "${name}" exists (have: ${model.subModelParts.map((s) => s.path)})`);
  return p;
}

test("a NetCDF.jl-written SPHERE file opens (issue #63)", async () => {
  // The whole issue: this threw `Exodus: unknown element type SPHERE` before
  // meshio++ 9.3.0. Everything else here is downstream of it working.
  const model = await readFixture();
  assert.equal(model.nodeCount, 504);
  assert.deepEqual(model.diagnostics, [], "a clean read produces no diagnostics");
});

test("SPHERE elements arrive as one-node VERTEX cells", async () => {
  const model = await readFixture();
  // Exodus SPHERE maps to meshio `vertex` -> VTK_VERTEX (1). The file's four
  // element blocks MERGE into one EntityBlock: buildBlocksFromOffsets groups by
  // (cellType, stride), so block identity survives as SubModelParts, not layers.
  const blocks = model.blocks.filter((b) => b.vtkCellType === 1);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].stride, 1);
  assert.equal(blocks[0].count, 504);
  assert.equal(blocks[0].kind, "Elements");
  assert.equal(blocks[0].name, "vertex");
});

test("element blocks and node sets become SubModelParts", async () => {
  const model = await readFixture();
  assert.equal(part(model, "block_1").elementIds?.length, 216);
  assert.equal(part(model, "block_2").elementIds?.length, 216);
  assert.equal(part(model, "block_3").elementIds?.length, 36);
  assert.equal(part(model, "block_4").elementIds?.length, 36);
  assert.equal(part(model, "Node Set 1").nodeIds?.length, 36);
  assert.equal(part(model, "Node Set 2").nodeIds?.length, 36);
});

test("the file carries no radius at all", async () => {
  // Documents property 2 above. If this ever starts failing because upstream
  // learned to synthesize a radius, the fallback UX below can be reconsidered.
  const model = await readFixture();
  assert.equal(
    model.fields.find((f) => f.variable === "RADIUS"),
    undefined
  );
  assert.equal(
    model.fields.every((f) => f.kind === "Nodal"),
    true,
    "only nodal solution fields; no per-element attributes"
  );
});

test("a 2-D particle file stays 2-D with z padded to 0", async () => {
  const model = await readFixture();
  assert.equal(model.is3D, false);
  assert.equal(model.bounds.min[2], 0);
  assert.equal(model.bounds.max[2], 0);
});

test("the in-file timeline is ten steps", async () => {
  const steps = await readMeshTimeSteps(FIXTURE);
  assert.equal(steps.length, 10);
  assert.equal(steps[0], 0);
  assert.ok(steps[9] > steps[0]);
});

test("a later time step yields different nodal values", async () => {
  const first = await readFixture(0);
  const last = await readFixture(9);
  const dmg = (m: MdpaModel): number[] =>
    Array.from(m.fields.find((f) => f.variable === "Damage")!.values);
  assert.notDeepEqual(dmg(last), dmg(first), "the damage field evolves");
});

/**
 * Exodus export (enabled in this change, meshio++ >= 9.3.0).
 *
 * The radius-carrying fixture is GENERATED rather than committed: upstream's
 * SPHERE+RADIUS fixture is built at test time with netCDF4 in Python and never
 * committed, and the real DCB file above has no radius. Writing one through
 * meshio++'s own Exodus writer costs nothing and needs no second binary.
 *
 * Caveat this path does NOT cover: meshio++'s writer emits NetCDF-4/HDF5, so
 * the classic netCDF-3 reader is exercised only by `seacas.exo` (issue #56) and
 * `DCBmodel_PD_solid.e` above.
 */

/** 5 particles in 2 blocks; only the first block declares a radius. */
async function radiusFixture(): Promise<Uint8Array> {
  const { writeMeshioBytes } = await import("../parser/meshio");
  const { meshioToModel } = await import("../parser/meshioConvert");
  const model = meshioToModel(
    {
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
    },
    []
  );
  const { data } = await writeMeshioBytes(model, ".exo");
  return data as Uint8Array;
}

function readBytes(data: Uint8Array): Promise<MdpaModel> {
  return readMeshioModel("r.exo", [{ name: "r.exo", data }], ".exo");
}

test("a radius survives an Exodus export round-trip", async () => {
  const model = await readBytes(await radiusFixture());
  const f = model.fields.find((x) => x.variable === "RADIUS");
  assert.ok(f, `expected RADIUS, got ${model.fields.map((x) => x.variable)}`);
  assert.equal(f.kind, "Elemental");
  // Still sparse: the block that never declared the attribute must not come
  // back with one. That only works because the write NaN-fills rather than
  // zero-fills, so meshio++ leaves that block's attrib{k} out entirely.
  assert.deepEqual(Array.from(f.values), [0.5, 0.5, 0.25]);
});

test("Exodus export is lossy for SubModelParts (documented limitation)", async () => {
  // Pinned rather than left to be discovered by a user. Since meshio++ 9.9.0 the
  // Exodus writer recovers `eb_names` from `Cell` regions, and modelToMeshio
  // emits one per block — so the BLOCK NAME survives where it used to come back
  // as the reader's synthetic `Block N`. What still does not survive is this
  // file's own grouping, for two reasons that compound: the READ merges its four
  // SPHERE blocks into one EntityBlock (grouping is by cellType+stride), so by
  // write time `block_1..4` are four SubModelParts over one block and none of
  // them covers a whole block — Exodus's rule for an `eb_names` entry; and the
  // writer emits no node sets at all, so the two `Node Set` parts have no home.
  // Export to .mdpa/.vtu/.med if the grouping matters.
  const { writeMeshioBytes } = await import("../parser/meshio");
  const before = await readFixture();
  assert.deepEqual(before.subModelParts.map((p) => p.path), [
    "Node Set 1",
    "Node Set 2",
    "block_1",
    "block_2",
    "block_3",
    "block_4",
  ]);

  const { data } = await writeMeshioBytes(before, ".exo");
  const after = await readBytes(data as Uint8Array);
  assert.deepEqual(
    after.subModelParts.map((p) => p.path),
    ["vertex"], // the merged block's own name, not `Block 0`
    "the block name survives; the four sets and two node sets do not"
  );
  assert.equal(after.nodeCount, before.nodeCount, "geometry itself survives");
});

test("Exodus is a single-file writer", async () => {
  const { writeMeshFileAsync } = await import("../parser/writers/meshWriter");
  const model = await readFixture();
  const { data, companions } = await writeMeshFileAsync(model, ".exo", { name: "dcb" });
  assert.ok(data instanceof Uint8Array);
  assert.deepEqual(companions, []);
});
