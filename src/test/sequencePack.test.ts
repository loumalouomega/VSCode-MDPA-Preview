import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { packXdmfSeries, PackStep } from "../parser/meshio";
import { packPvdSeries, pvdIndexText as packPvdText } from "../parser/packPvd";
import { readMeshTimeSteps, parseMeshFile } from "../parser/meshFileParser";
import {
  collectFieldSeries,
  discoverSeriesFiles,
  discoverSeriesSteps,
  packStepsFromFiles,
  packStepsFromInFile,
  seriesFilesInDir,
} from "../parser/fieldSeriesScan";
import { writeMeshFileAsync } from "../parser/writers/meshWriter";
import { parseMdpa } from "../parser/mdpaParser";
import { parsePvdIndex } from "../parser/pvdIndex";
import { timelineKindFor, VTK_XML_EXTENSIONS } from "../parser/meshFormats";

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

// ---- .pvd: the container for a series that changes topology (roadmap item 20)

/** Writes a pack's index + step files the way both hosts must. */
function writePvdOut(
  dir: string,
  name: string,
  r: { data: Uint8Array; pieces: { name: string; data: Uint8Array }[] }
): string {
  const stem = path.basename(name, ".pvd");
  fs.mkdirSync(path.join(dir, stem), { recursive: true });
  for (const p of r.pieces) fs.writeFileSync(path.join(dir, stem, p.name), p.data);
  const dest = path.join(dir, name);
  fs.writeFileSync(dest, r.data);
  return dest;
}

/** A mesh whose node count differs from the one before it. */
function growingMdpa(n: number, temps: number[]): string {
  const pts: string[] = [];
  for (let i = 1; i <= n; i++) pts.push(`${i} ${i} 0 0`);
  const els: string[] = [];
  for (let e = 1; e * 3 + 3 <= n; e++) els.push(`${e} 0 ${e * 3} ${e * 3 + 1} ${e * 3 + 2}`);
  const data: string[] = [];
  for (let i = 0; i < n; i++) data.push(`${i + 1} ${temps[i]}`);
  return (
    `Begin Nodes\n${pts.join("\n")}\nEnd Nodes\n` +
    `Begin Elements Element3D4N\n${els.join("\n")}\nEnd Elements\n` +
    `Begin NodalData TEMP\n${data.join("\n")}\nEnd NodalData\n`
  );
}

const GROWING = [growingMdpa(4, [1, 1, 1, 1]), growingMdpa(7, [1, 1, 1, 1, 2, 2, 2])];
/** PackStep[] for the growing pair, in the shape a .pvd pack receives them. */
const growingSteps = (): PackStep[] =>
  GROWING.map((src, i) => ({ name: `Main_0_${i}.vtu`, time: i * 10, read: async () => parseMdpa(src) }));

test("a .pvd pack reuses a VTK-XML step's bytes and re-writes anything else", async () => {
  const dir = tmpDir();
  const files = await discoverSeriesFiles(path.join(VTK_DIR, "Main_0_2.vtk"));
  // The default byte policy is the XDMF one; the .pvd policy is VTK XML only,
  // because it writes each piece itself and cannot re-read a legacy file.
  const copied = await packPvdSeries(packStepsFromFiles(files, { byteFormats: VTK_XML_EXTENSIONS }), {
    stem: "solve",
  });
  assert.equal(copied.steps, 3);
  assert.equal(copied.copied, 0, "a legacy .vtk is not VTK XML, so all three are re-written");
  assert.deepEqual(copied.times, [2, 4, 6], "the step LABELS become the times");
  for (const piece of copied.pieces) {
    assert.match(piece.name, /^frame_\d{6}\.vtu$/);
    assert.equal(piece.sourceExtension, ".vtk");
  }

  // The same series already in VTK XML is copied byte for byte.
  const xmlDir = tmpDir();
  for (const [i, name] of ["Main_0_2.vtk", "Main_0_4.vtk", "Main_0_6.vtk"].entries()) {
    const model = await parseMeshFile(path.join(VTK_DIR, name));
    fs.writeFileSync(
      path.join(xmlDir, `Run_0_${i}.vtu`),
      (await writeMeshFileAsync(model, ".vtu")).data
    );
  }
  const reused = await packPvdSeries(
    packStepsFromFiles(await discoverSeriesFiles(path.join(xmlDir, "Run_0_1.vtu")), {
      byteFormats: VTK_XML_EXTENSIONS,
    }),
    { stem: "solve" }
  );
  assert.equal(reused.copied, 3, "every step was already VTK XML");
  for (const piece of reused.pieces) {
    assert.match(piece.name, /\.vtu$/);
    assert.equal(piece.copied, true);
  }
  // A copy really is the same bytes.
  assert.deepEqual(
    reused.pieces[0].data,
    fs.readFileSync(path.join(xmlDir, "Run_0_0.vtu"))
  );
});

test("a .pvd index points at its own step directory, one escaped path and all", () => {
  const text = packPvdText([
    { timestep: 0, file: "solve/frame_000000.vtu" },
    { timestep: 4, file: "solve/frame_000001.vtu" },
  ]);
  assert.match(text, /type="Collection"/);
  assert.match(text, /<DataSet timestep="0" group="" part="0" file="solve\/frame_000000\.vtu"\/>/);
  assert.match(text, /<DataSet timestep="4"/);
  // The index is XML-escaped, because a stem is a user's name — and what makes
  // that worth asserting is not the text but that the reader still gets the
  // original path back out of it, `>` included (the reader's tokenizer ends a
  // tag at the first literal `>`, so an unescaped one would drop the element).
  const awkward = `a&b<c>"d>e/frame_000000.vtu`;
  const escaped = packPvdText([{ timestep: 0, file: awkward }]);
  assert.match(escaped, /file="a&amp;b&lt;c&gt;&quot;d&gt;e\/frame_000000\.vtu"/);
  assert.deepEqual(
    parsePvdIndex(Buffer.from(escaped, "utf8")).map((e) => e.file),
    [awkward]
  );
});

test("a series whose mesh changes between steps packs to .pvd and reads back per step", async () => {
  // The case item 20 exists for. The SAME series is refused by the XDMF packer,
  // whose single grid cannot represent it.
  await assert.rejects(
    packXdmfSeries(growingSteps(), { stem: "bad" }),
    /pack it as \.pvd instead/
  );

  const dir = tmpDir();
  const dest = writePvdOut(dir, "adaptive.pvd", await packPvdSeries(growingSteps(), { stem: "adaptive" }));

  // The index is a light file the extension reads natively: the result is an
  // in-file timeline without a byte of meshio++ involvement.
  assert.equal(timelineKindFor(dest), "in-file");
  assert.deepEqual(await readMeshTimeSteps(dest), [0, 10]);

  // Each step carries its OWN counts, which is the whole point.
  const first = await parseMeshFile(dest, undefined, { timeStep: 0 });
  const second = await parseMeshFile(dest, undefined, { timeStep: 1 });
  assert.equal(first.nodeCount, 4);
  assert.equal(second.nodeCount, 7);
  assert.equal(first.fields.find((f) => f.variable === "TEMP")!.values.length, 4);
  assert.equal(second.fields.find((f) => f.variable === "TEMP")!.values.length, 7);
  assert.equal(second.fields.find((f) => f.variable === "TEMP")!.values[6], 2);
});

test("a packed .pvd drives the field series, reporting where the mesh changed", async () => {
  // The acceptance clause: the in-file timeline, mesh_field_series and the
  // Plot over time all work on the result, with topologyChangedAt reported.
  const dir = tmpDir();
  const dest = writePvdOut(dir, "adaptive.pvd", await packPvdSeries(growingSteps(), { stem: "adaptive" }));
  const { steps, source } = await discoverSeriesSteps(dest);
  assert.equal(source, "inFile");
  const series = await collectFieldSeries(steps, {
    kind: "Nodal",
    variable: "TEMP",
    entityId: 1,
  });
  assert.deepEqual(series.labels, ["0", "10"]);
  assert.equal(series.topologyChangedAt, 1, "the id may not be the same entity after the change");
  assert.equal(series.missingId, 0, "node 1 exists in both steps");
});

test("a .pvd pack refuses bytes it cannot use, and empty input", async () => {
  await assert.rejects(
    packPvdSeries(
      [
        {
          name: "Main_0_0.vtk",
          time: 0,
          // The default policy hands a legacy .vtk over as bytes; a container
          // that writes its own piece has nothing to do with them.
          read: async () => fs.promises.readFile(path.join(VTK_DIR, "Main_0_2.vtk")),
        },
      ],
      { stem: "solve" }
    ),
    /handed over as raw bytes/
  );
  await assert.rejects(packPvdSeries([], { stem: "empty" }), /No steps to pack/);
});

test("a .pvd pack stops between steps when cancelled, and never publishes", async () => {
  const abort = new AbortController();
  const seen: number[] = [];
  await assert.rejects(
    packPvdSeries(growingSteps(), {
      stem: "cancel",
      signal: abort.signal,
      onProgress: (done) => {
        seen.push(done);
        if (done === 1) abort.abort();
      },
    }),
    (err: Error) => err.name === "AbortError" || /abort/i.test(err.message)
  );
  assert.deepEqual(seen, [1], "it stopped after the first step, not after all of them");
});

test("a static series still packs to XDMF by default, and the format guard holds", async () => {
  // The boundary stays: XDMF is the one-file default, and the refusal names the
  // container that can hold the series instead of just saying no.
  const r = await packXdmfSeries(stepsFor(STEP_NAMES), { stem: "solve" });
  assert.equal(r.steps, 3);
  await assert.rejects(packXdmfSeries(growingSteps(), { stem: "bad" }), /pack it as \.pvd instead/);
  // ...and an in-file source is refused for XDMF for a different reason:
  // there are no per-step FILES to combine.
  const dir = tmpDir();
  const xdmf = writeOut(dir, "solve.xdmf", r);
  const pvdSteps = packStepsFromInFile((await discoverSeriesSteps(xdmf)).steps);
  assert.equal(pvdSteps.length, 3);
  assert.equal(pvdSteps[0].name, "step_000000");
  // The same steps DO pack for .pvd, which is the difference the item buys.
  const repacked = writePvdOut(dir, "again.pvd", await packPvdSeries(pvdSteps, { stem: "again" }));
  assert.deepEqual(await readMeshTimeSteps(repacked), [2, 4, 6]);
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
