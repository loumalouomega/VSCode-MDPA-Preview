import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseMdpa } from "../parser/mdpaParser";
import { parseVtm, parseVtmIndex } from "../parser/vtkMultiblock";
import { parseMeshFile } from "../parser/meshFileParser";
import { parseVtkXml } from "../parser/vtkXmlParser";
import { writeVtm } from "../parser/writers/vtmWriter";
import { MdpaDiagnostic, MdpaModel } from "../parser/types";

// Two blocks, one part claiming the triangle: the quad is unclaimed geometry.
const SRC = `Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 1.0 1.0 0.0
4 0.0 1.0 0.0
5 2.0 0.0 0.0
End Nodes

Begin Elements Element2D3N
1 1 1 2 5
End Elements

Begin Elements Element2D4N
2 1 1 2 3 4
End Elements

Begin NodalData TEMPERATURE
1 0 100.0
3 0 300.0
End NodalData

Begin SubModelPart Inlet
  Begin SubModelPartNodes
  1
  2
  End SubModelPartNodes
  Begin SubModelPartElements
  1
  End SubModelPartElements
End SubModelPart
`;

const FIXTURE_DIR = path.resolve(__dirname, "../../src/test/fixtures/vtk/multiblock");

/** Writes a VTM result to a temp dir the way every host caller must. */
function writeOut(
  dir: string,
  name: string,
  r: { index: string; datasets: { file: string; data: Uint8Array }[] }
): string {
  const vtm = path.join(dir, name);
  fs.writeFileSync(vtm, r.index);
  for (const d of r.datasets) fs.writeFileSync(path.join(dir, d.file), d.data);
  return vtm;
}

test("one dataset per top-level part plus the unclaimed remainder", () => {
  const diags: MdpaDiagnostic[] = [];
  const r = writeVtm(parseMdpa(SRC), "case", diags);
  assert.deepEqual(
    r.datasets.map((d) => d.path),
    ["Inlet", "Base"]
  );
  assert.deepEqual(
    r.datasets.map((d) => d.file),
    ["case_Inlet.vtu", "case_Base.vtu"]
  );
  assert.deepEqual(diags, [], "no warnings for the ordinary shape");
  // The index nests each path; the reader resolves the same paths back.
  const entries = parseVtmIndex(Buffer.from(r.index));
  assert.deepEqual(entries.map((e) => e.path), ["Inlet", "Base"]);
  assert.deepEqual(entries.map((e) => e.file), ["case_Inlet.vtu", "case_Base.vtu"]);
});

test("a part-less model is a single dataset", () => {
  const bare: MdpaModel = { ...parseMdpa(SRC), subModelParts: [] };
  const r = writeVtm(bare, "solo");
  assert.equal(r.datasets.length, 1);
  assert.equal(r.datasets[0].file, "solo.vtu");
  const entries = parseVtmIndex(Buffer.from(r.index));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].file, "solo.vtu");
});

test("fully-covered geometry writes no Base dataset", () => {
  const m = parseMdpa(
    `Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
End Nodes

Begin Elements Element2D3N
1 0 1 2 3
End Elements

Begin SubModelPart All
  Begin SubModelPartNodes
  1
  2
  3
  End SubModelPartNodes
  Begin SubModelPartElements
  1
  End SubModelPartElements
End SubModelPart
`
  );
  const diags: MdpaDiagnostic[] = [];
  const r = writeVtm(m, "full", diags);
  assert.deepEqual(r.datasets.map((d) => d.path), ["All"]);
  assert.deepEqual(diags, []);
});

test("write → re-parse round-trips cells, parts and fields", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vtmwrite-"));
  const vtm = writeOut(dir, "case.vtm", writeVtm(parseMdpa(SRC), "case"));
  const back = await parseVtm(vtm, (p) => parseMeshFile(p));
  // Each .vtu is standalone, so the nodes two datasets share (1, 2 here) come
  // back twice — 3 + 5, the same duplication any multi-file export produces.
  // The cells, the part paths and the field values are all there.
  assert.equal(back.nodeCount, 8);
  assert.equal(
    back.blocks.reduce((n, b) => n + b.count, 0),
    2
  );
  assert.deepEqual(
    back.subModelParts.map((p) => p.path),
    ["Inlet", "Base"]
  );
  const temp = back.fields.find((f) => f.variable === "TEMPERATURE")!;
  assert.ok(temp, "the nodal field survives in the datasets that cover it");
  assert.deepEqual([...temp.ids], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([...temp.values], [100, 0, 0, 100, 0, 300, 0, 0]);
});

test("the committed fixture round-trips with identical part paths", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vtmwrite-"));
  const scene = await parseVtm(path.join(FIXTURE_DIR, "scene.vtm"), (p) =>
    parseMeshFile(p)
  );
  const r = writeVtm(scene, "scene");
  // Flat part lists re-emit as the same nested Block tree they were read from.
  assert.deepEqual(
    r.datasets.map((d) => d.path),
    ["Solids/Left", "Solids/Right"]
  );
  assert.ok(r.index.includes(`<Block name="Solids"`));
  const vtm = writeOut(dir, "scene.vtm", r);
  const back = await parseVtm(vtm, (p) => parseMeshFile(p));
  assert.equal(back.nodeCount, 6);
  assert.deepEqual(
    back.subModelParts.map((p) => p.path),
    ["Solids/Left", "Solids/Right"]
  );
  const temp = back.fields.find((f) => f.variable === "TEMP")!;
  assert.deepEqual([...temp.values], [1, 2, 3, 4, 5, 6]);
});

test("nested children collapse into the parent dataset with a diagnostic", () => {
  const m = parseMdpa(
    `Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
End Nodes

Begin Elements Element2D3N
1 0 1 2 3
End Elements

Begin SubModelPart Parent
  Begin SubModelPartNodes
  1
  2
  3
  End SubModelPartNodes
  Begin SubModelPartElements
  1
  End SubModelPartElements
  Begin SubModelPart Child
    Begin SubModelPartNodes
    1
    End SubModelPartNodes
  End SubModelPart
End SubModelPart
`
  );
  assert.equal(m.subModelParts[0].children.length, 1);
  const diags: MdpaDiagnostic[] = [];
  const r = writeVtm(m, "nested", diags);
  assert.deepEqual(r.datasets.map((d) => d.path), ["Parent"]);
  assert.equal(diags.length, 1);
  assert.match(diags[0].message, /nested subpart.*collapse/);
  // …but the cells are all there.
  const child = parseVtkXml(Buffer.from(r.datasets[0].data));
  assert.equal(child.blocks.reduce((n, b) => n + b.count, 0), 1);
});

test("a part already named Base pushes the remainder to Base_2", () => {
  const m = parseMdpa(
    `Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
4 5.0 5.0 0.0
End Nodes

Begin Elements Element2D3N
1 0 1 2 3
End Elements

Begin Elements Element2D3NSecond
2 0 1 2 4
End Elements

Begin SubModelPart Base
  Begin SubModelPartNodes
  1
  End SubModelPartNodes
  Begin SubModelPartElements
  1
  End SubModelPartElements
End SubModelPart
`
  );
  const diags: MdpaDiagnostic[] = [];
  const r = writeVtm(m, "clash", diags);
  assert.deepEqual(
    r.datasets.map((d) => d.path),
    ["Base", "Base_2"]
  );
  assert.ok(diags.some((d) => d.message.includes('"Base_2"')));
});

test("dataset filenames are sanitized and de-duplicated", () => {
  const m = parseMdpa(
    `Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
End Nodes

Begin Elements Element2D3N
1 0 1 2 3
End Elements

Begin SubModelPart A/B
  Begin SubModelPartNodes
  1
  3
  End SubModelPartNodes
  Begin SubModelPartElements
  1
  End SubModelPartElements
End SubModelPart

Begin SubModelPart A_B
  Begin SubModelPartNodes
  2
  End SubModelPartNodes
  Begin SubModelPartElements
  1
  End SubModelPartElements
End SubModelPart
`
  );
  const r = writeVtm(m, "case");
  const files = r.datasets.map((d) => d.file);
  // "A/B" flattens to "A_B", colliding with the real "A_B" — suffixed, never merged.
  assert.deepEqual(files, ["case_A_B.vtu", "case_A_B_2.vtu"]);
  for (const f of files) {
    assert.ok(!f.includes("/"), "companions stay flat beside the index");
    assert.ok(!f.includes(" "), "no separators survive sanitizing");
  }
});

test("an empty model still yields a valid single-dataset .vtm", () => {
  const empty: MdpaModel = {
    nodeCount: 0,
    nodeIds: new Int32Array(0),
    coords: new Float32Array(0),
    blocks: [],
    subModelParts: [],
    meta: [],
    fields: [],
    diagnostics: [],
    is3D: true,
    bounds: { min: [0, 0, 0], max: [0, 0, 0] },
  };
  const r = writeVtm(empty, "empty");
  assert.equal(r.datasets.length, 1);
  assert.match(r.index, /vtkMultiBlockDataSet/);
  const child = parseVtkXml(Buffer.from(r.datasets[0].data));
  assert.equal(child.nodeCount, 0);
});
