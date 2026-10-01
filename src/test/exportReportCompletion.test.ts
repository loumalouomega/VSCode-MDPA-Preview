import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildExportReport, buildUnverifiedReport, expectedFor, observeExport, provenanceRequest, verifyReport, type ExportReport } from "../parser/exportReport";
import { exportReportHtml } from "../parser/exportReportHtml";
import { writeMeshFileAsync } from "../parser/writers/meshWriter";
import { writeMdpa } from "../parser/writers/mdpaWriter";
import { parseMeshFile } from "../parser/meshFileParser";
import { parseBatchManifest } from "../parser/batchPlan";
import { parseProblemZip } from "../parser/problemZip";
import { meshBatchTransform, meshCompare, meshDerive, meshPackSeries, meshSplit, problemPack } from "../mcp/tools";
import { referenceModels } from "./exportReportMatrix";
import { exportResampled } from "../parser/resampleFiles";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kratos-report-completion-"));
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const source = (dir: string) => { const file = path.join(dir, "ref.mdpa"); fs.writeFileSync(file, writeMdpa(referenceModels().simplicial)); return file; };

test("native provenance is safe, round-trippable, and opt-out leaves the original writer bytes", async () => {
  const model = referenceModels().simplicial;
  const request = provenanceRequest("auto", { sourceFile: 'weird--><tag>$&$1\n.mdpa', sourceFormat: ".mdpa", ops: [{ op: "scale", parameters: { sx: 2 } }], tool: "test", kernelVersion: "16.27.0" });
  for (const ext of [".mdpa", ".vtu", ".vtp", ".vtm", ".vtk", ".obj", ".ply", ".stl"]) {
    const dir = tmp();
    const plain = await writeMeshFileAsync(model, ext, { name: "out" });
    const written = await writeMeshFileAsync(model, ext, { name: "out", provenance: request });
    assert.equal(written.provenance?.embedded, ext !== ".stl", ext);
    const file = path.join(dir, `out${ext}`);
    const read = async (output: typeof written) => {
      fs.writeFileSync(file, output.data);
      for (const c of output.companions) fs.writeFileSync(path.join(dir, c.name), c.data);
      return parseMeshFile(file);
    };
    const before = await read(plain), after = await read(written);
    assert.deepEqual(observeExport(model, after), observeExport(model, before), ext);
    const none = await writeMeshFileAsync(model, ext, { name: "out", provenance: provenanceRequest("none", {}) });
    assert.deepEqual(none.data, plain.data, ext);
    assert.deepEqual(none.companions, plain.companions, ext);
    if (ext === ".vtk") assert.ok(String(written.data).split("\n")[1].length <= 255);
    if (ext === ".vtm") assert.ok(written.companions.every((c) => new TextDecoder().decode(c.data).includes("Kratos provenance")));
  }
});

test("simplicial references select narrow writers and measure Conditional scalar/vector fields", () => {
  const models = referenceModels();
  for (const [writer, model] of [["dolfin", models.tetra], ["tetgen", models.tetra], ["freefem", models.triangle], ["triangle", models.triangle]] as const) {
    assert.notEqual(expectedFor(writer, "connectivity", model).status, "unverified", writer);
  }
  for (const f of models.simplicial.fields.filter((f) => f.kind === "Conditional")) {
    assert.equal(expectedFor(".mdpa", "field", models.simplicial, f).status, "retained");
    assert.notEqual(expectedFor(".vtu", "field", models.simplicial, f).status, "unverified");
  }
  const mixed = { ...models.hex, blocks: [...models.hex.blocks, ...models.tetra.blocks] };
  assert.equal(expectedFor(".vtu", "connectivity", mixed).status, "unverified", "separately measured cells do not prove their combination");
});

test("batch persists reports and retains them across repeated resume", async () => {
  const dir = tmp(), input = source(dir), outputDir = path.join(dir, "batch");
  const args = { paths: [input], outputDir, ops: [{ op: "scale", sx: 2, sy: 2, sz: 2 }], outputExt: ".vtu", provenance: "sidecar" };
  const first = await meshBatchTransform(args) as { entries: { report: ExportReport }[]; manifestPath: string };
  assert.equal(first.entries[0].report.provenance.embedded, true);
  const back = parseBatchManifest(fs.readFileSync(first.manifestPath, "utf8")).manifest!;
  assert.deepEqual(back.entries[0].report, json(first.entries[0].report));
  for (let i = 0; i < 2; i++) {
    const resumed = await meshBatchTransform({ ...args, resume: true }) as { entries: { status: string; report: ExportReport }[] };
    assert.equal(resumed.entries[0].status, "skipped");
    assert.deepEqual(resumed.entries[0].report, json(first.entries[0].report));
  }
});

test("split and partition manifests carry a checked report per written mesh", async () => {
  const dir = tmp(), input = source(dir);
  // A second tetra gives the partitioner two cells to divide.
  const model = referenceModels().simplicial;
  const b = model.blocks.find((b) => b.kind === "Elements")!;
  model.blocks = model.blocks.map((x) => x === b ? { ...b, count: 2, entityIds: new Int32Array([101, 102]), propertyIds: new Int32Array([1, 1]), connectivity: new Int32Array([...b.connectivity, ...b.connectivity]) } : x);
  fs.writeFileSync(input, writeMdpa(model));
  for (const by of ["type", "partition"] as const) {
    const result = await meshSplit({ path: input, by, nparts: 2, outputDir: path.join(dir, by), format: ".mdpa", provenance: "sidecar", verify: true }) as { reports: ExportReport[]; manifestPath: string };
    assert.ok(result.reports.length >= 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(result.manifestPath, "utf8")).reports, json(result.reports));
    for (const report of result.reports) { assert.equal(report.source.file, "ref.mdpa"); assert.deepEqual(report.unexpected, []); assert.equal(report.provenance.embedded, true); }
  }
});

test("comparison exports and structured lattices return reports and verified sidecars", async () => {
  const dir = tmp(), input = source(dir);
  const compare = await meshCompare({ pathA: input, pathB: input, variable: "TEMPERATURE", outputPath: path.join(dir, "diff.mdpa"), provenance: "sidecar", verify: true }) as { report: ExportReport };
  assert.deepEqual(compare.report.unexpected, []);
  assert.equal(compare.report.operations[0].op, "compareField");
  const grid = await meshDerive({ kind: "grid", outputPath: path.join(dir, "grid.vti"), bounds: [0, 0, 0, 1, 1, 1], dims: [2, 2, 2], provenance: "sidecar" }) as { report: ExportReport };
  assert.ok(grid.report.categories.every((c) => c.status === "unverified"));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "grid.vti.kratosexport.json"), "utf8")), json(grid.report));
  const checked = await meshDerive({ kind: "grid", outputPath: path.join(dir, "checked.vti"), bounds: [0, 0, 0, 1, 1, 1], dims: [2, 2, 2], provenance: "sidecar", verify: true }) as { report: ExportReport };
  assert.ok(checked.report.categories.some((c) => c.verified === true));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "checked.vti.kratosexport.json"), "utf8")), json(checked.report));
});

test("series packing and resampling expose per-step reports with one associated sidecar", async () => {
  const dir = tmp(), model = referenceModels().tetra;
  for (const ext of [".mdpa", ".vtu"] as const) {
    const runDir = path.join(dir, ext.slice(1)); fs.mkdirSync(runDir);
    for (let i = 0; i < 2; i++) fs.writeFileSync(path.join(runDir, `run_0_${i}${ext}`), (await writeMeshFileAsync(model, ext)).data);
    for (const target of ["pvd", "xdmf"] as const) {
      const outputPath = path.join(dir, `${ext.slice(1)}_${target}.${target}`);
      const result = await meshPackSeries({ path: runDir, outputPath, target, provenance: "sidecar" }) as { reports: { file: string; provenance: { sidecar?: string }; unverified: string[]; retained: string[] }[] };
      assert.equal(result.reports.length, 2);
      assert.ok(result.reports.every((r) => r.provenance.sidecar === path.basename(outputPath) + ".kratosexport.json"));
      assert.deepEqual(JSON.parse(fs.readFileSync(outputPath + ".kratosexport.json", "utf8")).reports, json(result.reports));
      if (target === "xdmf") assert.ok(result.reports.every((r) => r.unverified.length > 0));
      if (target === "pvd" && ext === ".vtu") {
        assert.deepEqual(fs.readFileSync(path.join(dir, "vtu_pvd/frame_000000.vtu")), fs.readFileSync(path.join(runDir, "run_0_0.vtu")), "copy-through stays byte-for-byte");
      }
    }
  }
  const out = path.join(dir, "resampled.pvd");
  const sampled = await exportResampled({ times: [0, 1], load: async () => model }, { times: [0, 0.5, 1], method: "nearest" }, out, undefined, "sidecar");
  assert.equal(sampled.reports.length, 3);
  assert.deepEqual(JSON.parse(fs.readFileSync(out + ".kratosexport.json", "utf8")).reports, json(sampled.reports));
});

test("problem archives embed a provenance record without altering the pristine source", async () => {
  const dir = tmp(), input = source(dir), recipePath = path.join(dir, "recipe.ops.json");
  fs.writeFileSync(recipePath, JSON.stringify({ version: 1, operations: [{ op: "scale", sx: 2, sy: 2, sz: 2 }] }));
  const packed = await problemPack({ meshPath: input, recipePath }) as { archivePath: string };
  const archive = parseProblemZip(fs.readFileSync(packed.archivePath));
  const entry = archive.entries.find((e) => e.name === archive.manifest!.provenance!.record)!;
  const record = JSON.parse(Buffer.from(entry.data).toString("utf8"));
  assert.equal(record.recipe.operations[0].sx, 2);
  const mesh = archive.entries.find((e) => e.name === "ref.mdpa")!;
  assert.deepEqual(Buffer.from(mesh.data), fs.readFileSync(input));
  assert.equal(record.files.find((f: { file: string }) => f.file === "ref.mdpa").sha256, createHash("sha256").update(mesh.data).digest("hex"));
});

test("standalone report view escapes filenames, diagnostics and JSON; bypass claims stay unverified", () => {
  const report = buildUnverifiedReport({ model: referenceModels().hex, ext: ".vti", targetFile: "<script>alert(1)</script>.vti", warnings: ['<img src=x onerror="bad">'] }, "unmeasured path");
  const html = exportReportHtml([report]);
  assert.ok(!html.includes("<script>")); assert.ok(!html.includes("<img")); assert.match(html, /&lt;script&gt;/);
  assert.ok(report.categories.every((c) => c.status === "unverified"));
  const contradicted = verifyReport(buildExportReport({ model: referenceModels().hex, ext: ".mdpa", targetFile: "out.mdpa" }), [{ id: "constraints", status: "omitted" }]);
  assert.match(exportReportHtml([contradicted]), /CONTRADICTED/);
});
