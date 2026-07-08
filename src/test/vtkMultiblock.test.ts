import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseVtm, parseVtmIndex } from "../parser/vtkMultiblock";
import { parseMeshFile } from "../parser/meshFileParser";

const FIXTURE_DIR = path.resolve(__dirname, "../../src/test/fixtures/vtk/multiblock");

test("parseVtmIndex walks the Block/DataSet tree with slash paths", () => {
  const buf = fs.readFileSync(path.join(FIXTURE_DIR, "scene.vtm"));
  const sets = parseVtmIndex(buf);
  assert.equal(sets.length, 2);
  assert.deepEqual(sets.map((s) => s.path), ["Solids/Left", "Solids/Right"]);
  assert.deepEqual(sets.map((s) => s.file), ["left.vtu", "right.vtu"]);
});

test("parseVtm merges blocks with node/entity offsets and per-block SubModelParts", async () => {
  const m = await parseVtm(
    path.join(FIXTURE_DIR, "scene.vtm"),
    (p) => parseMeshFile(p)
  );
  assert.equal(m.nodeCount, 6);
  // second block's coordinates preserved
  assert.ok(Math.abs(m.coords[3 * 3] - 2) < 1e-6);

  // blocks prefixed with their block path
  assert.equal(m.blocks.length, 2);
  assert.ok(m.blocks[0].name.startsWith("Solids/Left"));
  assert.ok(m.blocks[1].name.startsWith("Solids/Right"));
  // connectivity of second block offset by 3 nodes
  assert.deepEqual([...m.blocks[1].connectivity], [4, 5, 6]);
  // entity ids globally sequential
  assert.deepEqual([...m.blocks[0].entityIds], [1]);
  assert.deepEqual([...m.blocks[1].entityIds], [2]);

  // one SubModelPart per DataSet
  assert.equal(m.subModelParts.length, 2);
  const left = m.subModelParts[0];
  assert.equal(left.name, "Left");
  assert.equal(left.path, "Solids/Left");
  assert.deepEqual([...left.nodeIds], [1, 2, 3]);
  assert.deepEqual([...left.elementIds], [1]);
  const right = m.subModelParts[1];
  assert.deepEqual([...right.nodeIds], [4, 5, 6]);
  assert.deepEqual([...right.elementIds], [2]);

  // same-named fields concatenated with offset ids
  const temp = m.fields.find((f) => f.variable === "TEMP")!;
  assert.deepEqual([...temp.ids], [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...temp.values], [1, 2, 3, 4, 5, 6]);
});

test("parseVtm rejects DataSet paths escaping the .vtm directory", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vtm-"));
  fs.writeFileSync(
    path.join(dir, "evil.vtm"),
    `<?xml version="1.0"?>
<VTKFile type="vtkMultiBlockDataSet">
  <vtkMultiBlockDataSet>
    <DataSet index="0" name="Out" file="../outside.vtu"/>
  </vtkMultiBlockDataSet>
</VTKFile>
`
  );
  const m = await parseVtm(path.join(dir, "evil.vtm"), (p) => parseMeshFile(p));
  assert.equal(m.nodeCount, 0);
  assert.ok(m.diagnostics.some((d) => d.message.includes("outside")));
});

test("failed child parse → diagnostic, other blocks still load", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vtm-"));
  fs.copyFileSync(path.join(FIXTURE_DIR, "left.vtu"), path.join(dir, "ok.vtu"));
  fs.writeFileSync(path.join(dir, "broken.vtu"), "not xml at all");
  fs.writeFileSync(
    path.join(dir, "scene.vtm"),
    `<?xml version="1.0"?>
<VTKFile type="vtkMultiBlockDataSet">
  <vtkMultiBlockDataSet>
    <DataSet index="0" name="Ok" file="ok.vtu"/>
    <DataSet index="1" name="Broken" file="broken.vtu"/>
  </vtkMultiBlockDataSet>
</VTKFile>
`
  );
  const m = await parseVtm(path.join(dir, "scene.vtm"), (p) => parseMeshFile(p));
  assert.equal(m.nodeCount, 3);
  assert.equal(m.blocks.length, 1);
  assert.ok(m.diagnostics.length > 0);
});

test("dispatcher routes .vtm", async () => {
  const m = await parseMeshFile(path.join(FIXTURE_DIR, "scene.vtm"));
  assert.equal(m.nodeCount, 6);
  assert.equal(m.subModelParts.length, 2);
});
