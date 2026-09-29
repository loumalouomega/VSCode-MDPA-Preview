import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  IN_FILE_PROBE_EXTENSIONS,
  IN_FILE_TIMELINE_EXTENSIONS,
  TIMELINE_EXTENSIONS,
  SUPPORTED_MESH_EXTENSIONS,
  timelineKindFor,
  timelineWatchGlob,
} from "../parser/meshFormats";
import { gmshTimeValues, parseMeshFile, probeInFileSteps, readMeshTimeSteps } from "../parser/meshFileParser";
import { discoverSeriesFiles, discoverSeriesSteps, collectFieldSeries } from "../parser/fieldSeriesScan";

const FIXTURES = path.join(__dirname, "..", "..", "src", "test", "fixtures");
const TRANSIENT = path.join(FIXTURES, "transient");

const tri = (x: number) =>
  `Begin Properties 0\nEnd Properties\nBegin Nodes\n1 0 0 0\n2 ${x} 0 0\n3 0 1 0\nEnd Nodes\n` +
  `Begin Elements Element2D3N\n1 0 1 2 3\nEnd Elements\n`;

test("every supported extension resolves to exactly one timeline kind, and the probe list is disjoint", () => {
  for (const e of [...SUPPORTED_MESH_EXTENSIONS, ".mdpa"]) {
    const inFile = IN_FILE_TIMELINE_EXTENSIONS.includes(e);
    const filename = TIMELINE_EXTENSIONS.includes(e);
    assert.ok(inFile !== filename, `${e} must be in-file XOR filename series`);
  }
  for (const e of IN_FILE_PROBE_EXTENSIONS) {
    assert.ok(TIMELINE_EXTENSIONS.includes(e), `${e} stays a filename series`);
    assert.ok(!IN_FILE_TIMELINE_EXTENSIONS.includes(e), `${e} is probed, not in-file by name`);
  }
});

test(".mdpa is a filename series with a watcher limited to .mdpa siblings", () => {
  assert.equal(timelineKindFor("case_0_1.mdpa"), "filename");
  assert.equal(timelineWatchGlob("case_0_1.mdpa"), "*.mdpa");
  // An MDPA in a VTK folder must not widen the VTK watcher.
  assert.ok(!timelineWatchGlob("run_0_1.vtu")!.includes("mdpa"));
});

test("an MDPA series is discovered in numeric order and every step parses", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdpa-series-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const step of [10, 2, 3]) fs.writeFileSync(path.join(dir, `Main_0_${step}.mdpa`), tri(step));
  const opened = path.join(dir, "Main_0_2.mdpa");
  const files = await discoverSeriesFiles(opened);
  assert.deepEqual(files.map((f) => f.label), ["2", "3", "10"]);
  const { steps, source } = await discoverSeriesSteps(opened);
  assert.equal(source, "files");
  const models = await Promise.all(steps.map((s) => s.load!()));
  assert.deepEqual(models.map((m) => m.coords[3]), [2, 3, 10]);
  assert.equal((await parseMeshFile(opened)).nodeCount, 3);
  // A lone MDPA is a single static step.
  const lone = path.join(dir, "solo.mdpa");
  fs.writeFileSync(lone, tri(1));
  assert.equal((await discoverSeriesSteps(lone)).source, "single");
});

test("gmshTimeValues counts distinct ASCII data-section times and refuses binary/non-gmsh", () => {
  const two = fs.readFileSync(path.join(TRANSIENT, "two-step.msh"), "latin1");
  assert.deepEqual(gmshTimeValues(two), [0, 1]);
  assert.deepEqual(gmshTimeValues(two.replace("2.2 0 8", "2.2 1 8")), []);
  assert.deepEqual(gmshTimeValues("not gmsh at all"), []);
  const section = (name: string, t: number) => `$NodeData\n1\n"${name}"\n1\n${t}\n3\n0\n1\n3\n1 1\n2 2\n3 3\n$EndNodeData\n`;
  const head = two.slice(0, two.indexOf("$NodeData"));
  const multi = head + [section("T", 0), section("P", 0), section("T", 0.5), section("P", 0.5)].join("");
  assert.deepEqual(gmshTimeValues(multi), [0, 0.5]);
});

test("two-step.msh and two-step.frd are probed as in-file timelines; a plain .msh falls back to filenames", async () => {
  const msh = path.join(TRANSIENT, "two-step.msh");
  assert.deepEqual(await readMeshTimeSteps(msh), [0, 1]);
  const a = await discoverSeriesSteps(msh);
  assert.equal(a.source, "inFile");
  assert.equal(a.steps.length, 2);
  const frd = path.join(TRANSIENT, "two-step.frd");
  assert.equal((await probeInFileSteps(frd)).length, 3);
  const b = await discoverSeriesSteps(frd);
  assert.equal(b.source, "inFile");
  assert.equal(b.steps.length, 3);
  // Not a probe format: never probed.
  assert.deepEqual(await probeInFileSteps(path.join(TRANSIENT, "two-step.med")), []);
  // In-file steps are one file: nothing to pack as a filename series.
  assert.deepEqual(await discoverSeriesFiles(msh), []);
});

test("the in-file gmsh steps carry distinct data through the series scan", async () => {
  const msh = path.join(TRANSIENT, "two-step.msh");
  const { steps } = await discoverSeriesSteps(msh);
  const series = await collectFieldSeries(steps, { kind: "Nodal", variable: "TEMP", entityId: 1 });
  assert.deepEqual(series.values, [[10], [40]]);
});
