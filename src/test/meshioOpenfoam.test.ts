/**
 * End-to-end tests against the real meshio++ WASM binary for OpenFOAM cases
 * specifically (extracted from meshio.test.ts — see the note there). No skip
 * guard: @meshioplusplus/wasm is a hard dependency and CI should fail loudly
 * if it is missing.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { parseMeshFile } from "../parser/meshFileParser";
import { readMeshioModel, writeMeshioBytes } from "../parser/meshio";
import { MdpaModel } from "../parser/types";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "meshio-"));
}

/** A single hexahedron — OpenFOAM derives its faces from VOLUME cells. */
function hexModel(): MdpaModel {
  const { parseMdpa } = require("../parser/mdpaParser") as typeof import("../parser/mdpaParser");
  return parseMdpa(
    [
      "Begin Nodes",
      " 1 0.0 0.0 0.0", " 2 1.0 0.0 0.0", " 3 1.0 1.0 0.0", " 4 0.0 1.0 0.0",
      " 5 0.0 0.0 1.0", " 6 1.0 0.0 1.0", " 7 1.0 1.0 1.0", " 8 0.0 1.0 1.0",
      "End Nodes",
      "Begin Elements Element3D8N",
      " 1 0 1 2 3 4 5 6 7 8",
      "End Elements",
      "",
    ].join("\n")
  );
}

test("meshio++ 9.20.0: .foam writes a polyMesh DIRECTORY, not a sibling file", async () => {
  // The reason MeshioCompanionFile.name carries a relative PATH. The named
  // output is a 0-byte marker and the companions ARE the mesh, so a caller
  // that ignored them would write nothing at all.
  const { data, companions } = await writeMeshioBytes(hexModel(), ".foam", { stem: "case" });
  assert.equal(data.length, 0, "the .foam file itself is an empty marker");
  assert.deepEqual(
    companions.map((c) => c.name).sort(),
    [
      "constant/polyMesh/boundary",
      "constant/polyMesh/cellZones",
      "constant/polyMesh/faces",
      "constant/polyMesh/neighbour",
      "constant/polyMesh/owner",
      "constant/polyMesh/points",
    ],
    "six polyMesh files since 11.4.0: the writer carries block Cell regions as cellZones"
  );
  for (const c of companions) assert.ok(c.data.length > 0, `${c.name} is non-empty`);

  const boundary = Buffer.from(
    companions.find((c) => c.name.endsWith("boundary"))!.data
  ).toString("utf8");
  // No OpenFoamInfo side channel through the generic registry writer, so every
  // case gets the one synthesized patch `blockMesh` itself produces.
  assert.match(boundary, /defaultFaces/, "the synthesized patch is named in boundary");
});

test("a mesh exported to .foam writes the whole tree to disk", async () => {
  // The caller-side half: a companion's folders do not exist yet.
  const { writeMeshFileAsync } = await import("../parser/writers/meshWriter");
  const dir = tmpDir();
  const dest = path.join(dir, "run.foam");
  const { data, companions } = await writeMeshFileAsync(hexModel(), ".foam", { name: "run" });
  fs.writeFileSync(dest, data);
  for (const c of companions) {
    const p = path.join(dir, c.name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c.data);
  }
  assert.deepEqual(
    fs.readdirSync(path.join(dir, "constant", "polyMesh")).sort(),
    ["boundary", "cellZones", "faces", "neighbour", "owner", "points"]
  );
  assert.ok(fs.existsSync(dest), "the marker sits beside constant/");
});

// ---- reading a case back (the other direction) ------------------------------

/** Writes hexModel() as a real case in a temp dir and returns `<dir>/run.foam`. */
async function writeCase(): Promise<string> {
  const { writeMeshFileAsync } = await import("../parser/writers/meshWriter");
  const dir = tmpDir();
  const dest = path.join(dir, "run.foam");
  const { data, companions } = await writeMeshFileAsync(hexModel(), ".foam", { name: "run" });
  fs.writeFileSync(dest, data);
  for (const c of companions) {
    const p = path.join(dir, c.name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c.data);
  }
  return dest;
}

const polyMesh = (marker: string, name: string) =>
  path.join(path.dirname(marker), "constant", "polyMesh", name);

test("an OpenFOAM case round-trips: write a case, then open its marker", async () => {
  // THE gate for this feature. Staging a directory tree is the whole change,
  // and nothing short of reading a real case back proves it works.
  const marker = await writeCase();
  const model = await parseMeshFile(marker);

  assert.equal(model.nodeCount, 8, "the hexahedron's corners");
  const vol = model.blocks.filter((b) => b.kind === "Elements");
  const bnd = model.blocks.filter((b) => b.kind === "Conditions");
  assert.equal(vol.reduce((n, b) => n + b.count, 0), 1, "one volume cell");
  assert.equal(bnd.reduce((n, b) => n + b.count, 0), 6, "six boundary faces, as Conditions");

  // Bounds rather than coordinate order: OpenFOAM renumbers points.
  assert.deepEqual(Array.from(model.bounds.min), [0, 0, 0]);
  assert.deepEqual(Array.from(model.bounds.max), [1, 1, 1]);

  // The patch name our own writer synthesizes, recovered from boundary —
  // plus the block-derived "Element3D8N" zone (roadmap item 3: cellZones
  // now stage), the same block-name-survives-as-a-part pattern every other
  // format already has (Exodus block names, FLAC3D zone groups, …).
  assert.deepEqual(model.subModelParts.map((p) => p.name), ["Element3D8N", "defaultFaces"]);
  const [zonePart, facesPart] = model.subModelParts;
  assert.equal(zonePart.elementIds.length, 1, "the writer's own block-derived zone");
  assert.equal(facesPart.conditionIds.length, 6);
  assert.equal(facesPart.elementIds.length, 0, "faces are Conditions, not Elements");

  // The tag array did its job and is gone; leaving it would be an Elemental
  // field keyed on ids that moved into the condition space.
  assert.ok(!model.fields.some((f) => f.variable === "cell_tags"));
});

test("an Elemental field survives an OpenFOAM write -> read round trip (roadmap item 3, Step 5)", async () => {
  // The whole gate for openfoamFieldWrite.ts's cell-order assumption: it was
  // measured with a two-hexahedron model against the raw writer output (see
  // that module's own doc comment); this proves the FULL pipeline — write,
  // stage to disk, read back through parseMeshFile — lands the same values
  // on the same entity ids.
  const model = {
    ...hexModel(),
    fields: [
      {
        kind: "Elemental" as const,
        variable: "TEMP",
        components: 1,
        ids: new Int32Array([1]),
        values: new Float64Array([42]),
      },
    ],
  };
  const { writeMeshFileAsync } = await import("../parser/writers/meshWriter");
  const dir = tmpDir();
  const dest = path.join(dir, "run.foam");
  const { data, companions } = await writeMeshFileAsync(model, ".foam", { name: "run" });
  assert.ok(companions.some((c) => c.name === "0/TEMP"), "the field companion was written");
  fs.writeFileSync(dest, data);
  for (const c of companions) {
    const p = path.join(dir, c.name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c.data);
  }
  const readBack = await parseMeshFile(dest);
  const temp = readBack.fields.find((f) => f.variable === "TEMP");
  assert.ok(temp, "TEMP read back");
  assert.equal(temp!.kind, "Elemental");
  assert.deepEqual(Array.from(temp!.ids), [1]);
  assert.deepEqual(Array.from(temp!.values), [42]);
});

test("real patch names survive, one SubModelPart each", async () => {
  // The only multi-patch exercise, and so the only check on the
  // `-(patchIndex+1)` <-> boundary-file-order convention the join rests on.
  const marker = await writeCase();
  fs.writeFileSync(
    polyMesh(marker, "boundary"),
    [
      "FoamFile", "{", "    version 2.0;", "    format ascii;",
      "    class polyBoundaryMesh;", "    object boundary;", "}",
      "", "2", "(",
      "    inlet", "    {", "        type patch;", "        inGroups (wall);",
      "        nFaces 3;", "        startFace 0;", "    }",
      "    outlet", "    {", "        type wall;",
      "        nFaces 3;", "        startFace 3;", "    }",
      ")", "",
    ].join("\n")
  );
  const model = await parseMeshFile(marker);
  // "Element3D8N" is the block-derived zone (roadmap item 3) — see the
  // single-patch test above for why it is now expected here too.
  assert.deepEqual(model.subModelParts.map((p) => p.name), ["Element3D8N", "inlet", "outlet"]);
  const [, a, b] = model.subModelParts;
  assert.equal(a.conditionIds.length, 3);
  assert.equal(b.conditionIds.length, 3);
  const overlap = Array.from(a.conditionIds).filter((id) => b.conditionIds.includes(id));
  assert.deepEqual(overlap, [], "the two patches share no face");
  // The nFaces cross-check agreed, so no warning about mismatched patches.
  assert.ok(!model.diagnostics.some((d) => /may not line up/.test(d.message)));
});

// ---- multi-region / decomposed cases (roadmap item 3, Step 5) --------------
// Committed fixtures (like two-step.vtkhdf/two-step.pvd/two-piece.pvtu
// before them), each with its own generator script under fixtures/, rather
// than built in a temp dir per test — the reconstruction/merge is the thing
// under test, not the fixture construction.

const MULTIREGION_CASE = path.resolve(
  __dirname,
  "../../src/test/fixtures/openfoam-multiregion/case/case.foam"
);
const DECOMPOSED_CASE = path.resolve(
  __dirname,
  "../../src/test/fixtures/openfoam-decomposed/case/case.foam"
);

test("a multi-region case with no region requested merges every region, one wrapper part each", async () => {
  const model = await parseMeshFile(MULTIREGION_CASE);
  assert.equal(model.nodeCount, 16, "8 + 8, not welded — mergeManyModels does not weld by default");
  const vol = model.blocks.filter((b) => b.kind === "Elements");
  const bnd = model.blocks.filter((b) => b.kind === "Conditions");
  assert.equal(vol.reduce((n, b) => n + b.count, 0), 2, "one hexahedron per region");
  assert.equal(bnd.reduce((n, b) => n + b.count, 0), 12, "6 boundary faces per region — no shared face reconstruction");

  assert.deepEqual(model.subModelParts.map((p) => p.name), ["fluid", "solid"]);
  const [fluid, solid] = model.subModelParts;
  assert.deepEqual(fluid.children.map((c) => c.path), ["fluid/defaultFaces"]);
  assert.deepEqual(solid.children.map((c) => c.path), ["solid/defaultFaces"]);

  // Each region's own 0/<region>/T field lands in one merged Elemental
  // field, offset into the merged element id space.
  const t = model.fields.find((f) => f.variable === "T");
  assert.ok(t, "T field present");
  assert.deepEqual(Array.from(t!.values), [300, 500]);
});

test("foamRegion selects one region instead of merging, and refuses an unknown one", async () => {
  const fluid = await parseMeshFile(MULTIREGION_CASE, undefined, { foamRegion: "fluid" });
  assert.equal(fluid.nodeCount, 8);
  assert.deepEqual(Array.from(fluid.bounds.min), [0, 0, 0]);
  assert.deepEqual(Array.from(fluid.bounds.max), [1, 1, 1]);
  assert.deepEqual(Array.from(fluid.fields.find((f) => f.variable === "T")!.values), [300]);

  const solid = await parseMeshFile(MULTIREGION_CASE, undefined, { foamRegion: "solid" });
  assert.deepEqual(Array.from(solid.bounds.min), [1, 0, 0]);
  assert.deepEqual(Array.from(solid.fields.find((f) => f.variable === "T")!.values), [500]);

  await assert.rejects(
    parseMeshFile(MULTIREGION_CASE, undefined, { foamRegion: "nope" }),
    /region "nope" not found.*fluid, solid/s
  );
});

test("foamRegion is refused for an ordinary single-region case", async () => {
  const marker = await writeCase();
  await assert.rejects(
    parseMeshFile(marker, undefined, { foamRegion: "x" }),
    /is not a multi-region case/
  );
});

test("a decomposed (processorN/) case reconstructs one mesh with the shared face restored", async () => {
  // The upstream-measured shape from the plan's own probe: 12 points (8 + 8
  // minus the 4 shared at x=1), 2 hexahedra, 10 boundary quads (6 + 6 minus
  // the 2 that became internal at the shared face).
  const model = await parseMeshFile(DECOMPOSED_CASE);
  assert.equal(model.nodeCount, 12);
  const vol = model.blocks.filter((b) => b.kind === "Elements");
  const bnd = model.blocks.filter((b) => b.kind === "Conditions");
  assert.equal(vol.reduce((n, b) => n + b.count, 0), 2);
  assert.equal(bnd.reduce((n, b) => n + b.count, 0), 10);

  // Patch names recovered from processor0's own boundary (a single
  // "defaultFaces" patch here — see collectDecomposedOpenFoamCase's doc
  // comment for the ordering assumption this rests on).
  assert.deepEqual(model.subModelParts.map((p) => p.name), ["defaultFaces"]);
  assert.equal(model.subModelParts[0].conditionIds.length, 10);

  // Informational, not a warning — the decomposed read is deliberate here.
  assert.ok(model.diagnostics.some((d) => /reconstructed from 2 processor directories/.test(d.message)));
  assert.ok(!model.diagnostics.some((d) => /may not line up/.test(d.message)));
});

test("patch names survive a write: read a two-patch case, write it, re-read", async () => {
  // The write half of the round-trip. meshio++'s registry writer synthesizes
  // one `defaultFaces`; the model's own patch names are recovered onto the
  // rewritten companions instead, so a second read finds inlet/outlet again.
  const marker = await writeCase();
  fs.writeFileSync(
    polyMesh(marker, "boundary"),
    [
      "FoamFile", "{", "    version 2.0;", "    format ascii;",
      "    class polyBoundaryMesh;", "    object boundary;", "}",
      "", "2", "(",
      "    inlet", "    {", "        type patch;",
      "        nFaces 3;", "        startFace 0;", "    }",
      "    outlet", "    {", "        type wall;",
      "        nFaces 3;", "        startFace 3;", "    }",
      ")", "",
    ].join("\n")
  );
  const model = await parseMeshFile(marker);
  assert.deepEqual(model.subModelParts.map((p) => p.name), ["Element3D8N", "inlet", "outlet"]);

  const { writeMeshFileAsync } = await import("../parser/writers/meshWriter");
  const dir = tmpDir();
  const dest = path.join(dir, "copy.foam");
  const warnings: string[] = [];
  const { data, companions } = await writeMeshFileAsync(model, ".foam", {
    name: "copy",
    onWarning: (m) => warnings.push(m),
  });
  fs.writeFileSync(dest, data);
  for (const c of companions) {
    const p = path.join(dir, c.name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c.data);
  }
  assert.ok(
    warnings.some((m) => /2 patch\(es\) written with recovered names \(inlet, outlet\)/.test(m)),
    "the recovery is reported through onWarning"
  );

  const reread = await parseMeshFile(dest);
  // Both zone names now appear: "Element3D8N" is the SubModelPart the FIRST
  // read's own zone staging added to `model` (itself written out as a zone
  // on this second write, since a SubModelPart gets its own Cell region same
  // as a block does), and "hexahedron" is the block's own name after
  // meshio's generic reader renamed it by cell type. Noise that compounds
  // over successive OpenFOAM round trips, not a defect this change causes —
  // measured, not assumed.
  assert.deepEqual(
    reread.subModelParts.map((p) => p.name),
    ["Element3D8N", "hexahedron", "inlet", "outlet"]
  );
  const [, , a, b] = reread.subModelParts;
  assert.equal(a.conditionIds.length, 3);
  assert.equal(b.conditionIds.length, 3);
  const overlap = Array.from(a.conditionIds).filter((id) => b.conditionIds.includes(id));
  assert.deepEqual(overlap, [], "the two patches share no face after the rewrite");
  // roadmap item 3: "wall" needs no extra dictionary keys, so it now
  // survives the rewrite instead of defaulting to "patch" for both.
  assert.ok(warnings.some((m) => /recovered types kept where they need no extra keys/.test(m)));
});

test("a writeCompression on case reads through the gunzip", async () => {
  const zlib = await import("node:zlib");
  const marker = await writeCase();
  const pts = polyMesh(marker, "points");
  fs.writeFileSync(`${pts}.gz`, zlib.gzipSync(fs.readFileSync(pts)));
  fs.unlinkSync(pts);

  const model = await parseMeshFile(marker);
  assert.equal(model.nodeCount, 8, "points.gz was inflated during staging");
  assert.deepEqual(Array.from(model.bounds.max), [1, 1, 1]);
});

test("a case without boundary loses its faces, and says so", async () => {
  // Measured upstream behaviour: boundary is optional, and without it the whole
  // boundary-face block disappears rather than arriving unnamed.
  const marker = await writeCase();
  fs.unlinkSync(polyMesh(marker, "boundary"));
  const model = await parseMeshFile(marker);
  assert.equal(model.blocks.filter((b) => b.kind === "Conditions").length, 0);
  assert.equal(model.blocks.reduce((n, b) => n + b.count, 0), 1, "the volume cell survives");
  // No patches (boundary is gone), but the block-derived zone (roadmap
  // item 3) is independent of `boundary` and still arrives.
  assert.deepEqual(model.subModelParts.map((p) => p.name), ["Element3D8N"]);
  assert.ok(
    model.diagnostics.some((d) => /boundary is missing/.test(d.message)),
    "the loss is reported rather than silent"
  );
});

test("a missing REQUIRED polyMesh file fails by name", async () => {
  // Without this the failure is an FS.ErrnoError whose message is undefined.
  const marker = await writeCase();
  fs.unlinkSync(polyMesh(marker, "owner"));
  await assert.rejects(parseMeshFile(marker), /owner/);
});

// A dictionary in the exact shape and location OpenFOAM writes, for a zone
// nothing in this repo produces — the writer emits six files and no fixture
// has ever carried a seventh.
const cellZonesDict = (name: string): Uint8Array =>
  new Uint8Array(
    Buffer.from(
      [
        "FoamFile",
        "{",
        "    version     2.0;",
        "    format      ascii;",
        "    class       regIOobject;",
        '    location    "constant/polyMesh";',
        "    object      cellZones;",
        "}",
        "",
        "1",
        "(",
        name,
        "{",
        "    type cellZone;",
        "    cellLabels      List<label>",
        "1",
        "(",
        "0",
        ")",
        ";",
        "}",
        ")",
        "",
      ].join("\n"),
      "utf8"
    )
  );

test("cellZones cross the reader as named Cell regions since 11.4.0", async () => {
  // Tier B2 closed the gap this used to pin: zone files round-trip as named
  // `Region`s instead of being silently deleted as stale companions. This
  // hands the reader the files directly rather than going through
  // `collectOpenFoamCase` (see the "zones stage through a real case" test
  // below for that path, now wired up — roadmap item 3).
  //
  // The wasm carries the three literals `cellZones`/`faceZones`/`pointZones`
  // in its data segment with no accompanying format string, adjacent to CGNS
  // names by linker string-merge — and the openfoam WRITER has its own
  // "removed stale {}" message — so static inspection cannot say which side
  // owns them. Only this can.
  const { readMeshioModel } = await import("../parser/meshio");
  const { writeMeshFileAsync } = await import("../parser/writers/meshWriter");
  const { companions } = await writeMeshFileAsync(hexModel(), ".foam", { name: "run" });
  // The writer's own synthetic block zone is not the probe: drop it so the
  // only zone in play is the one this test stages by hand.
  const base = companions
    .filter((c) => c.name !== "constant/polyMesh/cellZones")
    .map((c) => ({ name: c.name, data: c.data }));

  const control = await readMeshioModel("run.foam", base, ".foam");
  assert.ok(!control.subModelParts.some((p) => p.name === "probeZone"));

  const withZone = await readMeshioModel(
    "run.foam",
    [...base, { name: "constant/polyMesh/cellZones", data: cellZonesDict("probeZone") }],
    ".foam"
  );
  const probe = withZone.subModelParts.find((p) => p.name === "probeZone");
  assert.ok(probe, `expected probeZone, got ${withZone.subModelParts.map((p) => p.name)}`);
  assert.deepEqual(Array.from(probe.elementIds), [1], "the zone claims the volume cell");

  for (const zone of ["faceZones", "pointZones"]) {
    const staged = await readMeshioModel(
      "run.foam",
      [...base, { name: `constant/polyMesh/${zone}`, data: cellZonesDict("probeZone") }],
      ".foam"
    );
    assert.equal(staged.nodeCount, control.nodeCount, `${zone} leaves the mesh intact`);
  }
});

test("zones stage through a real case (roadmap item 3): collectOpenFoamCase now reads cellZones too", async () => {
  // The write side already emits a `cellZones` companion from the block
  // Cell regions (openfoamWrite.ts) — writeCase()'s case therefore already
  // carries one, and this is the gate for whether the READ side (the
  // extension's own collector, not readMeshioModel called directly as
  // above) now actually stages and surfaces it as a SubModelPart, closing
  // the "still stages only the mesh files" gap the test above used to name.
  const marker = await writeCase();
  assert.ok(fs.existsSync(polyMesh(marker, "cellZones")), "the writer left a cellZones file to find");
  const model = await parseMeshFile(marker);
  const zonePart = model.subModelParts.find((p) => p.elementIds.length > 0 && p.name !== "defaultFaces");
  assert.ok(zonePart, `expected a zone-derived part, got ${model.subModelParts.map((p) => p.name)}`);
  assert.deepEqual(Array.from(zonePart!.elementIds), [1], "the zone claims the one volume cell");

  // A case with no zone files at all must not fail or warn about their
  // absence — see OPENFOAM_ZONE_FILES' own doc comment.
  fs.unlinkSync(polyMesh(marker, "cellZones"));
  const clean = await parseMeshFile(marker);
  assert.ok(!clean.diagnostics.some((d) => /cellZones|zone/i.test(d.message)));
});

test("the staged polyMesh directory IS the one the reader opens", async () => {
  // Without this the test above proves nothing: "the extra file changed
  // nothing" and "the extra file was never anywhere the reader looked" are the
  // same observation. Corrupting a file the reader definitely does read, in
  // the very directory the zone file was placed in, separates them.
  const { readMeshioModel } = await import("../parser/meshio");
  const { writeMeshFileAsync } = await import("../parser/writers/meshWriter");
  const { companions } = await writeMeshFileAsync(hexModel(), ".foam", { name: "run" });
  const base = companions.map((c) => ({ name: c.name, data: c.data }));
  const garbage = new Uint8Array(Buffer.from("not a foam dictionary {{{ (((\n", "utf8"));
  const swap = (name: string) =>
    base.map((f) => (f.name.endsWith(name) ? { name: f.name, data: garbage } : f));

  const control = await readMeshioModel("run.foam", base, ".foam");
  assert.equal(control.nodeIds.length, 8);
  assert.equal(control.blocks.length, 2, "one volume block and one boundary block");

  // Coordinates come from `points`, so wrecking it empties the mesh.
  const noPoints = await readMeshioModel("run.foam", swap("points"), ".foam");
  assert.equal(noPoints.nodeIds.length, 0, "the reader really opened the staged points");

  // Patch ranges come from `boundary`, so wrecking it drops the six faces —
  // note it does NOT throw, which is why a corrupt boundary alone would have
  // been too weak a probe.
  const noBoundary = await readMeshioModel("run.foam", swap("boundary"), ".foam");
  const cells = noBoundary.blocks.reduce((n, b) => n + b.entityIds.length, 0);
  assert.equal(cells, 1, "only the volume cell survives without a readable boundary");
});

test("staging honours a subdirectory name, with no .foam involved", async () => {
  // Guards stageFiles directly: the staging root moved from "/" to /mio_in and
  // names may now carry directories.
  const off = "OFF\n3 1 0\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n";
  const model = await readMeshioModel(
    "sub/dir/s.off",
    [{ name: "sub/dir/s.off", data: new TextEncoder().encode(off) }],
    ".off"
  );
  assert.equal(model.nodeCount, 3);
});
