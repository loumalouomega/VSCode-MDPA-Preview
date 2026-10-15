import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { caseExportResults } from "../mcp/tools";
import { parseCaseJson, serializeCase } from "../problemtype/caseFile";
import { defaultCaseState } from "../problemtype/api";
import { shouldAutoExport, normalizeExportFormats } from "../problemtype/resultExport";
import { BUILTIN_PROBLEMTYPES } from "../problemtype/builtins";

const VTK_DIR = path.resolve(__dirname, "../../example/VTK");

/** A case folder holding the committed three-step Kratos series in vtk_output/. */
function makeCase(): { dir: string; mesh: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "result-export-"));
  const out = path.join(dir, "vtk_output");
  fs.mkdirSync(out);
  for (const n of ["Main_0_2.vtk", "Main_0_4.vtk", "Main_0_6.vtk"]) fs.copyFileSync(path.join(VTK_DIR, n), path.join(out, n));
  const mesh = path.join(dir, "case.mdpa");
  fs.writeFileSync(mesh, "Begin ModelPartData\nEnd ModelPartData\n");
  return { dir, mesh };
}

test("normalizeExportFormats / shouldAutoExport", () => {
  assert.deepEqual(normalizeExportFormats(["xdmf", " .EXO", "", ".xdmf"]), [".xdmf", ".exo"]);
  assert.equal(shouldAutoExport("finished", [".xdmf"]), true);
  assert.equal(shouldAutoExport("failed", [".xdmf"]), false);
  assert.equal(shouldAutoExport("cancelled", [".xdmf"]), false);
  assert.equal(shouldAutoExport("finished", []), false);
  assert.equal(shouldAutoExport("finished", undefined), false);
});

test("a series packs into one XDMF and one PVD, other formats go per step", async () => {
  const { dir, mesh } = makeCase();
  const r = (await caseExportResults({ meshPath: mesh, formats: [".xdmf", ".pvd", ".vtu"] })) as {
    folder: string; frames: number;
    written: { format: string; files: string[]; packed: boolean }[];
    skipped: { format: string; reason: string }[];
  };
  assert.equal(r.frames, 3);
  assert.equal(r.folder, path.join(dir, "converted"));
  const by = Object.fromEntries(r.written.map((w) => [w.format, w]));
  assert.equal(by[".xdmf"].packed, true);
  assert.ok(fs.existsSync(path.join(r.folder, "Main.xdmf")));
  assert.equal(by[".pvd"].packed, true);
  assert.ok(fs.existsSync(path.join(r.folder, "Main.pvd")));
  assert.equal(by[".vtu"].packed, false);
  assert.equal(by[".vtu"].files.length, 3);
  for (const f of by[".vtu"].files) assert.ok(fs.existsSync(f));
  assert.deepEqual(r.skipped, []);
});

test("an unwritable format is skipped with a reason and does not stop the others", async () => {
  const { mesh } = makeCase();
  const r = (await caseExportResults({ meshPath: mesh, formats: [".nope", ".stl"] })) as {
    written: { format: string }[]; skipped: { format: string; reason: string }[];
  };
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].format, ".nope");
  assert.deepEqual(r.written.map((w) => w.format), [".stl"]);
});

test("the export folder may not be the solver output folder", async () => {
  const { mesh } = makeCase();
  await assert.rejects(caseExportResults({ meshPath: mesh, formats: [".xdmf"], folder: "vtk_output" }), /inside the solver output/);
});

test("formats default to the case's saved output.exportFormats", async () => {
  const { dir, mesh } = makeCase();
  await assert.rejects(caseExportResults({ meshPath: mesh }), /Pass `formats`/);
  const state = defaultCaseState(BUILTIN_PROBLEMTYPES[0].decl);
  state.output.exportFormats = [".stl"];
  state.output.exportFolder = "stl_out";
  fs.writeFileSync(path.join(dir, "case.kratoscase.json"), serializeCase(state));
  const parsed = parseCaseJson(fs.readFileSync(path.join(dir, "case.kratoscase.json"), "utf8"));
  assert.deepEqual(parsed.state?.output.exportFormats, [".stl"]);
  const r = (await caseExportResults({ meshPath: mesh })) as { folder: string; written: { format: string }[] };
  assert.equal(r.folder, path.join(dir, "stl_out"));
  assert.deepEqual(r.written.map((w) => w.format), [".stl"]);
});
