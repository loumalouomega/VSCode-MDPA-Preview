/**
 * FLAC3D group handling — roadmap item 3. See flac3dGroups.ts's own doc
 * comment for what was measured against the live wasm and why.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import { MdpaModel } from "../parser/types";
import {
  cleanFlac3dPartNames,
  dropFlac3dInternalFields,
  parseFlac3dRegionName,
  reclassifyFlac3dFaces,
} from "../parser/flac3dGroups";
import { parseMeshFile } from "../parser/meshFileParser";
import { VtkCellType } from "../parser/geometryMap";

test("parseFlac3dRegionName splits <zone|face>:<name>:<slot>, last colon wins for the slot", () => {
  assert.deepEqual(parseFlac3dRegionName("zone:Inlet:Default"), {
    space: "zone",
    name: "Inlet",
    slot: "Default",
  });
  assert.deepEqual(parseFlac3dRegionName("face:Outlet:Group A"), {
    space: "face",
    name: "Outlet",
    slot: "Group A",
  });
  // A name that itself contains a colon: split on the LAST one.
  assert.deepEqual(parseFlac3dRegionName("zone:a:b:Default"), {
    space: "zone",
    name: "a:b",
    slot: "Default",
  });
  // Not this convention at all.
  assert.equal(parseFlac3dRegionName("Inlet"), undefined);
  assert.equal(parseFlac3dRegionName("kratos:smp/Inlet"), undefined);
  assert.equal(parseFlac3dRegionName("zone:NoSlot"), undefined);
});

function tinyModel(): MdpaModel {
  return {
    nodeCount: 4,
    nodeIds: Int32Array.from([1, 2, 3, 4]),
    coords: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    blocks: [
      {
        kind: "Elements",
        name: "tetra",
        vtkCellType: VtkCellType.TETRA,
        count: 1,
        stride: 4,
        entityIds: Int32Array.from([1]),
        connectivity: Int32Array.from([1, 2, 3, 4]),
      },
    ],
    subModelParts: [],
    meta: [],
    fields: [],
    diagnostics: [],
    is3D: true,
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  };
}

test("cleanFlac3dPartNames strips the prefix, folds Default away, keeps a non-Default slot visible", () => {
  const model: MdpaModel = {
    ...tinyModel(),
    subModelParts: [
      { name: "zone:Inlet:Default", path: "zone:Inlet:Default", nodeIds: new Int32Array(0), elementIds: Int32Array.from([1]), conditionIds: new Int32Array(0), geometryIds: new Int32Array(0), constraintIds: new Int32Array(0), children: [] },
      { name: "face:Outlet:Category A", path: "face:Outlet:Category A", nodeIds: new Int32Array(0), elementIds: new Int32Array(0), conditionIds: new Int32Array(0), geometryIds: new Int32Array(0), constraintIds: new Int32Array(0), children: [] },
      { name: "Plain", path: "Plain", nodeIds: new Int32Array(0), elementIds: new Int32Array(0), conditionIds: new Int32Array(0), geometryIds: new Int32Array(0), constraintIds: new Int32Array(0), children: [] },
    ],
  };
  const cleaned = cleanFlac3dPartNames(model);
  assert.deepEqual(
    cleaned.subModelParts.map((p) => p.name),
    ["Inlet", "Outlet (Category A)", "Plain"]
  );
  assert.deepEqual(
    cleaned.subModelParts.map((p) => p.path),
    ["Inlet", "Outlet (Category A)", "Plain"]
  );
});

test("cleanFlac3dPartNames de-duplicates a collision the cleanup itself creates", () => {
  const model: MdpaModel = {
    ...tinyModel(),
    subModelParts: [
      { name: "zone:Inlet:Default", path: "zone:Inlet:Default", nodeIds: new Int32Array(0), elementIds: Int32Array.from([1]), conditionIds: new Int32Array(0), geometryIds: new Int32Array(0), constraintIds: new Int32Array(0), children: [] },
      { name: "Inlet", path: "Inlet", nodeIds: new Int32Array(0), elementIds: new Int32Array(0), conditionIds: new Int32Array(0), geometryIds: new Int32Array(0), constraintIds: new Int32Array(0), children: [] },
    ],
  };
  const cleaned = cleanFlac3dPartNames(model);
  assert.deepEqual(cleaned.subModelParts.map((p) => p.name), ["Inlet_2", "Inlet"]);
});

test("cleanFlac3dPartNames is a noop for a mesh with nothing to clean", () => {
  const model = tinyModel();
  assert.equal(cleanFlac3dPartNames(model), model);
});

test("reclassifyFlac3dFaces moves a surface block to Conditions, remaps parts and splits a spanning field", () => {
  const model: MdpaModel = {
    nodeCount: 5,
    nodeIds: Int32Array.from([1, 2, 3, 4, 5]),
    coords: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0]),
    blocks: [
      {
        kind: "Elements",
        name: "tetra",
        vtkCellType: VtkCellType.TETRA,
        count: 1,
        stride: 4,
        entityIds: Int32Array.from([1]),
        connectivity: Int32Array.from([1, 2, 3, 4]),
      },
      {
        kind: "Elements",
        name: "triangle",
        vtkCellType: VtkCellType.TRIANGLE,
        count: 1,
        stride: 3,
        entityIds: Int32Array.from([2]),
        connectivity: Int32Array.from([1, 2, 5]),
      },
    ],
    subModelParts: [
      {
        name: "Mixed",
        path: "Mixed",
        nodeIds: new Int32Array(0),
        // Spans BOTH the volume element (1) and the face-origin element (2).
        elementIds: Int32Array.from([1, 2]),
        conditionIds: new Int32Array(0),
        geometryIds: new Int32Array(0),
        constraintIds: new Int32Array(0),
        children: [],
      },
    ],
    meta: [],
    // Spans both blocks too, so the field must SPLIT.
    fields: [
      {
        kind: "Elemental",
        variable: "DENSITY",
        components: 1,
        ids: Int32Array.from([1, 2]),
        values: Float64Array.from([100, 200]),
      },
    ],
    diagnostics: [],
    is3D: true,
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  };

  const out = reclassifyFlac3dFaces(model);

  assert.equal(out.blocks[0].kind, "Elements");
  assert.equal(out.blocks[1].kind, "Conditions");
  assert.deepEqual(Array.from(out.blocks[1].entityIds), [1]); // fresh Conditions id space, starts at 1

  const part = out.subModelParts[0];
  assert.deepEqual(Array.from(part.elementIds), [1]);
  assert.deepEqual(Array.from(part.conditionIds), [1]);

  assert.equal(out.fields.length, 2);
  const elemental = out.fields.find((f) => f.kind === "Elemental");
  const conditional = out.fields.find((f) => f.kind === "Conditional");
  assert.deepEqual(Array.from(elemental!.ids), [1]);
  assert.deepEqual(Array.from(elemental!.values), [100]);
  assert.deepEqual(Array.from(conditional!.ids), [1]);
  assert.deepEqual(Array.from(conditional!.values), [200]);
});

test("reclassifyFlac3dFaces is a noop for a pure-zone mesh", () => {
  const model = tinyModel();
  assert.equal(reclassifyFlac3dFaces(model), model);
});

test("dropFlac3dInternalFields drops cell_ids and nothing else", () => {
  const model: MdpaModel = {
    ...tinyModel(),
    fields: [
      { kind: "Elemental", variable: "cell_ids", components: 1, ids: Int32Array.from([1]), values: Float64Array.from([1]) },
      { kind: "Elemental", variable: "DENSITY", components: 1, ids: Int32Array.from([1]), values: Float64Array.from([7850]) },
    ],
  };
  const out = dropFlac3dInternalFields(model);
  assert.deepEqual(out.fields.map((f) => f.variable), ["DENSITY"]);
});

test("end to end: a real .f3grid round-trips through parseMeshFile with clean names and correct kinds", async () => {
  // Fixture: one tet zone group "Solid" + one triangle face group "Outlet",
  // plus the two per-block groups meshio++'s writer adds on its own
  // ("Element3D4N"/"Condition2D3N") — generated by writing a real MdpaModel
  // through writeMeshioBytes(".f3grid") and committed verbatim (see the
  // fixture's own header comment for provenance).
  const fsPath = path.resolve(__dirname, "../../src/test/fixtures/flac3d/two_groups.f3grid");
  const model = await parseMeshFile(fsPath);

  const byName = new Map(model.blocks.map((b) => [b.name, b]));
  assert.equal(byName.get("tetra")?.kind, "Elements");
  assert.equal(byName.get("triangle")?.kind, "Conditions");

  // No more zone:/face: prefixes or :Default suffixes.
  const partNames = model.subModelParts.map((p) => p.name).sort();
  assert.deepEqual(partNames, ["Condition2D3N", "Element3D4N", "Outlet", "Solid"]);

  const outlet = model.subModelParts.find((p) => p.name === "Outlet");
  assert.equal(outlet?.elementIds.length, 0);
  assert.equal(outlet?.conditionIds.length, 1);

  const solid = model.subModelParts.find((p) => p.name === "Solid");
  assert.equal(solid?.elementIds.length, 1);
  assert.equal(solid?.conditionIds.length, 0);

  // The reader's own bookkeeping field never shows up as a user field.
  assert.ok(!model.fields.some((f) => f.variable === "cell_ids"));
});
