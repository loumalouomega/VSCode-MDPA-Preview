/**
 * extractSkin.ts — the boundary of a volume mesh as a standalone surface
 * model. Pure, no wasm.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { extractSkinModel } from "../parser/extractSkin";
import { parseMdpa } from "../parser/mdpaParser";

const TET_SRC = `Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
4 0.0 0.0 1.0
End Nodes

Begin Elements Element3D4N
1 0 1 2 3 4
End Elements

Begin NodalData T
1 10.0
2 20.0
3 30.0
4 40.0
End NodalData

Begin SubModelPart Base
  Begin SubModelPartNodes
  1
  2
  3
  End SubModelPartNodes
  Begin SubModelPartElements
  1
  End SubModelPartElements
End SubModelPart
`;

test("a single tetra's skin is its own 4 faces", () => {
  const model = parseMdpa(TET_SRC);
  const r = extractSkinModel(model);
  assert.equal(r.faces, 4);
  assert.equal(r.model.blocks[0].vtkCellType, 5); // TRIANGLE
  assert.equal(r.model.blocks[0].count, 4);
  assert.equal(r.model.nodeCount, 4); // all 4 nodes are on the boundary
});

test("two tets sharing a face have only the OUTER faces on the skin", () => {
  const src = `Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
4 0.0 0.0 1.0
5 1.0 1.0 1.0
End Nodes

Begin Elements Element3D4N
1 0 1 2 3 4
2 0 2 3 4 5
End Elements
`;
  const model = parseMdpa(src);
  const r = extractSkinModel(model);
  // 4 + 4 faces total, one shared pair excluded -> 6 boundary faces.
  assert.equal(r.faces, 6);
});

test("original node ids and coordinates are preserved", () => {
  const model = parseMdpa(TET_SRC);
  const r = extractSkinModel(model);
  assert.deepEqual(
    Array.from(r.model.nodeIds).sort((a, b) => a - b),
    [1, 2, 3, 4]
  );
  // Node 4's coordinate (0,0,1) must still be there under id 4.
  const i = Array.from(r.model.nodeIds).indexOf(4);
  assert.deepEqual(
    [r.model.coords[i * 3], r.model.coords[i * 3 + 1], r.model.coords[i * 3 + 2]],
    [0, 0, 1]
  );
});

test("Nodal fields survive, narrowed to the surviving nodes", () => {
  const model = parseMdpa(TET_SRC);
  const r = extractSkinModel(model);
  const t = r.model.fields.find((f) => f.variable === "T")!;
  assert.equal(t.ids.length, 4); // every node of a single tet is on its skin
});

test("Elemental fields are NOT carried across (ids don't correspond)", () => {
  const src = `Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
4 0.0 0.0 1.0
End Nodes

Begin Elements Element3D4N
1 0 1 2 3 4
End Elements

Begin ElementalData MAT
1 7.0
End ElementalData
`;
  const model = parseMdpa(src);
  const r = extractSkinModel(model);
  assert.equal(r.model.fields.find((f) => f.variable === "MAT"), undefined);
});

test("SubModelParts narrow to node membership on the skin", () => {
  const model = parseMdpa(TET_SRC);
  const r = extractSkinModel(model);
  const base = r.model.subModelParts.find((p) => p.path === "Base")!;
  assert.ok(base);
  assert.deepEqual(Array.from(base.nodeIds).sort((a, b) => a - b), [1, 2, 3]);
  assert.equal(base.elementIds.length, 0, "element membership cannot cross the extraction");
});

test("a pre-existing surface block passes through unchanged", () => {
  const src = `Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
End Nodes

Begin Elements Element2D3N
1 0 1 2 3
End Elements
`;
  const model = parseMdpa(src);
  const r = extractSkinModel(model);
  assert.equal(r.faces, 1);
  assert.deepEqual(Array.from(r.model.blocks[0].connectivity), [1, 2, 3]);
});

test("a mesh with no volume or surface cells yields an empty skin, not a crash", () => {
  const src = `Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
End Nodes

Begin Elements Element3D2N
1 0 1 2
End Elements
`;
  const model = parseMdpa(src);
  const r = extractSkinModel(model);
  assert.equal(r.faces, 0);
  assert.equal(r.model.blocks.length, 0);
});

test("never mutates the input model", () => {
  const model = parseMdpa(TET_SRC);
  const snapshot = model.blocks[0].connectivity.slice();
  extractSkinModel(model);
  assert.deepEqual(model.blocks[0].connectivity, snapshot);
});
