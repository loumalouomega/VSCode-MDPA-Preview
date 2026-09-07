import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { packXdmfSeries, PackStep } from "../parser/meshio";
import { readMeshTimeSteps, parseMeshFile } from "../parser/meshFileParser";
import { discoverSeriesFiles, seriesFilesInDir } from "../parser/fieldSeriesScan";
import { writeMeshFileAsync } from "../parser/writers/meshWriter";
import { parseMdpa } from "../parser/mdpaParser";
import { timelineKindFor } from "../parser/meshFormats";

// The committed Kratos series: Main_0_2 / _4 / _6, already used by
// fieldSeries.test.ts to exercise step discovery.
const VTK_DIR = path.resolve(__dirname, "../../example/VTK");
const STEP_NAMES = ["Main_0_2.vtk", "Main_0_4.vtk", "Main_0_6.vtk"];

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "seq-pack-"));
}

function stepsFor(names: string[], times?: number[]): PackStep[] {
  return names.map((n, i) => ({
    name: n,
    time: times ? times[i] : Number(n.replace(/^.*_/, "").replace(/\.\w+$/, "")),
    read: async () => fs.promises.readFile(path.join(VTK_DIR, n)),
  }));
}

/** Writes a pack result out the way both callers must: file + companions. */
function writeOut(dir: string, name: string, r: { data: Uint8Array; companions: { name: string; data: Uint8Array }[] }): string {
  const dest = path.join(dir, name);
  fs.writeFileSync(dest, r.data);
  for (const c of r.companions) fs.writeFileSync(path.join(dir, c.name), c.data);
  return dest;
}

test("packXdmfSeries writes one file plus its heavy-data companion", async () => {
  const r = await packXdmfSeries(stepsFor(STEP_NAMES), { stem: "solve" });
  assert.equal(r.steps, 3);
  // XDMF splits light from heavy: the .xdmf is small XML, the arrays are in the
  // .h5, and an .xdmf written without it is unreadable.
  assert.equal(r.companions.length, 1);
  assert.equal(r.companions[0].name, "solve.h5");
  assert.ok(r.data.length > 0 && r.companions[0].data.length > 0);
  // The stem reaches the XML verbatim, which is how the two files find each other.
  assert.match(new TextDecoder().decode(r.data), /solve\.h5/);
});

test("a packed series re-opens here as a timeline, with the Kratos step numbers", async () => {
  const dir = tmpDir();
  const r = await packXdmfSeries(stepsFor(STEP_NAMES), { stem: "solve" });
  const dest = writeOut(dir, "solve.xdmf", r);

  // The round trip is the point: an .xdmf we wrote must be an in-file timeline.
  assert.equal(timelineKindFor(dest), "in-file");
  // Times are the step LABELS (2/4/6), not 0/1/2 — meshio++ reports no
  // timeValues for a temporal collection, so this comes from our own XML scan.
  assert.deepEqual(await readMeshTimeSteps(dest), [2, 4, 6]);

  // Each step must carry its OWN data, or the series is a static frame repeated.
  const totals: number[] = [];
  for (let k = 0; k < 3; k++) {
    const model = await parseMeshFile(dest, undefined, { timeStep: k });
    assert.equal(model.nodeCount, 15);
    const d = model.fields.find((f) => f.variable === "DISPLACEMENT");
    assert.ok(d, `step ${k} lost DISPLACEMENT`);
    totals.push(Array.from(d!.values).reduce((s, v) => s + Math.abs(v), 0));
  }
  assert.equal(new Set(totals.map((t) => t.toFixed(3))).size, 3, `steps identical: ${totals}`);
  // The solve is loading up, so the steps are ordered, not merely different.
  assert.ok(totals[0] < totals[1] && totals[1] < totals[2], `not ordered: ${totals}`);
});

test("a series whose mesh changes between steps is refused by name", async () => {
  // An XDMF temporal collection carries ONE grid, so this cannot be represented
  // and must not be silently written against the first step's mesh.
  await assert.rejects(
    packXdmfSeries(stepsFor(["Main_0_2.vtk", "Main_FixedEdgeNodes_0_2.vtk"], [2, 4]), {
      stem: "bad",
    }),
    /mesh changes between steps/
  );
  await assert.rejects(packXdmfSeries([], { stem: "empty" }), /No steps to pack/);
});

test("series discovery finds the step files from a directory or one member", async () => {
  const fromFile = await discoverSeriesFiles(path.join(VTK_DIR, "Main_0_4.vtk"));
  assert.deepEqual(fromFile.map((f) => f.label), ["2", "4", "6"]);
  assert.deepEqual(
    fromFile.map((f) => path.basename(f.fsPath)),
    STEP_NAMES
  );

  // frameIndex is the position in the GROUP's step list, which is what
  // vtkRequestFrame names — not a renumbering of whatever files were found.
  assert.deepEqual(fromFile.map((f) => f.frameIndex), [0, 1, 2]);

  const fromDir = await seriesFilesInDir(VTK_DIR);
  assert.equal(fromDir.length, 3, "the largest series in the directory");

  // A lone static file is not a series: the caller must be able to say so
  // rather than being handed a one-step "series".
  const solo = tmpDir();
  const lone = path.join(solo, "house.vtk");
  fs.copyFileSync(path.join(VTK_DIR, "house_binary.vtk"), lone);
  assert.deepEqual(await discoverSeriesFiles(lone), []);
  assert.deepEqual(await seriesFilesInDir(solo), []);
});

test("an already-packed series is not itself packable", async () => {
  // It carries its own steps, so there is nothing to combine — discovery must
  // return nothing rather than treating the one file as a one-step series.
  const dir = tmpDir();
  const r = await packXdmfSeries(stepsFor(STEP_NAMES), { stem: "solve" });
  const dest = writeOut(dir, "solve.xdmf", r);
  assert.deepEqual(await discoverSeriesFiles(dest), []);
});

test("a single-mesh .xdmf still opens as one static frame", async () => {
  // .xdmf joining IN_FILE_TIMELINE_EXTENSIONS must not turn every ordinary
  // XDMF export into a one-step "timeline": a file with no <Time> reports no
  // steps, and the provider falls through to the static path on length < 2.
  const dir = tmpDir();
  const model = parseMdpa(
    "Begin Nodes\n1 0 0 0\n2 1 0 0\n3 0 1 0\n4 0 0 1\nEnd Nodes\n" +
      "Begin Elements Element3D4N\n1 0 1 2 3 4\nEnd Elements\n"
  );
  const r = await writeMeshFileAsync(model, ".xdmf", { name: "single" });
  const dest = path.join(dir, "single.xdmf");
  fs.writeFileSync(dest, r.data);
  for (const c of r.companions) fs.writeFileSync(path.join(dir, c.name), c.data);

  assert.deepEqual(await readMeshTimeSteps(dest), []);
  // And it still parses, so nothing about the static path regressed.
  const back = await parseMeshFile(dest);
  assert.equal(back.nodeCount, 4);
});
