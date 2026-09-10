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
    if (/\.(med|cgns|h5m|tec|msh|case|geo)$/.test(name)) {
      m.FS.writeFile(`/${name}`, fs.readFileSync(path.join(DIR, name)));
    }
  }
  return m;
}

test("audit covers every registered reader's live options capability", async () => {
  const m = await loadMeshio();
  const optionsAware = new Set(["exodus", "gid", "gmsh", "med", "xdmf"]);
  const audited = [
    "abaqus", "ansys", "ansysinp", "avsucd", "cgns", "dex", "dolfin", "ensight",
    "exodus", "flac3d", "flux", "freefem", "gid", "gmsh", "h5m", "hmf", "ip",
    "med", "medit", "mff", "mfm", "mphtxt", "nastran", "netgen", "off", "openfoam",
    "permas", "su2", "tecplot", "tetgen", "triangle", "ugrid", "unv", "wkt", "xdmf",
  ].sort();
  const readers = [...new Set(Object.values(MESHIO_READ_CANDIDATES).flat())].sort();
  assert.deepEqual(readers, audited, "new reader keys require a temporal audit");
  for (const format of readers) {
    assert.equal(m.readerSupportsOptions(format), optionsAware.has(format), format);
  }
});

test("multi-step MED selects distinct fields but metadata fails rather than enumerating", async () => {
  const m = await staged();
  assert.throws(() => m.readMetadata("/two-step.med", "med"), /multi-timestep.*2 steps/);
  for (const [timeStep, values] of [[0, [10, 20, 30]], [1, [40, 50, 60]]] as const) {
    const raw = m.readMeshSelective("/two-step.med", { format: "med", timeStep, lenient: true });
    assert.deepEqual([...raw.point_data!.TEMP], values);
    // The application's lenient retry must select the same real step.
    const model = await parseMeshFile(path.join(DIR, "two-step.med"), undefined, { timeStep });
    assert.deepEqual([...model.fields.find((f) => f.variable === "TEMP")!.values], values);
  }
  assert.ok(!IN_FILE_TIMELINE_EXTENSIONS.includes(".med"));
});

for (const [ext, format, expected] of [
  ["cgns", "cgns", [40, 50, 60]],
  ["tec", "tecplot", [10, 20, 30]],
  ["msh", "gmsh", [10, 20, 30]],
] as const) {
  test(`multi-step ${format}: full-read metadata has no times and selection repeats a frame`, async () => {
    const m = await staged();
    const name = `/two-step.${ext}`;
    const md = m.readMetadata(name, format);
    assert.deepEqual(md.timeValues, []);
    assert.equal(md.fellBackToFullRead, true);
    assert.equal(md.numPoints, 3);
    for (const timeStep of [0, 1]) {
      const raw = m.readMeshSelective(name, { format, timeStep });
      assert.deepEqual([...raw.point_data!.TEMP], expected);
    }
    assert.ok(!IN_FILE_TIMELINE_EXTENSIONS.includes(`.${ext}`));
  });
}

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
