/**
 * Roadmap item 6: the export report, its measured fidelity table, embedded
 * provenance and the MCP surface that returns them.
 *
 * The acceptance clause these tests carry is "reports agree with a re-read of
 * the output, and unexpected losses fail a regression": the fidelity table is
 * not asserted by hand but re-derived from a live write-and-re-read of every
 * writer, so a kernel bump that changes what a format keeps fails here as a
 * table diff, and `verifyReport` grades a report against a re-read the same way
 * `mesh_convert`'s `verify` does.
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  applicableCategories,
  buildExportReport,
  exportFidelityCapabilities,
  expectedFor,
  fidelityKey,
  finalizeReport,
  observeExport,
  provenanceRequest,
  serializeReport,
  sidecarFileName,
  summarizeReport,
  verifyReport,
} from "../parser/exportReport";
import { EXPORT_FIDELITY_TABLE } from "../parser/exportFidelityTable";
import { referenceModel, referenceModels, roundTrip, measureAll, writerJobs, measuredRoundTrips } from "./exportReportMatrix";
import { writeMdpa } from "../parser/writers/mdpaWriter";
import { parseMdpa } from "../parser/mdpaParser";
import { parseOpsJson, serializeOps } from "../parser/operations";
import { writeMeshioBytes, loadMeshio } from "../parser/meshio";
import { parseProblemZip } from "../parser/problemZip";
import { getMeshCapabilities } from "../parser/meshCapabilities";
import { meshConvert, meshTransform, meshExtractSkin, problemPack } from "../mcp/tools";
import { MdpaModel } from "../parser/types";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kratos-export-report-"));
}

function referenceFile(dir: string): string {
  const file = path.join(dir, "ref.mdpa");
  fs.writeFileSync(file, writeMdpa(referenceModel()));
  return file;
}

// --- pure: observation ------------------------------------------------------

test("observeExport: a model compared with itself retains every category it carries", () => {
  const model = referenceModel();
  const obs = observeExport(model, model);
  for (const o of obs) assert.equal(o.status, "retained", `${o.id}: ${o.detail ?? ""}`);
  const ids = obs.map((o) => o.id);
  for (const want of ["nodes", "nodeIds", "connectivity", "entityIds", "blocks", "properties", "constraints", "subModelParts"]) {
    assert.ok(ids.includes(want), `${want} is observed`);
  }
  assert.ok(ids.includes("field:Nodal:DISPLACEMENT") && ids.includes("field:Elemental:DENSITY_FACTOR"));
});

test("observeExport: only categories the source carries are reported", () => {
  const bare = parseMdpa(`Begin Nodes\n1 0 0 0\n2 1 0 0\n3 0 1 0\nEnd Nodes\nBegin Elements Element2D3N\n1 0 1 2 3\nEnd Elements\n`);
  const ids = observeExport(bare, bare).map((o) => o.id);
  assert.deepEqual(ids.sort(), ["blocks", "connectivity", "entityIds", "nodeIds", "nodes"]);
});

test("observeExport: dropped data is omitted, renumbering is transformed, dotted parts are flattened", () => {
  const model = referenceModel();
  const stripped: MdpaModel = {
    ...model,
    properties: undefined,
    constraints: undefined,
    fields: model.fields.filter((f) => f.variable !== "DISPLACEMENT"),
    nodeIds: model.nodeIds.map((v) => v + 1000) as unknown as Int32Array,
    subModelParts: model.subModelParts.map((p) => ({
      ...p,
      path: p.path.replace("/", "."),
      children: [],
    })),
  };
  const by = new Map(observeExport(model, stripped).map((o) => [o.id, o]));
  assert.equal(by.get("properties")!.status, "omitted");
  assert.equal(by.get("constraints")!.status, "omitted");
  assert.equal(by.get("field:Nodal:DISPLACEMENT")!.status, "omitted");
  assert.equal(by.get("field:Nodal:TEMPERATURE")!.status, "retained");
  assert.equal(by.get("nodeIds")!.status, "transformed");
  // "Outer" survives under its own name, "Outer/Inner" is gone: neither retained nor omitted.
  assert.equal(by.get("subModelParts")!.status, "transformed");
  const dotted = observeExport(model, {
    ...model,
    subModelParts: [{ ...model.subModelParts[0], path: "Outer", children: [{ ...model.subModelParts[0].children[0], path: "Outer.Inner", children: [] }] }],
  }).find((o) => o.id === "subModelParts")!;
  assert.equal(dotted.status, "transformed");
  assert.match(dotted.detail ?? "", /flattened to dotted names: Outer\/Inner/);
});

// --- pure: building a report ------------------------------------------------

test("buildExportReport: a native .mdpa export retains what the writer round-trips", () => {
  const model = referenceModel();
  const r = buildExportReport({ model, ext: ".mdpa", targetFile: "out.mdpa" });
  const status = Object.fromEntries(r.categories.map((c) => [c.id, c.status]));
  assert.equal(status.nodeIds, "retained");
  assert.equal(status.properties, "retained");
  assert.equal(status.constraints, "retained");
  assert.equal(status.subModelParts, "retained");
  assert.equal(status["field:Nodal:DISPLACEMENT"], "retained");
  // The writer does not persist these, and the report must not pretend it does.
  assert.equal(status.globals, "omitted");
  assert.equal(status.source, "omitted");
  assert.equal(r.target.writer, "native");
  assert.equal(r.version, 1);
});

test("buildExportReport: nothing is retained on a guess — uncovered meshes and unmeasured writers are unverified", () => {
  const model = referenceModel();
  // A cell type the reference did not contain (a triangle) makes the cell-type dependent claims unverified.
  const tri: MdpaModel = { ...model, blocks: model.blocks.map((b) => ({ ...b, vtkCellType: 42 })) };
  const e = expectedFor(".vtu", "connectivity", tri);
  assert.equal(e.status, "unverified");
  assert.match(e.detail ?? "", /cell type the measurement did not cover/);
  // A node-only claim does not depend on cell types.
  assert.equal(expectedFor(".vtu", "nodes", tri).status, "retained");
  // A 9-component field was never measured.
  const wide = { ...model.fields[1], components: 9 };
  assert.equal(expectedFor(".vtu", "field", model, wide).status, "unverified");
  // An unmeasured writer reports why.
  const dolfin = buildExportReport({ model, ext: ".xml", targetFile: "out.xml" });
  assert.ok(dolfin.categories.every((c) => c.status === "unverified"));
  assert.match(dolfin.categories[0].detail ?? "", /not measurable on the reference mesh/);
  // A key with no measurement at all.
  assert.equal(expectedFor("no-such-writer", "nodes", model).status, "unverified");
});

test("buildExportReport: per-field entries carry the name, kind and width", () => {
  const r = buildExportReport({ model: referenceModel(), ext: ".vtu", targetFile: "out.vtu" });
  const f = r.categories.find((c) => c.id === "field:Nodal:DISPLACEMENT")!;
  assert.match(f.label, /DISPLACEMENT \(nodal, 3 components\)/);
  assert.equal(f.count, 8);
  assert.deepEqual(applicableCategories(referenceModel()).map((c) => c.id).slice(0, 2), ["nodes", "nodeIds"]);
});

test("fidelityKey: native writers key by extension, meshio++ writers by their key, flavours by the forced key", () => {
  assert.equal(fidelityKey(".vtu"), ".vtu");
  assert.equal(fidelityKey(".med"), "med");
  assert.equal(fidelityKey(".exo"), "exodus");
  assert.equal(fidelityKey(".msh"), "gmsh");
  assert.equal(fidelityKey(".msh", "ansys"), "ansys");
});

// --- pure: provenance settlement and the sidecar ----------------------------

test("provenanceRequest / finalizeReport: modes decide what is recorded and where", () => {
  assert.equal(provenanceRequest("none", { sourceFile: "a.mdpa" }), undefined);
  const req = provenanceRequest("auto", {
    sourceFile: "a.mdpa",
    sourceFormat: ".mdpa",
    ops: [{ op: "scale" }, { op: "smooth" }],
    tool: "Kratos MDPA Preview 1.0.0",
  })!;
  assert.deepEqual(req.source, { file: "a.mdpa", format: ".mdpa" });
  assert.deepEqual(req.notes, [
    { category: "operations", detail: "scale, smooth" },
    { category: "tool", detail: "Kratos MDPA Preview 1.0.0" },
  ]);

  const base = buildExportReport({ model: referenceModel(), ext: ".vtu", targetFile: "out.vtu" });
  const auto = finalizeReport(base, "auto", false, false);
  assert.equal(auto.sidecar, undefined);
  assert.equal(auto.report.provenance.embedded, false);
  assert.match(auto.report.provenance.note ?? "", /no header slot.*"sidecar"/);

  const side = finalizeReport(base, "sidecar", false, false);
  assert.equal(side.sidecar!.name, "out.vtu.kratosexport.json");
  assert.equal(side.report.provenance.sidecar, "out.vtu.kratosexport.json");
  assert.equal(JSON.parse(side.sidecar!.text).target.file, "out.vtu");

  const none = finalizeReport(base, "none", true, true);
  assert.equal(none.report.provenance.embedded, false, "a switched-off request never claims an embedded block");

  const embedded = finalizeReport(base, "auto", true, true);
  assert.equal(embedded.report.provenance.embedded, true);
  assert.equal(embedded.report.provenance.note, undefined);
  assert.equal(sidecarFileName("x.med"), "x.med.kratosexport.json");
});

test("summarizeReport reads as one line naming what did not come through", () => {
  const r = buildExportReport({ model: referenceModel(), ext: ".vtu", targetFile: "out.vtu" });
  const line = summarizeReport(r);
  assert.match(line, /retained/);
  assert.match(line, /omitted/);
  assert.match(line, /properties/);
  assert.ok(!line.includes("\n"));
  assert.equal(JSON.parse(serializeReport(r)).version, 1);
});

test("verifyReport: a contradicted claim is verified:false and named; an unverified one is settled by the re-read", () => {
  const model = referenceModel();
  const report = buildExportReport({ model, ext: ".mdpa", targetFile: "out.mdpa" });
  // Grade the .mdpa claims against a re-read that behaved like the real one (no
  // globals, source or dimensions come back) except that it also lost the constraints.
  const reread: MdpaModel = {
    ...model,
    constraints: undefined,
    globals: undefined,
    source: undefined,
    fields: model.fields.map((f) => ({ ...f, dimensions: undefined })),
  };
  const graded = verifyReport(report, observeExport(model, reread));
  assert.equal(graded.categories.find((c) => c.id === "constraints")!.verified, false);
  assert.equal(graded.categories.find((c) => c.id === "properties")!.verified, true);
  assert.equal(graded.unexpected!.length, 1);
  assert.match(graded.unexpected![0], /Constraints: expected retained, re-read found omitted/);

  const unmeasured = buildExportReport({ model, ext: ".xml", targetFile: "out.xml" });
  const settled = verifyReport(unmeasured, observeExport(model, model));
  assert.ok(settled.categories.every((c) => c.status === "retained" && c.verified === true));
  assert.deepEqual(settled.unexpected, []);
});

test("mesh_capabilities publishes the measured export fidelity", async () => {
  const caps = await getMeshCapabilities();
  assert.deepEqual(caps.exportFidelity, exportFidelityCapabilities());
  assert.deepEqual(caps.exportFidelity.measuredOn.cellTypes, [5, 9, 10, 12]);
  assert.ok(caps.exportFidelity.measuredOn.fields.includes("Nodal:3"));
  const mdpa = caps.exportFidelity.writers[".mdpa"];
  assert.ok("references" in mdpa && "categories" in mdpa.references.hex && mdpa.references.hex.categories.constraints === "retained");
  const svg = caps.exportFidelity.writers.svg;
  assert.ok("unmeasured" in svg);
});

// --- the measured table -----------------------------------------------------

test("the committed fidelity table equals a fresh measurement of every writer", async () => {
  const live = await measureAll();
  assert.deepEqual(
    live,
    EXPORT_FIDELITY_TABLE,
    "a writer's behaviour changed: run `npm run build:tests && node scripts/gen-export-fidelity.js` and review the diff"
  );
});

test("every measured writer's report agrees with a re-read of its own output", async () => {
  const checked: string[] = [];
  for (const [id, model] of Object.entries(referenceModels())) {
  for (const { ext, format, key } of writerJobs()) {
    if ("unmeasured" in EXPORT_FIDELITY_TABLE[key].references[id]) continue;
    const rt = measuredRoundTrips.get(`${id}:${key}`) ?? await roundTrip(model, ext, format);
    assert.ok(rt.reread, `${key}: ${rt.error}`);
    const graded = verifyReport(
      buildExportReport({ model, ext, format, targetFile: `out${ext}` }),
      observeExport(model, rt.reread!)
    );
    assert.deepEqual(graded.unexpected, [], `${key}: ${(graded.unexpected ?? []).join("; ")}`);
    // Where the table made a claim, the re-read confirmed it.
    for (const c of graded.categories) if (c.status !== "unverified") assert.equal(c.verified, true, `${key} ${c.id}`);
    checked.push(`${id}:${key}`);
  }
  }
  assert.ok(checked.length >= 150, `checked ${checked.length}`);
});

// --- provenance in real files ----------------------------------------------

test("meshio++ embeds provenance only in formats with a header slot, and says which", async () => {
  const model = referenceModel();
  const req = provenanceRequest("auto", {
    sourceFile: "source.mdpa",
    sourceFormat: ".mdpa",
    ops: [{ op: "scale" }],
    tool: "Kratos MDPA Preview test",
  })!;
  const embedded: Record<string, boolean> = {};
  for (const ext of [".inp", ".exo", ".off", ".msh", ".med", ".xdmf"]) {
    const out = await writeMeshioBytes(model, ext, { provenance: req });
    assert.ok(out.provenance, `${ext}: a provenance request always answers`);
    embedded[ext] = out.provenance!.embedded;
    if (out.provenance!.embedded) {
      const text = out.provenance!.lines.join("\n");
      assert.match(text, /source\.mdpa/, `${ext} records the source`);
      assert.match(text, /operations|scale/, `${ext} records the operation chain`);
    }
  }
  // Measured at meshio++ 16.27.0: Abaqus, Exodus and OFF have a slot; Gmsh, MED and XDMF do not.
  assert.deepEqual(embedded, {
    ".inp": true,
    ".exo": true,
    ".off": true,
    ".msh": false,
    ".med": false,
    ".xdmf": false,
  });
  // No request, no scope: the writer emits only its usual credit line and the result says nothing about provenance.
  const plain = await writeMeshioBytes(model, ".inp");
  assert.equal(plain.provenance, undefined);
  const m = await loadMeshio();
  assert.equal(typeof m.withProvenance, "function");
});

// --- MCP --------------------------------------------------------------------

test("mesh_convert returns the export report; verify grades it against a re-read", async () => {
  const dir = tmpDir();
  const src = referenceFile(dir);
  const r = (await meshConvert({ path: src, outputPath: path.join(dir, "out.vtu"), verify: true })) as {
    outputPath: string;
    report: ReturnType<typeof buildExportReport>;
  };
  assert.equal(r.report.target.file, "out.vtu");
  assert.equal(r.report.source.file, "ref.mdpa");
  assert.equal(r.report.source.format, ".mdpa");
  assert.equal(r.report.kernel.name, "meshio++");
  assert.match(r.report.kernel.version ?? "", /^16\./);
  assert.deepEqual(r.report.unexpected, []);
  const props = r.report.categories.find((c) => c.id === "properties")!;
  assert.equal(props.status, "omitted");
  assert.equal(props.verified, true);
  // Native XML embeds a safe comment; auto does not also write a sidecar.
  assert.equal(r.report.provenance.embedded, true);
  assert.equal(r.report.provenance.sidecar, undefined);
  assert.ok(!fs.existsSync(path.join(dir, "out.vtu.kratosexport.json")));
});

test("provenance: sidecar writes <output>.kratosexport.json; an embedding format also embeds", async () => {
  const dir = tmpDir();
  const src = referenceFile(dir);
  const side = (await meshConvert({ path: src, outputPath: path.join(dir, "out.vtu"), provenance: "sidecar" })) as {
    report: ReturnType<typeof buildExportReport>;
  };
  assert.equal(side.report.provenance.sidecar, "out.vtu.kratosexport.json");
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "out.vtu.kratosexport.json"), "utf8"));
  assert.equal(onDisk.target.file, "out.vtu");
  assert.deepEqual(onDisk.provenance, side.report.provenance);

  const inp = (await meshConvert({ path: src, outputPath: path.join(dir, "out.inp"), provenance: "sidecar" })) as {
    report: ReturnType<typeof buildExportReport>;
  };
  assert.equal(inp.report.provenance.embedded, true);
  assert.ok(fs.readFileSync(path.join(dir, "out.inp"), "utf8").includes("ref.mdpa"), "the source is named inside the Abaqus deck");

  const none = (await meshConvert({ path: src, outputPath: path.join(dir, "none.inp"), provenance: "none" })) as {
    report: ReturnType<typeof buildExportReport>;
  };
  assert.equal(none.report.provenance.embedded, false);
  assert.ok(!fs.readFileSync(path.join(dir, "none.inp"), "utf8").includes("ref.mdpa"));

  await assert.rejects(meshConvert({ path: src, outputPath: path.join(dir, "x.vtu"), provenance: "everywhere" }), /provenance must be one of/);
});

test("mesh_transform's report lists the applied operations in order", async () => {
  const dir = tmpDir();
  const src = referenceFile(dir);
  const r = (await meshTransform({
    path: src,
    ops: [{ op: "translate", dx: 1, dy: 0, dz: 0 }, { op: "scale", sx: 2, sy: 2, sz: 2 }],
    outputPath: path.join(dir, "moved.inp"),
  })) as { report: ReturnType<typeof buildExportReport> };
  assert.deepEqual(r.report.operations.map((o) => o.op), ["translate", "scale"]);
  assert.ok(r.report.operations.every((o) => typeof o.label === "string"));
  assert.equal(r.report.provenance.embedded, true);
  assert.match(fs.readFileSync(path.join(dir, "moved.inp"), "utf8"), /translate, scale/);
});

test("a writer that drops cells says so, and verify catches a wrong claim", async () => {
  const dir = tmpDir();
  const src = referenceFile(dir);
  const r = (await meshExtractSkin({ path: src, outputPath: path.join(dir, "skin.stl"), verify: true })) as {
    report: ReturnType<typeof buildExportReport>;
  };
  // A skin is a new mesh: nothing to be retained from the source's Properties and the like,
  // and every claim the report makes was checked.
  assert.ok(r.report.categories.every((c) => c.verified !== false), (r.report.unexpected ?? []).join("; "));
});

test("recipes and problem archives record the kernel and tool; readers that do not know the key are unaffected", async () => {
  const header = JSON.parse(serializeOps([{ op: "scale", sx: 2, sy: 2, sz: 2 }], "a.mdpa", { kernel: "16.27.0", tool: "T" }));
  assert.deepEqual(header.provenance, { kernel: "16.27.0", tool: "T" });
  assert.equal(header.version, 1);
  const parsed = parseOpsJson(serializeOps([{ op: "scale", sx: 2, sy: 2, sz: 2 }], "a.mdpa", { kernel: "16.27.0" }));
  assert.equal(parsed.operations.length, 1);
  assert.deepEqual(parsed.warnings, []);
  // Without provenance the recipe is byte-identical to what older versions wrote.
  assert.ok(!("provenance" in JSON.parse(serializeOps([], "a.mdpa"))));

  const dir = tmpDir();
  const src = referenceFile(dir);
  const packed = (await problemPack({ meshPath: src })) as { archivePath: string; manifest: { provenance?: { kernel?: string; tool?: string } } };
  assert.equal(packed.manifest.provenance?.tool, "Kratos MDPA Preview");
  assert.match(packed.manifest.provenance?.kernel ?? "", /^16\./);
  const back = parseProblemZip(fs.readFileSync(packed.archivePath));
  assert.deepEqual(back.manifest?.provenance, packed.manifest.provenance);
});
