/**
 * Exporting an optimization run's final geometry as CAD: frame resolution,
 * shape/topology refusals, and both STEP builds end to end (lean artifact for
 * the faceted STEP, full artifact for the fitted one — same split the .step
 * export's own tests use).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { writeMeshFile } from "../parser/writers/meshWriter";
import { parseMeshFile } from "../parser/meshFileParser";
import {
  buildOptimizedCad,
  guessDensityField,
  resolveOptimizedFrame,
  scalarFieldsOf,
} from "../problemtype/optimization/cadExport";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "optcad-"));
}

const PARAMS_WITH_FIELDS = JSON.stringify({
  processes: {
    optimization_data_processes: {
      output: [
        { type: "optimization_problem_vtu_output_process", settings: { output_path: "Optimization_Results" } },
      ],
    },
  },
});

/** A case folder with (or without) design fields configured; frames added by the test. */
function caseDir(withFields: boolean): string {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "optimization_parameters.json"), withFields ? PARAMS_WITH_FIELDS : "{}");
  return dir;
}

const CUBE_SKIN_MDPA =
  "Begin Nodes\n" +
  "1 0 0 0\n2 1 0 0\n3 1 1 0\n4 0 1 0\n5 0 0 1\n6 1 0 1\n7 1 1 1\n8 0 1 1\n" +
  "End Nodes\n" +
  "Begin Conditions SurfaceCondition3D3N\n" +
  "1 0 1 3 2\n2 0 1 4 3\n3 0 5 6 7\n4 0 5 7 8\n" +
  "5 0 1 2 6\n6 0 1 6 5\n7 0 2 3 7\n8 0 2 7 6\n" +
  "9 0 3 4 8\n10 0 3 8 7\n11 0 4 1 5\n12 0 4 5 8\n" +
  "End Conditions\n";

// A 3x3x3 hex block with the center cell at density 1 and void elsewhere: an
// Elemental field, so the topology path must average it to the nodes first.
// Nodal values peak at 1/8 (the center cell's nodes are shared 8 ways), so the
// 0.05 level set wraps the center in a CLOSED solid strictly inside the block.
function blockMdpa(): string {
  const id = (x: number, y: number, z: number): number => x + 4 * y + 16 * z + 1;
  const nodes: string[] = [];
  for (let z = 0; z <= 3; z++) for (let y = 0; y <= 3; y++) for (let x = 0; x <= 3; x++) nodes.push(`${id(x, y, z)} ${x} ${y} ${z}`);
  const elements: string[] = [];
  const densities: string[] = [];
  let n = 0;
  for (let iz = 0; iz < 3; iz++) for (let iy = 0; iy < 3; iy++) for (let ix = 0; ix < 3; ix++) {
    n++;
    elements.push(
      `${n} 0 ${id(ix, iy, iz)} ${id(ix + 1, iy, iz)} ${id(ix + 1, iy + 1, iz)} ${id(ix, iy + 1, iz)} ` +
      `${id(ix, iy, iz + 1)} ${id(ix + 1, iy, iz + 1)} ${id(ix + 1, iy + 1, iz + 1)} ${id(ix, iy + 1, iz + 1)}`
    );
    densities.push(`${n} ${ix === 1 && iy === 1 && iz === 1 ? 1.0 : 0.0}`);
  }
  return (
    "Begin Nodes\n" + nodes.join("\n") + "\nEnd Nodes\n" +
    "Begin Elements Hexahedron3D8N\n" + elements.join("\n") + "\nEnd Elements\n" +
    "Begin ElementalData DENSITY\n" + densities.join("\n") + "\nEnd ElementalData\n"
  );
}

async function modelFromText(text: string, name: string): Promise<{ dir: string; file: string }> {
  const dir = tmpDir();
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return { dir, file };
}

/** Writes `model` as the case's newest design-field frame and returns the case dir. */
async function caseWithFrame(frameFileName: string, mdpaText: string): Promise<string> {
  const dir = caseDir(true);
  const outDir = path.join(dir, "Optimization_Results");
  fs.mkdirSync(outDir, { recursive: true });
  const { file } = await modelFromText(mdpaText, "frame.mdpa");
  const model = await parseMeshFile(file);
  // The native VTU writer (what the solver's own frames are): fields ride along.
  fs.writeFileSync(path.join(outDir, frameFileName), writeMeshFile(model, ".vtu"));
  return dir;
}

test("resolveOptimizedFrame refuses a folder with no optimization case", () => {
  assert.throws(() => resolveOptimizedFrame(tmpDir()), /optimization_parameters\.json/);
});

test("resolveOptimizedFrame refuses a case that writes no design fields", () => {
  assert.throws(() => resolveOptimizedFrame(caseDir(false)), /no design fields/);
});

test("resolveOptimizedFrame refuses before the first frame is written", () => {
  assert.throws(() => resolveOptimizedFrame(caseDir(true)), /No results in Optimization_Results\/ yet/);
});

test("resolveOptimizedFrame picks the numerically latest frame, and excludeNewest drops it", () => {
  const dir = caseDir(true);
  const outDir = path.join(dir, "Optimization_Results");
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of ["Structure_0_2.vtm", "Structure_0_10.vtm"]) fs.writeFileSync(path.join(outDir, name), "");
  assert.equal(resolveOptimizedFrame(dir).fileName, "Structure_0_10.vtm");
  assert.equal(resolveOptimizedFrame(dir, { excludeNewest: true }).fileName, "Structure_0_2.vtm");
});

test("scalarFieldsOf lists scalars; guessDensityField pre-selects a density-like one", async () => {
  const { file } = await modelFromText(blockMdpa(), "hex.mdpa");
  const model = await parseMeshFile(file);
  const scalars = scalarFieldsOf(model);
  assert.ok(scalars.some((f) => f.variable === "DENSITY" && f.kind === "Elemental"), JSON.stringify(scalars));
  assert.equal(guessDensityField(model), "DENSITY");
});

test("shape mode writes the frame mesh as a faceted STEP", async () => {
  const dir = await caseWithFrame("Structure_0_3.vtu", CUBE_SKIN_MDPA);
  const out = await buildOptimizedCad(dir, { mode: "shape", fitCad: false });
  assert.ok(Buffer.from(out.data).toString("utf8", 0, 14) === "ISO-10303-21;\n", "a real AP214 STEP file");
  assert.deepEqual(out.companions, [], "faceted: no B-rep companion");
  assert.equal(out.mode, "shape");
  assert.ok(out.frame.fileName === "Structure_0_3.vtu");
});

test("shape mode with kernel defaults fits the skin like File Export CAD does", async () => {
  const dir = await caseWithFrame("Structure_0_5.vtu", CUBE_SKIN_MDPA);
  const out = await buildOptimizedCad(dir, { mode: "shape" });
  assert.ok(Buffer.from(out.data).toString("utf8", 0, 14) === "ISO-10303-21;\n");
  assert.ok(out.companions.some((c) => c.name.endsWith(".cad.json")), "the B-rep companion rides beside it");
  assert.ok(out.notes.some((n) => n.includes("fitted CAD B-rep via fitCad")), out.notes.join(" | "));
});

test("topology mode contours an Elemental density (averaged to the nodes) into a faceted STEP", async () => {
  const dir = await caseWithFrame("Structure_0_7.vtu", blockMdpa());
  const out = await buildOptimizedCad(dir, { mode: "topology", densityField: "DENSITY", threshold: 0.05, fitCad: false });
  assert.ok(Buffer.from(out.data).toString("utf8", 0, 14) === "ISO-10303-21;\n");
  assert.equal(out.mode, "topology");
  assert.equal(out.densityField, "DENSITY");
  assert.equal(out.threshold, 0.05);
  assert.equal(out.averagedToNodal, true);
  assert.ok(out.notes.some((n) => n.includes("at 0.05")), out.notes.join(" | "));
});

test("topology mode refuses without a density field, naming the frame's scalars", async () => {
  const dir = await caseWithFrame("Structure_0_7.vtu", blockMdpa());
  await assert.rejects(buildOptimizedCad(dir, { mode: "topology", fitCad: false }), /needs the density field.*DENSITY/);
});

test("topology mode refuses an unknown field and an uncrossed threshold", async () => {
  const dir = await caseWithFrame("Structure_0_7.vtu", blockMdpa());
  await assert.rejects(buildOptimizedCad(dir, { mode: "topology", densityField: "NOPE", fitCad: false }), /No scalar field named "NOPE"/);
  await assert.rejects(
    buildOptimizedCad(dir, { mode: "topology", densityField: "DENSITY", threshold: 2, fitCad: false }),
    /never crosses 2/
  );
});
