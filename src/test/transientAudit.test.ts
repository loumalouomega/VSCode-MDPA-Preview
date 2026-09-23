/** Live WASM audit. Genuine temporal inputs live beside their provenance and
 * structural generator in fixtures/transient; no single-frame negative probes. */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadMeshio, readMeshioModel, writeMeshioBytes } from "../parser/meshio";
import { MESHIO_READ_CANDIDATES } from "../parser/meshioFormats";
import { IN_FILE_TIMELINE_EXTENSIONS } from "../parser/meshFormats";
import { parseMeshFile } from "../parser/meshFileParser";

const DIR = path.resolve(__dirname, "../../src/test/fixtures/transient");

async function staged() {
  const m = await loadMeshio();
  for (const name of fs.readdirSync(DIR)) {
    if (/\.(med|cgns|h5m|tec|msh|case|geo|frd|vtkhdf)$/.test(name)) {
      m.FS.writeFile(`/${name}`, fs.readFileSync(path.join(DIR, name)));
    }
  }
  return m;
}

test("audit covers every registered reader's live options capability", async () => {
  const m = await loadMeshio();
  // Tier B1 (11.3.0) made cgns/ensight/tecplot options-aware alongside the
  // existing five; openfoam reports aware through its own time-directory path.
  // The 15.x bump (roadmap item 3) added frd and vtkhdf as options-aware too.
  // frd is NOT promoted to IN_FILE_TIMELINE_EXTENSIONS: its own readMetadata
  // falls back to a full read (see the "frd stays a filename series" test
  // below). vtkhdf IS promoted — see the multi-step cgns/tecplot/vtkhdf loop
  // below and fixtures/transient/generate-vtkhdf.mjs; the fixture is a real
  // multi-step file written by the wasm's own sequenceToTimeseries, not
  // "unmeasured" as an earlier pass of this comment claimed.
  // Step 4b (roadmap item 3) routed pvtu/pvtp for reading (a static
  // partitioned dataset, not a time series): both are options-aware too
  // (measured — readerSupportsOptions is true for each), which is exactly
  // what piece/dropGhosts ride on, but neither joins
  // IN_FILE_TIMELINE_EXTENSIONS — a .pvtu/.pvtp has no time concept at all,
  // only pieces.
  const optionsAware = new Set([
    "cgns", "ensight", "exodus", "frd", "gid", "gmsh", "med", "openfoam",
    "pvtp", "pvtu", "tecplot", "vtkhdf", "xdmf",
  ]);
  const audited = [
    "abaqus", "ansys", "ansysinp", "avsucd", "cgns", "dex", "dolfin", "ensight",
    "exodus", "flac3d", "flux", "frd", "freefem", "gid", "gmsh", "h5m", "hmf",
    "ip", "lsdyna", "med", "medit", "mff", "mfm", "mphtxt", "nastran", "netgen",
    "off", "openfoam", "pcd", "permas", "pvtp", "pvtu", "su2", "tecplot",
    "tetgen", "triangle", "ugrid", "unv", "vtkhdf", "wkt", "xdmf", "xyz",
  ].sort();
  const readers = [...new Set(Object.values(MESHIO_READ_CANDIDATES).flat())].sort();
  assert.deepEqual(readers, audited, "new reader keys require a temporal audit");
  for (const format of readers) {
    assert.equal(m.readerSupportsOptions(format), optionsAware.has(format), format);
  }
});

test("multi-step MED enumerates [0, 1] from a native metadata scan", async () => {
  // Tier B1 (11.3.0): `read_med_metadata` reports the sorted, deduplicated
  // union of every field's own step times with no full read, so `.med`
  // qualifies for an in-file timeline. A strict step-0 select still throws —
  // timeStep 0 is upstream's "default", so the multi-timestep field demands
  // either a non-default step or leniency — and the application's lenient
  // retry is what makes step 0 land on the first step.
  const m = await staged();
  const md = m.readMetadata("/two-step.med", "med");
  assert.deepEqual(md.timeValues, [0, 1]);
  assert.equal(md.fellBackToFullRead, false);
  for (const [timeStep, values] of [[0, [10, 20, 30]], [1, [40, 50, 60]]] as const) {
    const raw = m.readMeshSelective("/two-step.med", { format: "med", timeStep, lenient: true });
    assert.deepEqual([...(raw.point_data!.TEMP as Float64Array)], values);
    // The application's lenient retry must select the same real step.
    const model = await parseMeshFile(path.join(DIR, "two-step.med"), undefined, { timeStep });
    assert.deepEqual([...model.fields.find((f) => f.variable === "TEMP")!.values], values);
  }
  assert.ok(IN_FILE_TIMELINE_EXTENSIONS.includes(".med"));
});

for (const [ext, format] of [
  ["cgns", "cgns"],
  ["tec", "tecplot"],
  ["vtkhdf", "vtkhdf"],
] as const) {
  test(`multi-step ${format}: native metadata enumerates [0, 1] and selection is distinct`, async () => {
    // Tier B1 (11.3.0): CGNS honours timeStep via Base/ZoneIterativeData (or
    // warns naming both writers of a doubly-written array when there is no
    // iterative data); Tecplot scans every ZONE header for SOLUTIONTIME /
    // STRANDID. Both report Zone_t/dimension natively with no full read.
    const m = await staged();
    const name = `/two-step.${ext}`;
    const md = m.readMetadata(name, format);
    assert.deepEqual(md.timeValues, [0, 1]);
    assert.equal(md.fellBackToFullRead, false);
    assert.equal(md.numPoints, 3);
    for (const [timeStep, values] of [[0, [10, 20, 30]], [1, [40, 50, 60]]] as const) {
      const raw = m.readMeshSelective(name, { format, timeStep });
      assert.deepEqual([...(raw.point_data!.TEMP as Float64Array)], values);
    }
    assert.ok(IN_FILE_TIMELINE_EXTENSIONS.includes(`.${ext}`));
  });
}

test("multi-step gmsh: selection is distinct via a header pre-scan, but untagged metadata stays empty", async () => {
  // Tier B1 (11.3.0): a non-default timeStep triggers a cheap header-only
  // pre-scan keeping only the sections matching the resolved time — but the
  // fixture's $NodeData sections carry no time tags, so the metadata union is
  // empty and the step count stays undiscoverable before a read. `.msh`
  // therefore stays out of IN_FILE_TIMELINE_EXTENSIONS. (`.dat` is a
  // different reader — tecplot, promoted above — not gmsh.)
  const m = await staged();
  const md = m.readMetadata("/two-step.msh", "gmsh");
  assert.deepEqual(md.timeValues, []);
  for (const [timeStep, values] of [[0, [10, 20, 30]], [1, [40, 50, 60]]] as const) {
    const raw = m.readMeshSelective("/two-step.msh", { format: "gmsh", timeStep });
    assert.deepEqual([...(raw.point_data!.TEMP as Float64Array)], values);
  }
  assert.ok(!IN_FILE_TIMELINE_EXTENSIONS.includes(".msh"));
});

test("H5M time-indexed tags remain separate arrays, without a selectable time axis", async () => {
  const m = await staged();
  const md = m.readMetadata("/two-step.h5m", "h5m");
  assert.deepEqual(md.timeValues, []);
  assert.equal(md.fellBackToFullRead, true);
  for (const timeStep of [0, 1]) {
    const raw = m.readMeshSelective("/two-step.h5m", { format: "h5m", timeStep });
    assert.deepEqual([...raw.point_data!.TEMP_T0], [10, 20, 30]);
    assert.deepEqual([...raw.point_data!.TEMP_T1], [40, 50, 60]);
  }
  assert.ok(!IN_FILE_TIMELINE_EXTENSIONS.includes(".h5m"));
});

test("frd reports non-empty timeValues but falls back to a full read, so it stays a filename series", async () => {
  // meshio++ >= 15.3.0. two-step.frd is CalculiX's own eigenmode output
  // (three PSTEP result blocks — DISP at 3 frequencies), copied verbatim from
  // upstream's own `tests/python/meshes/frd/freq.frd` fixture. Selection is
  // options-aware and genuinely distinct per step, but readMetadata still
  // falls back to a full read to compute it — the admission bar this
  // README/audit applies elsewhere requires `fellBackToFullRead: false`, so
  // frd does not qualify for IN_FILE_TIMELINE_EXTENSIONS despite having a
  // real (if degenerate — two of its three declared times coincide, an
  // artifact of two eigenmodes sharing one frequency) time axis.
  const m = await staged();
  const md = m.readMetadata("/two-step.frd", "frd");
  assert.equal(md.fellBackToFullRead, true);
  assert.equal(md.timeValues.length, 3);
  const steps = [0, 1, 2].map(
    (timeStep) => [...(m.readMeshSelective("/two-step.frd", { format: "frd", timeStep }).point_data!.DISP as Float64Array)]
  );
  // Distinct selection, even though declared times 0 and 1 coincide.
  assert.notDeepEqual(steps[0], steps[1]);
  assert.notDeepEqual(steps[1], steps[2]);
  assert.ok(!IN_FILE_TIMELINE_EXTENSIONS.includes(".frd"));
});

test("lsdyna/pcd/xyz report no options awareness at all (static capability control)", async () => {
  // meshio++ >= 15.1.0 (pcd/xyz) and >= 15.2.0 (lsdyna). None has a temporal
  // concept upstream — pcd/xyz are point clouds with no step axis, lsdyna's
  // keyword deck has no reader-side step selection in this build — so unlike
  // frd/vtkhdf there is nothing here to defer: they are simply not candidates.
  const m = await loadMeshio();
  for (const format of ["lsdyna", "pcd", "xyz"]) {
    assert.equal(m.readerSupportsOptions(format), false, format);
  }
});

test("EnSight rejects a complete transient case even with both valid geometry frames staged", async () => {
  const m = await staged();
  // Positive controls: neither a missing companion nor an invalid geometry
  // file can explain the failure to read the temporal case.
  const frames = [0, 1].map((i) => m.readMesh(`/two-step.000${i}.geo`, "ensight"));
  assert.equal(Math.max(...frames[0].points), 1);
  assert.equal(Math.max(...frames[1].points), 2);
  assert.throws(() => m.readMetadata("/two-step.case", "ensight"), /transient.*not supported/);
  for (const timeStep of [0, 1]) {
    assert.throws(() => m.readMeshSelective("/two-step.case", { format: "ensight", timeStep }), /transient.*not supported/);
  }
  assert.ok(!IN_FILE_TIMELINE_EXTENSIONS.includes(".case"));
});

test("HMF's single-grid schema is not a temporal candidate (static capability control)", async () => {
  const model = await readMeshioModel("a.off", [{ name: "a.off", data: Buffer.from("OFF\n3 1 0\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n") }], ".off");
  const bytes = await writeMeshioBytes(model, ".hmf");
  const m = await loadMeshio();
  m.FS.writeFile("/static.hmf", bytes.data);
  const md = m.readMetadata("/static.hmf", "hmf");
  assert.deepEqual(md.timeValues, []);
  assert.equal(md.fellBackToFullRead, true);
  assert.equal(m.readerSupportsOptions("hmf"), false);
  // This is explicitly a static control, not evidence about a multi-step file.
  assert.ok(!IN_FILE_TIMELINE_EXTENSIONS.includes(".hmf"));
});
