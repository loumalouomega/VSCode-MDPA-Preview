/**
 * Roadmap item 13: in-place save of a single-region OpenFOAM case. Runs the real
 * meshio++ reader/writer (no skip guard — a hard dependency) over a copy of
 * `fixtures/openfoam-inplace/case`: two hexahedra, a cyclic bottom/top pair, a
 * wall, time directories 0 / 0.5 / 1 with nonuniform fields, system/, constant/
 * dictionaries and a faceZones file.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { parseMeshFile } from "../parser/meshFileParser";
import {
  applyInPlacePlan,
  describeInPlaceRefusals,
  parsePointsLayout,
  planOpenFoamInPlaceSave,
  rewritePoints,
} from "../parser/openfoamOwnership";
import { replaceInternalField } from "../parser/openfoamFieldWrite";
import { refineModel } from "../parser/refineMesh";
import { translateCoords } from "../parser/transformCoords";
import type { MdpaModel } from "../parser/types";

const FIXTURE = path.resolve(__dirname, "../../src/test/fixtures/openfoam-inplace/case");

function copyCase(): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "inplace-"));
  fs.cpSync(FIXTURE, dest, { recursive: true });
  return dest;
}

function digests(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(path.relative(dir, p).split(path.sep).join("/"), createHash("sha1").update(fs.readFileSync(p)).digest("hex"));
    }
  };
  walk(dir);
  return out;
}

const marker = (dir: string): string => path.join(dir, "case.foam");

function changed(before: Map<string, string>, after: Map<string, string>): string[] {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((n) => before.get(n) !== after.get(n)).sort();
}

// ---- pure helpers -------------------------------------------------------------------

test("parsePointsLayout/rewritePoints re-spell only the points that moved", () => {
  const text = "FoamFile\n{\n    class vectorField;\n}\n\n3\n(\n(0 0 0)\n(1.5 0 0)\n(0 1 0)\n)\n";
  const layout = parsePointsLayout(text)!;
  assert.equal(layout.spans.length, 3);
  const base = Float32Array.from([0, 0, 0, 1.5, 0, 0, 0, 1, 0]);
  const cur = Float32Array.from([0, 0, 0, 2.25, 0, 0, 0, 1, 0, /* apex node, never written */ 9, 9, 9]);
  const { text: out, moved } = rewritePoints(layout, base, cur);
  assert.equal(moved, 1);
  assert.equal(out, text.replace("(1.5 0 0)", "(2.25 0 0)"));
});

test("parsePointsLayout refuses a list whose count and entries disagree", () => {
  assert.equal(parsePointsLayout("FoamFile\n{\n}\n\n4\n(\n(0 0 0)\n(1 0 0)\n)\n"), undefined);
});

test("replaceInternalField swaps only the internalField entry", () => {
  const text =
    "FoamFile\n{\n    class volScalarField;\n    object p;\n}\ndimensions [0 2 -2 0 0 0 0];\n\n" +
    "internalField   nonuniform List<scalar>\n2\n(\n1\n2\n)\n;\n\nboundaryField\n{\n    wall { type zeroGradient; }\n}\n";
  const out = replaceInternalField(text, "volScalarField", "scalar", ["7", "8"])!;
  assert.ok(out.startsWith(text.slice(0, text.indexOf("internalField"))));
  assert.ok(out.endsWith(text.slice(text.indexOf("\n\nboundaryField"))));
  assert.match(out, /internalField\s+nonuniform List<scalar>\n2\n\(\n7\n8\n\)\n;/);
  assert.equal(replaceInternalField(text, "volVectorField", "vector", ["(1 0 0)"]), undefined, "class mismatch");
  assert.equal(replaceInternalField(text.replace("ascii", "x").replace("class volScalarField;", "format binary;\n    class volScalarField;"), "volScalarField", "scalar", ["1"]), undefined, "binary");
  assert.match(
    replaceInternalField(text.replace(/internalField[\s\S]*?\n;/, "internalField uniform 3;"), "volScalarField", "scalar", ["1"])!,
    /nonuniform List<scalar>\n1/
  );
});

// ---- geometry mode ------------------------------------------------------------------

test("geometry mode: a translate rewrites only constant/polyMesh/points", async () => {
  const dir = copyCase();
  const before = digests(dir);
  const model = translateCoords(await parseMeshFile(marker(dir)), 10, 0, 0);
  const plan = await planOpenFoamInPlaceSave({ markerPath: marker(dir), model });
  assert.ok(plan.ok, plan.ok ? "" : describeInPlaceRefusals(plan.refusals));
  assert.equal(plan.mode, "geometry");
  assert.deepEqual(plan.writes.map((w) => w.name), ["constant/polyMesh/points"]);
  await applyInPlacePlan(marker(dir), plan);

  assert.deepEqual(changed(before, digests(dir)), ["constant/polyMesh/points"], "every other file is byte-identical");
  const reread = await parseMeshFile(marker(dir));
  assert.deepEqual(Array.from(reread.bounds.min), [10, 0, 0]);
  assert.deepEqual(Array.from(reread.bounds.max), [12, 1, 1]);
  const boundary = fs.readFileSync(path.join(dir, "constant/polyMesh/boundary"), "utf8");
  assert.match(boundary, /neighbourPatch top;/);
  assert.match(boundary, /separationVector \(0 1 0\);/, "cyclic dictionary untouched");
  assert.ok(fs.existsSync(path.join(dir, "constant/polyMesh/faceZones")), "index-keyed file kept");
});

test("geometry mode: one moved point re-spells one point only", async () => {
  const dir = copyCase();
  const model = await parseMeshFile(marker(dir));
  const coords = Float32Array.from(model.coords);
  coords[0] += 0.25; // node 1 only
  const plan = await planOpenFoamInPlaceSave({ markerPath: marker(dir), model: { ...model, coords } });
  assert.ok(plan.ok);
  const oldLines = fs.readFileSync(path.join(dir, "constant/polyMesh/points"), "utf8").split("\n");
  const newLines = Buffer.from(plan.writes[0].data).toString("utf8").split("\n");
  assert.equal(oldLines.length, newLines.length);
  assert.equal(oldLines.filter((l, i) => l !== newLines[i]).length, 1);
});

test("an unmodified model has nothing to write", async () => {
  const dir = copyCase();
  const plan = await planOpenFoamInPlaceSave({ markerPath: marker(dir), model: await parseMeshFile(marker(dir)) });
  assert.ok(plan.ok);
  assert.equal(plan.mode, "unchanged");
  assert.equal(plan.writes.length, 0);
  assert.ok(plan.preservedCount > 10);
});

test("geometry mode: an edited field replaces internalField and keeps the real boundaryField", async () => {
  const dir = copyCase();
  const before = digests(dir);
  const model = await parseMeshFile(marker(dir));
  const fields = model.fields.map((f) => (f.variable === "p" ? { ...f, values: Float64Array.from(f.values, (v) => v * 10) } : f));
  assert.ok(model.fields.some((f) => f.variable === "p"), "the fixture's 0/p is read");
  const plan = await planOpenFoamInPlaceSave({ markerPath: marker(dir), model: { ...model, fields } });
  assert.ok(plan.ok, plan.ok ? "" : describeInPlaceRefusals(plan.refusals));
  assert.deepEqual(plan.writes.map((w) => w.name), ["0/p"]);
  await applyInPlacePlan(marker(dir), plan);
  assert.deepEqual(changed(before, digests(dir)), ["0/p"]);
  const text = fs.readFileSync(path.join(dir, "0/p"), "utf8");
  assert.match(text, /inlet \{ type fixedValue; value uniform 5; \}/, "boundaryField is byte-for-byte the original");
  assert.match(text, /dimensions      \[0 2 -2 0 0 0 0\];/);
  const reread = await parseMeshFile(marker(dir));
  assert.deepEqual(Array.from(reread.fields.find((f) => f.variable === "p")!.values), [10, 20]);
});

// ---- topology mode ------------------------------------------------------------------

test("topology mode refuses by name what the rewrite would leave dangling, and writes nothing", async () => {
  const dir = copyCase();
  const before = digests(dir);
  const model = refineModel(await parseMeshFile(marker(dir)), 1).model;
  const plan = await planOpenFoamInPlaceSave({ markerPath: marker(dir), model });
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  const named = plan.refusals.map((r) => r.path).sort();
  assert.deepEqual(named, ["0.5/p", "0/p", "1/p", "constant/polyMesh/faceZones"]);
  assert.match(describeInPlaceRefusals(plan.refusals), /0\.5\/p — holds per-cell or per-face values/);
  assert.deepEqual(changed(before, digests(dir)), [], "a refused save changes nothing");
});

test("topology mode writes the six polyMesh files once nothing index-keyed remains, keeping cyclic keys", async () => {
  const dir = copyCase();
  for (const f of ["0/p", "0.5/p", "1/p", "constant/polyMesh/faceZones"]) fs.rmSync(path.join(dir, f));
  const before = digests(dir);
  const read = await parseMeshFile(marker(dir));
  // Whatever op changed the topology has probably dropped `source`; the baseline supplies it.
  const model: MdpaModel = { ...refineModel(read, 1).model, source: undefined };
  const plan = await planOpenFoamInPlaceSave({ markerPath: marker(dir), model });
  assert.ok(plan.ok, plan.ok ? "" : describeInPlaceRefusals(plan.refusals));
  assert.equal(plan.mode, "topology");
  assert.deepEqual(
    plan.writes.map((w) => w.name).sort(),
    ["boundary", "cellZones", "faces", "neighbour", "owner", "points"].map((n) => `constant/polyMesh/${n}`)
  );
  await applyInPlacePlan(marker(dir), plan);
  const touched = changed(before, digests(dir));
  assert.ok(touched.every((n) => n.startsWith("constant/polyMesh/")), `only polyMesh changed: ${touched}`);
  assert.ok(!fs.existsSync(path.join(dir, "constant/polyMesh/faceZones")), "a removed file is not resurrected");
  const boundary = fs.readFileSync(path.join(dir, "constant/polyMesh/boundary"), "utf8");
  assert.match(boundary, /neighbourPatch top;/);
  assert.match(boundary, /type\s+cyclic;/);
  const reread = await parseMeshFile(marker(dir));
  const cells = reread.blocks.filter((b) => b.kind === "Elements" && b.count > 0).reduce((n, b) => n + b.count, 0);
  assert.equal(cells, 16, "2 hexahedra refined into 16");
  assert.ok(reread.subModelParts.some((p) => p.name === "walls"));
  assert.equal(fs.readFileSync(path.join(dir, "system/controlDict"), "utf8").includes("icoFoam"), true);
});

test("topology mode keeps a zero-face patch declared on disk", async () => {
  const dir = copyCase();
  for (const f of ["0/p", "0.5/p", "1/p", "constant/polyMesh/faceZones"]) fs.rmSync(path.join(dir, f));
  const bPath = path.join(dir, "constant/polyMesh/boundary");
  // Normalised to LF so the patterns below also match a CRLF (Windows) checkout.
  const original = fs.readFileSync(bPath, "utf8").replace(/\r\n/g, "\n");
  assert.match(original, /\n5\n\(/, "the fixture declares five patches");
  const text = original
    .replace(/\n5\n\(/, "\n6\n(")
    .replace(/\)\s*$/, "    spare\n    {\n        type            empty;\n        nFaces          0;\n        startFace       11;\n    }\n)\n");
  fs.writeFileSync(bPath, text);
  const model: MdpaModel = { ...refineModel(await parseMeshFile(marker(dir)), 1).model, source: undefined };
  const plan = await planOpenFoamInPlaceSave({ markerPath: marker(dir), model });
  assert.ok(plan.ok, plan.ok ? "" : describeInPlaceRefusals(plan.refusals));
  await applyInPlacePlan(marker(dir), plan);
  const boundary = fs.readFileSync(bPath, "utf8");
  assert.match(boundary, /spare\s*\{\s*type\s+empty;\s*nFaces\s+0;/);
  assert.match(boundary, /\n6\n\(/);
});

// ---- shapes the first increment refuses ------------------------------------------------

test("a case mixing regions, a top-level polyMesh and processors is refused", async () => {
  const dir = copyCase();
  fs.mkdirSync(path.join(dir, "constant/fluid/polyMesh"), { recursive: true });
  fs.writeFileSync(path.join(dir, "constant/fluid/polyMesh/points"), "x");
  fs.mkdirSync(path.join(dir, "processor0/constant/polyMesh"), { recursive: true });
  const plan = await planOpenFoamInPlaceSave({ markerPath: marker(dir), model: await parseMeshFile(marker(dir)) });
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.match(plan.refusals[0].reason, /mixes regions/);
});

test("a compressed-only points file cannot be edited in place", async () => {
  const dir = copyCase();
  const p = path.join(dir, "constant/polyMesh/points");
  fs.writeFileSync(`${p}.gz`, require("node:zlib").gzipSync(fs.readFileSync(p)));
  fs.rmSync(p);
  const plan = await planOpenFoamInPlaceSave({ markerPath: marker(dir), model: await parseMeshFile(marker(dir)) });
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.deepEqual(plan.refusals.map((r) => r.path), ["constant/polyMesh/points"]);
  assert.match(plan.refusals[0].reason, /compressed/);
});

// ---- multi-region and decomposed: geometry only ------------------------------------------

const MULTI = path.resolve(__dirname, "../../src/test/fixtures/openfoam-multiregion/case");
const DECOMP = path.resolve(__dirname, "../../src/test/fixtures/openfoam-decomposed/case");

function copyOf(src: string): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "inplace-dist-"));
  fs.cpSync(src, dest, { recursive: true });
  return dest;
}

test("multi-region: a translate rewrites only each region's points", async () => {
  const dir = copyOf(MULTI);
  const before = digests(dir);
  const model = translateCoords(await parseMeshFile(marker(dir)), 0, 5, 0);
  const plan = await planOpenFoamInPlaceSave({ markerPath: marker(dir), model });
  assert.ok(plan.ok, plan.ok ? "" : describeInPlaceRefusals(plan.refusals));
  assert.equal(plan.mode, "geometry");
  await applyInPlacePlan(marker(dir), plan);
  assert.deepEqual(changed(before, digests(dir)), ["constant/fluid/polyMesh/points", "constant/solid/polyMesh/points"]);
  const reread = await parseMeshFile(marker(dir));
  assert.deepEqual(Array.from(reread.bounds.min), [0, 5, 0]);
  assert.deepEqual(Array.from(reread.bounds.max), [2, 6, 1]);
  assert.deepEqual(reread.subModelParts.map((p) => p.name).sort(), ["fluid", "solid"]);
  assert.equal(reread.nodeCount, 16);
});

test("multi-region: moving one region's node writes one points file", async () => {
  const dir = copyOf(MULTI);
  const model = await parseMeshFile(marker(dir));
  const coords = Float32Array.from(model.coords);
  coords[3 * 9] += 0.5; // a node of the second region (solid)
  const plan = await planOpenFoamInPlaceSave({ markerPath: marker(dir), model: { ...model, coords } });
  assert.ok(plan.ok);
  assert.deepEqual(plan.writes.map((w) => w.name), ["constant/solid/polyMesh/points"]);
});

test("multi-region: a topology edit is refused naming every region, nothing written", async () => {
  const dir = copyOf(MULTI);
  const before = digests(dir);
  const model = refineModel(await parseMeshFile(marker(dir)), 1).model;
  const plan = await planOpenFoamInPlaceSave({ markerPath: marker(dir), model });
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.deepEqual(plan.refusals.map((r) => r.path), ["constant/fluid", "constant/solid"]);
  assert.deepEqual(changed(before, digests(dir)), []);
});

test("decomposed: a translate rewrites every processor's points, shared points identically", async () => {
  const dir = copyOf(DECOMP);
  const before = digests(dir);
  const model = translateCoords(await parseMeshFile(marker(dir)), 0, 0, 3);
  const plan = await planOpenFoamInPlaceSave({ markerPath: marker(dir), model });
  assert.ok(plan.ok, plan.ok ? "" : describeInPlaceRefusals(plan.refusals));
  assert.equal(plan.mode, "geometry");
  await applyInPlacePlan(marker(dir), plan);
  assert.deepEqual(changed(before, digests(dir)), ["processor0/constant/polyMesh/points", "processor1/constant/polyMesh/points"]);
  const reread = await parseMeshFile(marker(dir));
  assert.equal(reread.nodeCount, 12);
  assert.deepEqual(Array.from(reread.bounds.min), [0, 0, 3]);
  assert.deepEqual(Array.from(reread.bounds.max), [2, 1, 4]);
});

test("decomposed: moving a point owned by one processor leaves the other's file alone", async () => {
  const dir = copyOf(DECOMP);
  const model = await parseMeshFile(marker(dir));
  const coords = Float32Array.from(model.coords);
  coords[3 * 0] -= 1; // global point 0 exists only in processor0
  const plan = await planOpenFoamInPlaceSave({ markerPath: marker(dir), model: { ...model, coords } });
  assert.ok(plan.ok);
  assert.deepEqual(plan.writes.map((w) => w.name), ["processor0/constant/polyMesh/points"]);
});

test("decomposed: a topology edit and a corrupted addressing are refused", async () => {
  const dir = copyOf(DECOMP);
  const model = await parseMeshFile(marker(dir));
  const topo = await planOpenFoamInPlaceSave({ markerPath: marker(dir), model: refineModel(model, 1).model });
  assert.equal(topo.ok, false);
  if (topo.ok) return;
  assert.deepEqual(topo.refusals.map((r) => r.path), ["processor0", "processor1"]);

  const addr = path.join(dir, "processor1/constant/polyMesh/pointProcAddressing");
  // Read before the corruption, so it matches the case the user opened.
  const model2 = await parseMeshFile(marker(dir));
  // Edited on LF text: a CRLF checkout would match nothing, and the assertion catches a no-op edit.
  const labels = fs.readFileSync(addr, "utf8").replace(/\r\n/g, "\n");
  assert.match(labels, /\n11\n10\n\)/, "the fixture ends its label list with 11 and 10");
  fs.writeFileSync(addr, labels.replace("\n11\n10\n)", "\n11\n99\n)"));
  // Label 99 is outside the twelve-node mesh, so the reconstruction changes and the planner refuses both processors.
  const plan = await planOpenFoamInPlaceSave({ markerPath: marker(dir), model: model2 });
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.ok(plan.refusals.length > 0);
  assert.ok(plan.refusals.every((r) => r.path.startsWith("processor")), JSON.stringify(plan.refusals));
});
