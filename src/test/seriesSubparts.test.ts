import test from "node:test";
import assert from "node:assert/strict";
import { mergeSubparts } from "../parser/seriesSubparts";
import { groupVtkFiles } from "../parser/vtkFileGroup";
import { parseMdpa } from "../parser/mdpaParser";

function mesh() {
  return parseMdpa(`Begin Nodes
10 0 0 0
30 1 0 0
90 0 1 0
End Nodes
Begin Elements Element2D3N
7 0 10 30 90
End Elements
Begin Conditions SurfaceCondition3D3N
8 0 10 30 90
End Conditions
Begin Geometries Triangle3D3
9 10 30 90
End Geometries
Begin SubModelPart Native
Begin SubModelPartNodes
10
End SubModelPartNodes
End SubModelPart`);
}

test("filename subparts preserve native groups, sparse IDs and all root entity kinds", async () => {
  const root = mesh();
  const sub = mesh();
  sub.nodeIds = Int32Array.from([100, 300, 900]);
  sub.blocks = [sub.blocks[0]];
  sub.blocks[0].connectivity = Int32Array.from([900, 100, 300]);
  // A triangle in the source can identify a root element, condition or geometry.
  for (const block of [...root.blocks, ...sub.blocks]) block.vtkCellType = 5;
  const [group] = groupVtkFiles(["Main_0_1.obj", "Main_Edge_0_1.obj"], [".obj"]);
  const parts = await mergeSubparts(root, group, "/tmp", 0, "1", "Main", async () => sub);
  assert.equal(parts[0], root.subModelParts[0]);
  assert.deepEqual([...parts[1].nodeIds], [10, 30, 90]);
  assert.deepEqual([...parts[1].elementIds], [7]);
  assert.deepEqual([...parts[1].conditionIds], [8]);
  assert.deepEqual([...parts[1].geometryIds], [9]);
});

test("absent, unreadable and unmatched subparts keep the root groups and report diagnostics", async () => {
  const root = mesh();
  const [group] = groupVtkFiles(["Main_0_1.ply", "Main_0_2.ply", "Main_Edge_0_2.ply"], [".ply"]);
  let reads = 0;
  const load = async () => { reads++; throw new Error("bad subpart"); };
  assert.deepEqual(await mergeSubparts(root, group, "/tmp", 0, "1", "Main", load), root.subModelParts);
  assert.equal(reads, 0);
  assert.deepEqual(await mergeSubparts(root, group, "/tmp", 0, "2", "Main", load), root.subModelParts);
  assert.match(root.diagnostics[root.diagnostics.length - 1].message, /subpart omitted/);
  const sub = mesh();
  sub.coords.fill(42);
  const parts = await mergeSubparts(root, group, "/tmp", 0, "2", "Main", async () => sub);
  assert.equal(parts[1].nodeIds.length, 0);
  assert.equal(parts[1].elementIds.length, 0);
  assert.match(root.diagnostics[root.diagnostics.length - 1].message, /could not be matched/);
});
