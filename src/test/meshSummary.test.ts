/**
 * The summary must never disagree with the parse.
 *
 * Every summarizer is checked against `parseMeshFile`/`parseMdpaFile` on a
 * committed fixture — an "oracle" assertion, because the failure this feature
 * could introduce is not a crash but a quiet lie: a preview that says 12,481
 * nodes for a file that opens with a different number is worse than one that
 * refuses to open it at all.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  shouldSummarize,
  summarizeMeshFile,
  summaryCostFor,
  SUMMARIZABLE_EXTENSIONS,
  SUMMARY_THRESHOLD_MB_DEFAULT,
} from "../parser/meshSummary";
import { parseMeshFile } from "../parser/meshFileParser";
import { parseMdpaFile } from "../parser/mdpaParser";
import { SUPPORTED_MESH_EXTENSIONS } from "../parser/meshFormats";

const ROOT = path.resolve(__dirname, "..", "..");
const ex = (...p: string[]) => path.join(ROOT, "example", ...p);
const fixture = (...p: string[]) => path.join(ROOT, "src", "test", "fixtures", ...p);

const cellTotal = (m: { blocks: { count: number }[] }) =>
  m.blocks.reduce((n, b) => n + b.count, 0);

// ---- The gate ---------------------------------------------------------------

test("shouldSummarize: the threshold, and 0 meaning never", () => {
  const base = { reason: "initial" as const, userForcedFull: false, summaryShown: false };
  assert.equal(shouldSummarize({ ...base, fileSize: 300e6, thresholdMb: 250 }), true);
  assert.equal(shouldSummarize({ ...base, fileSize: 10e6, thresholdMb: 250 }), false);
  // >= so the setting's own prose ("larger than this many megabytes") holds at
  // the boundary rather than being off by one byte.
  assert.equal(shouldSummarize({ ...base, fileSize: 250 * 1024 * 1024, thresholdMb: 250 }), true);
  // 0 disables it; NaN/negative must not accidentally summarize EVERYTHING.
  assert.equal(shouldSummarize({ ...base, fileSize: 1e12, thresholdMb: 0 }), false);
  assert.equal(shouldSummarize({ ...base, fileSize: 1e12, thresholdMb: NaN }), false);
  assert.equal(shouldSummarize({ ...base, fileSize: 1e12, thresholdMb: -5 }), false);
});

test("shouldSummarize: a reload never changes mode, in either direction", () => {
  // Both halves of the safety property. A solver's growing output must not flip
  // a live preview into a summary...
  assert.equal(
    shouldSummarize({
      fileSize: 1e12, thresholdMb: 250, reason: "reload",
      userForcedFull: false, summaryShown: false,
    }),
    false,
    "a growing file does not flip a loaded preview into a summary"
  );
  // ...and a summarized 4 GB file must not silently become a full parse on some
  // later watcher tick and hang the window.
  assert.equal(
    shouldSummarize({
      fileSize: 10, thresholdMb: 250, reason: "reload",
      userForcedFull: false, summaryShown: true,
    }),
    true,
    "a summarized file stays summarized across a reload"
  );
});

test("shouldSummarize: the user's choice outranks everything", () => {
  for (const reason of ["initial", "reload"] as const) {
    assert.equal(
      shouldSummarize({
        fileSize: 1e12, thresholdMb: 1, reason,
        userForcedFull: true, summaryShown: true,
      }),
      false,
      `Open full mesh anyway survives a ${reason}`
    );
  }
});

test("summaryCostFor classifies every summarizable extension", () => {
  // A new supported extension with no cost class fails here rather than
  // silently defaulting in the UI.
  for (const e of SUMMARIZABLE_EXTENSIONS) {
    const c = summaryCostFor(`/a/m${e}`);
    assert.ok(
      ["header", "scan", "buffered", "read"].includes(c),
      `${e} has a cost class (${c})`
    );
  }
  assert.deepEqual(
    [...SUPPORTED_MESH_EXTENSIONS].filter((e) => !SUMMARIZABLE_EXTENSIONS.includes(e)),
    [],
    "every supported extension can be summarized"
  );
  assert.equal(summaryCostFor("/a/m.mdpa"), "scan", "MDPA declares no counts");
  assert.equal(summaryCostFor("/a/m.vtu"), "header");
  assert.equal(summaryCostFor("/a/m.msh"), "buffered", "gmsh has a header reader");
  assert.equal(summaryCostFor("/a/m.exo"), "read", "Exodus falls back to a full read");
  assert.equal(summaryCostFor("/a/case.post.msh"), "buffered", "compound extension resolves");
});

// ---- Oracle assertions ------------------------------------------------------

test("VTK XML: counts match the parser, from attributes alone", async () => {
  for (const f of ["house.vtu", "house_compressed_appended.vtu"]) {
    const p = ex("VTK-XML", f);
    const s = await summarizeMeshFile(p);
    const m = await parseMeshFile(p);
    assert.equal(s.nodeCount, m.nodeCount, `${f} nodes`);
    assert.equal(s.cellCount, cellTotal(m), `${f} cells`);
    assert.ok(s.unknown.includes("cell types"), `${f} admits it cannot name cell types`);
  }
});

test("PolyData reports the cells the file DECLARES, and says they expand", async () => {
  // outline.vtp declares 1 line + 2 polys = 3 cells, and opens as 6: a
  // poly-line fans into segments and a polygon into triangles
  // (buildBlocksFromOffsets). The header cannot know by how much without the
  // payload, so it reports what is written and flags the expansion instead of
  // quietly disagreeing with the mesh the user then opens.
  const p = ex("VTK-XML", "outline.vtp");
  const s = await summarizeMeshFile(p);
  const m = await parseMeshFile(p);
  assert.equal(s.nodeCount, m.nodeCount, "points are exact either way");
  assert.equal(s.cellCount, 3, "as declared");
  assert.ok(cellTotal(m) > s.cellCount!, "and the opened mesh has more");
  assert.ok(
    s.notes.some((n) => /expand/.test(n)),
    "the expansion is stated, not silent"
  );
});

test("an appended VTU is summarized without reading its payload", async () => {
  // The assertion the whole "header" cost class rests on: if this ever reads
  // the whole file, the class is a lie.
  const s = await summarizeMeshFile(ex("VTK-XML", "house_compressed_appended.vtu"));
  assert.equal(s.cost, "header");
  assert.ok(s.bytesRead < s.fileSize, `read ${s.bytesRead} of ${s.fileSize}`);
});

test("structured VTK XML derives its counts from the extent", async () => {
  for (const f of ["volume.vti", "sheet.vts", "grid.vtr"]) {
    const p = ex("VTK-XML", f);
    const s = await summarizeMeshFile(p);
    const m = await parseMeshFile(p);
    assert.equal(s.nodeCount, m.nodeCount, `${f} nodes`);
    assert.equal(s.cellCount, cellTotal(m), `${f} cells`);
    assert.ok(s.extent, `${f} reports its extent`);
  }
});

test("legacy VTK: both flavours count from the keyword header", async () => {
  for (const f of ["house_binary.vtk", "Main_0_2.vtk"]) {
    const p = ex("VTK", f);
    const s = await summarizeMeshFile(p);
    const m = await parseMeshFile(p);
    assert.equal(s.nodeCount, m.nodeCount, `${f} nodes`);
    assert.equal(s.cellCount, cellTotal(m), `${f} cells`);
  }
  // The binary one is a genuine header read; the keyword lines are ascii even
  // there, which is what lets one code path serve both.
  const bin = await summarizeMeshFile(ex("VTK", "house_binary.vtk"));
  assert.equal(bin.cost, "header");
  assert.ok(bin.bytesRead < bin.fileSize);
});

test("binary STL answers from byte 80, ascii STL by scanning", async () => {
  const bin = await summarizeMeshFile(ex("Geometry", "pyramid.stl"));
  const binModel = await parseMeshFile(ex("Geometry", "pyramid.stl"));
  assert.equal(bin.cellCount, cellTotal(binModel));
  assert.equal(bin.cost, "header");
  assert.equal(bin.bytesRead, 84, "the facet count is the first 84 bytes and nothing else");

  const asc = await summarizeMeshFile(ex("Geometry", "pyramid_ascii.stl"));
  const ascModel = await parseMeshFile(ex("Geometry", "pyramid_ascii.stl"));
  assert.equal(asc.cellCount, cellTotal(ascModel));
  assert.equal(asc.cost, "scan");
  // STL repeats every vertex per facet, so a node count is a property of
  // welding rather than of the file — say so instead of guessing.
  assert.ok(asc.unknown.includes("node count"));
});

test("PLY reports its declared elements and vertex properties", async () => {
  const p = ex("Geometry", "roof.ply");
  const s = await summarizeMeshFile(p);
  const m = await parseMeshFile(p);
  assert.equal(s.nodeCount, m.nodeCount);
  assert.equal(s.cellCount, cellTotal(m));
  assert.deepEqual(s.pointDataNames, ["x", "y", "z", "quality"]);
  assert.equal(s.cost, "header");
  assert.ok(s.bytesRead < s.fileSize);
});

test("OBJ counts its keyword lines", async () => {
  const p = ex("Geometry", "hut.obj");
  const s = await summarizeMeshFile(p);
  const m = await parseMeshFile(p);
  assert.equal(s.nodeCount, m.nodeCount);
  assert.equal(s.cellCount, cellTotal(m));
  assert.equal(s.cost, "scan");
});

test("a .vtm is summarized as the index it is, and says what it left out", async () => {
  const s = await summarizeMeshFile(fixture("vtk", "multiblock", "scene.vtm"));
  assert.equal(s.children?.length, 2);
  assert.ok(s.unknown.includes("per-block counts"), "it does not open the children");
  assert.equal(s.nodeCount, undefined, "and does not invent a count");
});

test("MDPA: block scan matches a full parse", async () => {
  const p = ex("MDPA", "portal_frame.mdpa");
  const s = await summarizeMeshFile(p);
  const m = await parseMdpaFile(p);
  assert.equal(s.nodeCount, m.nodeCount, "nodes");
  assert.equal(s.cellCount, cellTotal(m), "cells");
  for (const b of m.blocks) {
    const got = s.blocks.find((x) => x.type === b.name);
    assert.ok(got, `block ${b.name} is named`);
    assert.equal(got.count, b.count, `block ${b.name} count`);
  }
  assert.equal(s.cost, "scan");
});

test("MDPA: the big fixture agrees with the number mdpaStream already pins", async () => {
  const p = ex("MDPA", "bunny_test_mesh.mdpa");
  const s = await summarizeMeshFile(p);
  assert.equal(s.nodeCount, 13707, "nodeCount");
  const m = await parseMdpaFile(p);
  assert.equal(s.cellCount, cellTotal(m), "cells");
  assert.deepEqual(
    s.regions.map((r) => r.name).sort(),
    m.subModelParts.map((sp) => sp.path).sort(),
    "top-level SubModelParts are named"
  );
});

test("MDPA: a Table nested in Properties is not counted as a block", async () => {
  // The trap door. handleBegin dispatches on the block type alone, so without
  // it a nested Begin Table would surface as a top-level block — and a nested
  // SubModelPart, far worse, as a real part.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "summary-"));
  const p = path.join(dir, "trap.mdpa");
  fs.writeFileSync(
    p,
    [
      "Begin Properties 1",
      "  Begin Table TEMPERATURE VISCOSITY",
      "    100 0.1",
      "    200 0.2",
      "  End Table",
      "End Properties",
      "Begin Nodes",
      " 1 0.0 0.0 0.0",
      " 2 1.0 0.0 0.0",
      " 3 0.0 1.0 0.0",
      "End Nodes",
      "Begin Elements Element2D3N",
      " 1 1 1 2 3",
      "End Elements",
      "",
    ].join("\n")
  );
  const s = await summarizeMeshFile(p);
  const m = await parseMdpaFile(p);
  assert.equal(s.nodeCount, 3);
  assert.equal(s.nodeCount, m.nodeCount);
  assert.deepEqual(s.blocks.map((b) => b.type), ["Element2D3N"], "the Table is not a block");
  assert.equal(s.regions.length, 0, "and no phantom SubModelPart appeared");
});

test("meshio formats are summarized, and admit what they cost", async () => {
  const p = fixture("exodus", "seacas.exo");
  const s = await summarizeMeshFile(p);
  const m = await parseMeshFile(p);
  assert.equal(s.nodeCount, m.nodeCount);
  // Exodus has no header-only reader upstream, so this is honest about having
  // paid full price rather than claiming a header read.
  assert.equal(s.cost, "read");
  assert.match(s.method, /fell back to a full read/);
});

test("every summary survives the trip to the webview as JSON", async () => {
  // It crosses postMessage, where an undefined array element or a Map would be
  // silently dropped.
  for (const p of [ex("VTK-XML", "house.vtu"), ex("MDPA", "portal_frame.mdpa"), ex("Geometry", "roof.ply")]) {
    const s = await summarizeMeshFile(p);
    assert.deepEqual(JSON.parse(JSON.stringify(s)), s, p);
  }
});

test("an OpenFOAM case is sized by its polyMesh, not its 0-byte marker", async () => {
  // Left unfixed this defeats the whole feature: the marker compares as 0, so
  // a 4 GB case could never trip the threshold.
  const { writeMeshFileAsync } = await import("../parser/writers/meshWriter");
  const { parseMdpa } = await import("../parser/mdpaParser");
  const model = parseMdpa(
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foam-summary-"));
  const marker = path.join(dir, "run.foam");
  const { data, companions } = await writeMeshFileAsync(model, ".foam", { name: "run" });
  fs.writeFileSync(marker, data);
  for (const c of companions) {
    const p2 = path.join(dir, c.name);
    fs.mkdirSync(path.dirname(p2), { recursive: true });
    fs.writeFileSync(p2, c.data);
  }
  assert.equal(fs.statSync(marker).size, 0, "the marker really is empty");

  const s = await summarizeMeshFile(marker);
  assert.equal(s.ext, ".foam");
  assert.ok(s.fileSize > 0, "sized by constant/polyMesh, not the marker");
  assert.equal(s.cost, "read", "openfoam has no header-only reader");
  assert.ok(s.blocks.some((b) => b.type === "hexahedron"));

  // And the gate can now actually fire for it.
  assert.equal(
    shouldSummarize({
      fileSize: s.fileSize, thresholdMb: 0.000001,
      reason: "initial", userForcedFull: false, summaryShown: false,
    }),
    true
  );
});

test("the default threshold is a number the manifest can agree with", () => {
  assert.equal(typeof SUMMARY_THRESHOLD_MB_DEFAULT, "number");
  assert.ok(SUMMARY_THRESHOLD_MB_DEFAULT > 0);
});
