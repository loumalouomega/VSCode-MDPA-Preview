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
  // faceZones used to be refused here; genuine zone parts now round-trip
  // through named regions, so only the index-keyed field files block.
  const named = plan.refusals.map((r) => r.path).sort();
  assert.deepEqual(named, ["0.5/p", "0/p", "1/p"]);
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

// ---- zones are writer-owned ---------------------------------------------------------

function zoneNames(text: string): string[] {
  return [...text.matchAll(/^([A-Za-z0-9_.]+)\n\{/gm)].map((m) => m[1]).filter((n) => n !== "FoamFile");
}

test("topology mode rewrites faceZones from the model's genuine zone parts", async () => {
  const dir = copyCase();
  // Only the index-keyed field files go; the faceZones file stays, and the
  // refined model still carries the interior-face part, so it is rewritten.
  for (const f of ["0/p", "0.5/p", "1/p"]) fs.rmSync(path.join(dir, f));
  const read = await parseMeshFile(marker(dir));
  assert.ok(read.subModelParts.some((p) => p.name === "internalFace"), "the fixture reads its faceZone");
  const model: MdpaModel = { ...refineModel(read, 1).model, source: undefined };
  const plan = await planOpenFoamInPlaceSave({ markerPath: marker(dir), model });
  assert.ok(plan.ok, plan.ok ? "" : describeInPlaceRefusals(plan.refusals));
  assert.equal(plan.mode, "topology");
  const names = plan.writes.map((w) => w.name).sort();
  assert.ok(names.includes("constant/polyMesh/faceZones"), `faceZones is rewritten: ${names}`);
  await applyInPlacePlan(marker(dir), plan);
  const zones = fs.readFileSync(path.join(dir, "constant/polyMesh/faceZones"), "utf8");
  assert.match(zones, /internalFace/, "the interior-face zone survives the rewrite");
  assert.doesNotMatch(zones, /\n(inlet|outlet|bottom|top|walls)\n\{/, "no patch name becomes a faceZone");
  const reread = await parseMeshFile(marker(dir));
  assert.ok(reread.subModelParts.some((p) => p.name === "internalFace"), "the rewritten zone reads back");
});

test("topology mode adds no new bogus cellZones for blocks and patches", async () => {
  const dir = copyCase();
  for (const f of ["0/p", "0.5/p", "1/p", "constant/polyMesh/faceZones"]) fs.rmSync(path.join(dir, f));
  const legacy = zoneNames(fs.readFileSync(path.join(dir, "constant/polyMesh/cellZones"), "utf8")).sort();
  const model: MdpaModel = { ...refineModel(await parseMeshFile(marker(dir)), 1).model, source: undefined };
  const plan = await planOpenFoamInPlaceSave({ markerPath: marker(dir), model });
  assert.ok(plan.ok, plan.ok ? "" : describeInPlaceRefusals(plan.refusals));
  await applyInPlacePlan(marker(dir), plan);
  const written = zoneNames(fs.readFileSync(path.join(dir, "constant/polyMesh/cellZones"), "utf8")).sort();
  assert.deepEqual(
    written.filter((n) => !legacy.includes(n)),
    [],
    `no zone the case did not declare: ${written}`
  );
});

test("topology mode refuses when the model dropped a zone file's zones", async () => {
  const dir = copyCase();
  for (const f of ["0/p", "0.5/p", "1/p"]) fs.rmSync(path.join(dir, f));
  const read = await parseMeshFile(marker(dir));
  // Whatever op changed the topology dropped the faceZone part; the on-disk
  // file would be deleted by the rewrite, so the save blocks until the file
  // goes explicitly.
  const model: MdpaModel = {
    ...refineModel(read, 1).model,
    source: undefined,
    subModelParts: refineModel(read, 1).model.subModelParts.filter((p) => p.name !== "internalFace"),
  };
  const plan = await planOpenFoamInPlaceSave({ markerPath: marker(dir), model });
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.deepEqual(plan.refusals.map((r) => r.path), ["constant/polyMesh/faceZones"]);
  assert.match(plan.refusals[0].reason, /delete it explicitly/);
});

function polyZoneNames(dir: string, rel: string): string[] {
  const p = path.join(dir, ...rel.split("/"));
  if (!fs.existsSync(p)) return [];
  return zoneNames(fs.readFileSync(p, "utf8")).sort();
}

test("zone files fixpoint across consecutive topology saves: no growth, no loss", async () => {
  const dir = copyCase();
  for (const f of ["0/p", "0.5/p", "1/p"]) fs.rmSync(path.join(dir, f));
  const snap = (): Record<string, string[]> => ({
    cellZones: polyZoneNames(dir, "constant/polyMesh/cellZones"),
    faceZones: polyZoneNames(dir, "constant/polyMesh/faceZones"),
  });
  const legacy = snap();
  assert.ok(legacy.faceZones.includes("internalFace"), "the fixture declares its face zone");
  const rounds: Record<string, string[]>[] = [];
  for (let round = 0; round < 2; round++) {
    const model: MdpaModel = { ...refineModel(await parseMeshFile(marker(dir)), 1).model, source: undefined };
    const plan = await planOpenFoamInPlaceSave({ markerPath: marker(dir), model });
    assert.ok(plan.ok, plan.ok ? "" : describeInPlaceRefusals(plan.refusals));
    await applyInPlacePlan(marker(dir), plan);
    rounds.push(snap());
  }
  assert.deepEqual(rounds[1], rounds[0], "zone name sets are stable across saves: preserved, none added");
  assert.ok(rounds[0].faceZones.includes("internalFace"));
  for (const [file, names] of Object.entries(rounds[0])) {
    assert.deepEqual(
      names.filter((n) => !(legacy[file as keyof typeof legacy] as string[]).includes(n)),
      [],
      `no zone ${file} did not declare: ${names}`
    );
  }
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

test("multi-region: a topology edit rewrites each changed region's polyMesh and fields", async () => {
  const dir = copyOf(MULTI);
  const before = digests(dir);
  const model = refineModel(await parseMeshFile(marker(dir)), 1).model;
  const plan = await planOpenFoamInPlaceSave({ markerPath: marker(dir), model });
  assert.ok(plan.ok, plan.ok ? "" : describeInPlaceRefusals(plan.refusals));
  assert.equal(plan.mode, "topology");
  const names = plan.writes.map((w) => w.name).sort();
  for (const region of ["fluid", "solid"]) {
    for (const f of ["points", "faces", "owner", "neighbour", "boundary"]) {
      assert.ok(names.includes(`constant/${region}/polyMesh/${f}`), `rewritten: constant/${region}/polyMesh/${f} in ${names}`);
    }
    assert.ok(names.includes(`0/${region}/T`), `wholesale field rewrite: 0/${region}/T in ${names}`);
  }
  await applyInPlacePlan(marker(dir), plan);
  assert.deepEqual(
    changed(before, digests(dir)).filter((n) => !n.startsWith("constant/") && !n.startsWith("0/")),
    [],
    "only region polyMesh files and region fields change"
  );
  const reread = await parseMeshFile(marker(dir));
  assert.deepEqual(reread.subModelParts.map((p) => p.name).sort(), ["fluid", "solid"]);
  assert.equal(reread.nodeCount, 54, "two refined hexahedra per region");
  const t = reread.fields.find((f) => f.variable === "T")!;
  assert.equal(t.values.length, 16, "the rewritten fields cover the refined cells");
  assert.equal(Array.from(t.values).filter((v) => v === 300).length, 8, "fluid values survive per region");
  assert.equal(Array.from(t.values).filter((v) => v === 500).length, 8, "solid values survive per region");
  // Zones round-trip per region: one cell each before, eight refined cells after.
  for (const [region, zone] of [["fluid", "fluidCells"], ["solid", "solidCells"]] as const) {
    const part = reread.subModelParts.find((p) => p.name === region)?.children.find((c) => c.name === zone);
    assert.ok(part, `${region} keeps its ${zone} zone part`);
    assert.equal(part!.elementIds.length, 8, `${zone} covers the refined cells`);
  }
});

test("multi-region: changing one region leaves the other's files byte-identical", async () => {
  const dir = copyOf(MULTI);
  // Refine once so each region holds several cells, save that as the new
  // baseline, then crop away half of solid: fluid keeps every cell.
  const first = refineModel(await parseMeshFile(marker(dir)), 1).model;
  const setup = await planOpenFoamInPlaceSave({ markerPath: marker(dir), model: first });
  assert.ok(setup.ok, setup.ok ? "" : describeInPlaceRefusals(setup.refusals));
  await applyInPlacePlan(marker(dir), setup);
  const before = digests(dir);
  const { cropModel } = await import("../parser/cropMesh");
  const model = cropModel(await parseMeshFile(marker(dir)), { kind: "bbox", lo: [0, 0, 0], hi: [1.5, 1, 1] }).model;
  const plan = await planOpenFoamInPlaceSave({ markerPath: marker(dir), model });
  assert.ok(plan.ok, plan.ok ? "" : describeInPlaceRefusals(plan.refusals));
  assert.equal(plan.mode, "topology");
  await applyInPlacePlan(marker(dir), plan);
  assert.deepEqual(
    changed(before, digests(dir)).filter((n) => !n.startsWith("constant/solid/") && !n.startsWith("0/solid/")),
    [],
    "fluid keeps every byte"
  );
  const reread = await parseMeshFile(marker(dir));
  assert.deepEqual(reread.subModelParts.map((p) => p.name).sort(), ["fluid", "solid"]);
});

test("multi-region: an edited field replaces internalField per region and keeps boundaryField", async () => {
  const dir = copyOf(MULTI);
  const before = digests(dir);
  const model = await parseMeshFile(marker(dir));
  const fields = model.fields.map((f) => (f.variable === "T" ? { ...f, values: Float64Array.from(f.values, (v) => v + 100) } : f));
  const plan = await planOpenFoamInPlaceSave({ markerPath: marker(dir), model: { ...model, fields } });
  assert.ok(plan.ok, plan.ok ? "" : describeInPlaceRefusals(plan.refusals));
  assert.equal(plan.mode, "geometry");
  assert.deepEqual(plan.writes.map((w) => w.name).sort(), ["0/fluid/T", "0/solid/T"]);
  await applyInPlacePlan(marker(dir), plan);
  assert.deepEqual(changed(before, digests(dir)), ["0/fluid/T", "0/solid/T"]);
  for (const [region, value] of [["fluid", 400], ["solid", 600]] as const) {
    const text = fs.readFileSync(path.join(dir, "0", region, "T"), "utf8");
    assert.match(text, new RegExp(`internalField\\s+nonuniform List<scalar>\\n1\\n\\(\\n${value}\\n\\)`), `${region} carries the edited value`);
    assert.match(text, /boundaryField/, `${region} boundaryField block kept`);
  }
});

test("multi-region: history a topology edit strands is refused by name", async () => {
  const dir = copyOf(MULTI);
  // A second time directory whose region fields the rewrite cannot match.
  for (const region of ["fluid", "solid"]) {
    fs.mkdirSync(path.join(dir, "1", region), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "1", region, "T"),
      fs.readFileSync(path.join(dir, "0", region, "T"), "utf8").replace(/uniform \d+/, "nonuniform List<scalar>\n1\n(\n350\n)\n")
    );
  }
  const before = digests(dir);
  const model = refineModel(await parseMeshFile(marker(dir)), 1).model;
  const plan = await planOpenFoamInPlaceSave({ markerPath: marker(dir), model });
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.deepEqual(plan.refusals.map((r) => r.path).sort(), ["1/fluid/T", "1/solid/T"]);
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

test("decomposed: a points file edited behind the model's back is healed by save", async () => {
  const dir = copyOf(DECOMP);
  const pts = path.join(dir, "processor1/constant/polyMesh/points");
  // Read before the edit, so it matches the case the user opened.
  const model2 = await parseMeshFile(marker(dir));
  // Edited on LF text: a CRLF checkout would match nothing, and the assertion catches a no-op edit.
  const text = fs.readFileSync(pts, "utf8").replace(/\r\n/g, "\n");
  const edited = text.replace("(2 1 1)", "(2 1 2)");
  assert.notEqual(edited, text, "the fixture has a point to move");
  fs.writeFileSync(pts, edited);
  // Coordinates are not part of the mesh key, so this stays on the geometry
  // path and the save restores the model's coordinates over the edit.
  const plan = await planOpenFoamInPlaceSave({ markerPath: marker(dir), model: model2 });
  assert.ok(plan.ok, plan.ok ? "" : describeInPlaceRefusals(plan.refusals));
  assert.deepEqual(plan.writes.map((w) => w.name), ["processor1/constant/polyMesh/points"]);
  await applyInPlacePlan(marker(dir), plan);
  assert.ok(fs.readFileSync(pts, "utf8").includes("(2 1 1)"), "the model's coordinates are restored");
});

test("decomposed: a topology edit re-partitions natively and reconstructs", async () => {
  const dir = copyOf(DECOMP);
  const before = digests(dir);
  const refined = refineModel(await parseMeshFile(marker(dir)), 1).model;
  const cornersIds = [...refined.subModelParts.find((p) => p.name === "corners")!.nodeIds].sort((a, b) => a - b);
  const plan = await planOpenFoamInPlaceSave({ markerPath: marker(dir), model: refined });
  assert.ok(plan.ok, plan.ok ? "" : describeInPlaceRefusals(plan.refusals));
  assert.equal(plan.mode, "topology");
  const names = plan.writes.map((w) => w.name).sort();
  for (const n of [0, 1]) {
    for (const f of ["points", "faces", "owner", "neighbour", "boundary", "pointProcAddressing", "cellProcAddressing", "faceProcAddressing", "boundaryProcAddressing"]) {
      assert.ok(names.includes(`processor${n}/constant/polyMesh/${f}`), `rewritten: processor${n}/constant/polyMesh/${f}`);
    }
  }
  await applyInPlacePlan(marker(dir), plan);
  assert.deepEqual(
    changed(before, digests(dir)).filter((n) => !n.startsWith("processor")),
    [],
    "only processor files change"
  );
  const reread = await parseMeshFile(marker(dir));
  const cells = reread.blocks.filter((b) => b.kind === "Elements" && b.count > 0).reduce((n, b) => n + b.count, 0);
  assert.equal(cells, 16, "2 hexahedra refined into 16 across the new decomposition");
  assert.equal(reread.nodeCount, 45);
  // Zones round-trip through the new decomposition: the cell zone spans
  // both processors with the refined cells, the point zone keeps its nodes,
  // the interface face zone its subdivided faces.
  const zoneA = reread.subModelParts.find((p) => p.name === "zoneA")!;
  assert.ok(zoneA, "zoneA survives");
  assert.equal(zoneA.elementIds.length, 16);
  // The refined model carries what refine put in the part (refine expands a
  // node zone over its subdivided interface); the rewrite preserves exactly
  // that set through both processors.
  assert.deepEqual(
    [...reread.subModelParts.find((p) => p.name === "corners")!.nodeIds].sort((a, b) => a - b),
    cornersIds
  );
  assert.equal(reread.subModelParts.find((p) => p.name === "iface")!.conditionIds.length, 4);
  for (const n of [0, 1]) {
    const boundary = fs.readFileSync(path.join(dir, `processor${n}/constant/polyMesh/boundary`), "utf8");
    assert.match(boundary, new RegExp(`procBoundary${n}to${1 - n}`), `processor${n} names its neighbour patch`);
    assert.match(boundary, new RegExp(`myProcNo\\s+${n};`), "the patch carries its own number");
    assert.match(boundary, new RegExp(`neighbProcNo\\s+${1 - n};`), "the patch carries the neighbour number");
  }
});

test("decomposed: wholesale field rewrite follows the new cell order per processor", async () => {
  const dir = copyOf(DECOMP);
  // Processor field files for the old one-cell-each order, as decomposePar leaves them.
  for (const n of [0, 1]) {
    fs.mkdirSync(path.join(dir, `processor${n}`, "0"), { recursive: true });
    fs.writeFileSync(path.join(dir, `processor${n}`, "0", "p"), procFieldFile("uniform 0"));
  }
  const model = refineModel(await parseMeshFile(marker(dir)), 1).model;
  const elements = model.blocks.filter((b) => b.kind === "Elements");
  const ids = elements.flatMap((b) => Array.from(b.entityIds));
  assert.equal(ids.length, 16);
  const fields = [
    ...model.fields,
    { kind: "Elemental" as const, variable: "p", components: 1, ids: Int32Array.from(ids), values: Float64Array.from(ids.map((_, i) => i)) },
  ];
  const plan = await planOpenFoamInPlaceSave({ markerPath: marker(dir), model: { ...model, fields } });
  assert.ok(plan.ok, plan.ok ? "" : describeInPlaceRefusals(plan.refusals));
  assert.equal(plan.mode, "topology");
  assert.deepEqual(plan.writes.map((w) => w.name).filter((n) => n.endsWith("/0/p")).sort(), ["processor0/0/p", "processor1/0/p"]);
  await applyInPlacePlan(marker(dir), plan);
  // SFC halves pin the slicing: global values 0-7 land on processor0, 8-15 on processor1.
  const p0 = fs.readFileSync(path.join(dir, "processor0/0/p"), "utf8");
  const p1 = fs.readFileSync(path.join(dir, "processor1/0/p"), "utf8");
  assert.match(p0, /internalField\s+nonuniform List<scalar>\n8\n\(\n0\n1\n2\n3\n4\n5\n6\n7\n\)/);
  assert.match(p1, /internalField\s+nonuniform List<scalar>\n8\n\(\n8\n9\n10\n11\n12\n13\n14\n15\n\)/);
  assert.match(p0, /procBoundary0to1\s*\{\s*type\s+processor;/, "processor patches ride the fresh boundaryField");
});

test("decomposed: history a topology edit strands is refused by name", async () => {
  const dir = copyOf(DECOMP);
  for (const n of [0, 1]) {
    fs.mkdirSync(path.join(dir, `processor${n}`, "0"), { recursive: true });
    fs.writeFileSync(path.join(dir, `processor${n}`, "0", "p"), procFieldFile("uniform 0"));
    fs.mkdirSync(path.join(dir, `processor${n}`, "1"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, `processor${n}`, "1", "p"),
      procFieldFile("nonuniform List<scalar>\n1\n(\n9\n)\n")
    );
  }
  const before = digests(dir);
  const model = refineModel(await parseMeshFile(marker(dir)), 1).model;
  const plan = await planOpenFoamInPlaceSave({ markerPath: marker(dir), model });
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.deepEqual(plan.refusals.map((r) => r.path).sort(), ["processor0/1/p", "processor1/1/p"]);
  assert.deepEqual(changed(before, digests(dir)), []);
});

test("decomposed: a sets directory blocks the rewrite by name", async () => {
  const dir = copyOf(DECOMP);
  fs.mkdirSync(path.join(dir, "processor0/constant/polyMesh/sets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "processor0/constant/polyMesh/sets/cellSet"), "FoamFile\n{}\n1\n(\n0\n)\n");
  const model = refineModel(await parseMeshFile(marker(dir)), 1).model;
  const plan = await planOpenFoamInPlaceSave({ markerPath: marker(dir), model });
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.deepEqual(plan.refusals.map((r) => r.path), ["processor0/constant/polyMesh/sets/cellSet"]);
});

const procFieldFile = (value: string): string =>
  "FoamFile\n{\n    version     2.0;\n    format      ascii;\n    class       volScalarField;\n    object      p;\n}\n\n" +
  "dimensions      [0 2 -2 0 0 0 0];\n\n" +
  `internalField   ${value};\n\nboundaryField\n{\n}\n`;

test("decomposed: an Elemental field is sliced per processor through cellProcAddressing", async () => {
  const dir = copyOf(DECOMP);
  // Processor time directories with a field file each, as decomposePar leaves them.
  for (const n of [0, 1]) {
    fs.mkdirSync(path.join(dir, `processor${n}`, "0"), { recursive: true });
    fs.writeFileSync(path.join(dir, `processor${n}`, "0", "p"), procFieldFile("uniform 0"));
  }
  const model = await parseMeshFile(marker(dir));
  const elements = model.blocks.filter((b) => b.kind === "Elements");
  const ids = elements.flatMap((b) => Array.from(b.entityIds));
  assert.equal(ids.length, 2);
  const fields = [
    ...model.fields,
    { kind: "Elemental" as const, variable: "p", components: 1, ids: Int32Array.from(ids), values: Float64Array.from([10, 20]) },
  ];
  const plan = await planOpenFoamInPlaceSave({ markerPath: marker(dir), model: { ...model, fields } });
  assert.ok(plan.ok, plan.ok ? "" : describeInPlaceRefusals(plan.refusals));
  assert.equal(plan.mode, "geometry");
  assert.deepEqual(plan.writes.map((w) => w.name).sort(), ["processor0/0/p", "processor1/0/p"]);
  await applyInPlacePlan(marker(dir), plan);
  // The fixture maps processor0 -> global cell 0 and processor1 -> global
  // cell 1, so these values pin the order mapping, not just the plumbing.
  assert.match(fs.readFileSync(path.join(dir, "processor0/0/p"), "utf8"), /nonuniform List<scalar>\n1\n\(\n10\n\)/);
  assert.match(fs.readFileSync(path.join(dir, "processor1/0/p"), "utf8"), /nonuniform List<scalar>\n1\n\(\n20\n\)/);
});

test("decomposed: fields with nowhere to go are diagnosed and coordinates still save", async () => {
  const dir = copyOf(DECOMP);
  const before = digests(dir);
  const model = translateCoords(await parseMeshFile(marker(dir)), 0, 0, 3);
  const elements = model.blocks.filter((b) => b.kind === "Elements");
  const ids = elements.flatMap((b) => Array.from(b.entityIds));
  const fields = [
    ...model.fields,
    { kind: "Elemental" as const, variable: "p", components: 1, ids: Int32Array.from(ids), values: Float64Array.from([10, 20]) },
  ];
  const plan = await planOpenFoamInPlaceSave({ markerPath: marker(dir), model: { ...model, fields } });
  assert.ok(plan.ok, plan.ok ? "" : describeInPlaceRefusals(plan.refusals));
  // No processor time directories exist, so only the points move; the field
  // is named, not silently dropped.
  assert.deepEqual(plan.writes.map((w) => w.name).sort(), ["processor0/constant/polyMesh/points", "processor1/constant/polyMesh/points"]);
  assert.ok(plan.diagnostics.some((d) => /does not exist and processor boundary entries cannot be synthesized/.test(d.message)));
  await applyInPlacePlan(marker(dir), plan);
  assert.deepEqual(
    changed(before, digests(dir)),
    ["processor0/constant/polyMesh/points", "processor1/constant/polyMesh/points"]
  );
});
