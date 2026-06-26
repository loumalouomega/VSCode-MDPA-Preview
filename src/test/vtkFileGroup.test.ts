import { test } from "node:test";
import assert from "node:assert/strict";
import { groupVtkFiles, fileFor, findGroupForFile } from "../parser/vtkFileGroup";

// ---- Single root, no subparts ------------------------------------------------

test("single-step single file → one group, one step, no subparts", () => {
  const groups = groupVtkFiles(["Main_0_2.vtk"]);
  assert.equal(groups.length, 1);
  const g = groups[0];
  assert.equal(g.rootPrefix, "Main");
  assert.deepEqual(g.steps, ["2"]);
  assert.deepEqual(g.ranks, [0]);
  assert.deepEqual(g.subParts, []);
});

test("three steps single part → steps sorted numerically", () => {
  const files = ["Main_0_2.vtk", "Main_0_4.vtk", "Main_0_6.vtk"];
  const groups = groupVtkFiles(files);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].steps, ["2", "4", "6"]);
});

test("steps sort numerically not lexicographically (2 < 4 < 10, not 10 < 2 < 4)", () => {
  const files = ["Main_0_10.vtk", "Main_0_2.vtk", "Main_0_4.vtk"];
  const groups = groupVtkFiles(files);
  assert.deepEqual(groups[0].steps, ["2", "4", "10"]);
});

// ---- Subpart tree ------------------------------------------------------------

test("full 9-file example → one group with two subparts", () => {
  const files = [
    "Main_0_2.vtk", "Main_0_4.vtk", "Main_0_6.vtk",
    "Main_FixedEdgeNodes_0_2.vtk", "Main_FixedEdgeNodes_0_4.vtk", "Main_FixedEdgeNodes_0_6.vtk",
    "Main_MovingNodes_0_2.vtk",    "Main_MovingNodes_0_4.vtk",    "Main_MovingNodes_0_6.vtk",
  ];
  const groups = groupVtkFiles(files);
  assert.equal(groups.length, 1);
  const g = groups[0];
  assert.equal(g.rootPrefix, "Main");
  assert.deepEqual(g.steps, ["2", "4", "6"]);
  const sub = [...g.subParts].sort();
  assert.deepEqual(sub, ["FixedEdgeNodes", "MovingNodes"]);
});

// ---- Multiple root groups ----------------------------------------------------

test("two independent roots → two groups", () => {
  const files = [
    "ModelA_0_1.vtk", "ModelA_0_2.vtk",
    "ModelB_0_1.vtk",
  ];
  const groups = groupVtkFiles(files);
  assert.equal(groups.length, 2);
  const names = groups.map((g) => g.rootPrefix).sort();
  assert.deepEqual(names, ["ModelA", "ModelB"]);
});

// ---- Filtering ---------------------------------------------------------------

test("non-vtk files are ignored", () => {
  const groups = groupVtkFiles(["Main_0_2.vtk", "Main_0_2.mdpa", "README.txt"]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].steps.length, 1);
});

test("filenames without Kratos suffix pattern are ignored", () => {
  const groups = groupVtkFiles(["output.vtk", "mesh.vtk", "Main_0_1.vtk"]);
  assert.equal(groups.length, 1); // only Main_0_1 matches
});

// ---- fileFor helper ----------------------------------------------------------

test("fileFor returns correct filename", () => {
  const files = ["Main_0_2.vtk", "Main_0_4.vtk", "Main_FixedEdgeNodes_0_2.vtk"];
  const [g] = groupVtkFiles(files);
  assert.equal(fileFor(g, "Main", 0, "2"), "Main_0_2.vtk");
  assert.equal(fileFor(g, "Main", 0, "4"), "Main_0_4.vtk");
  assert.equal(fileFor(g, "Main_FixedEdgeNodes", 0, "2"), "Main_FixedEdgeNodes_0_2.vtk");
  assert.equal(fileFor(g, "Main", 0, "99"), undefined);
});

// ---- Underscore tolerance ----------------------------------------------------

test("part name with internal underscores parsed correctly", () => {
  // "Fixed_BC_0_2.vtk" → prefix="Fixed_BC", rank=0, step="2"
  const files = ["Fixed_BC_0_2.vtk", "Fixed_BC_0_4.vtk"];
  const groups = groupVtkFiles(files);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].rootPrefix, "Fixed_BC");
  assert.deepEqual(groups[0].steps, ["2", "4"]);
  assert.deepEqual(groups[0].subParts, []);
});

test("part name with multiple underscores and a subpart", () => {
  const files = [
    "My_Part_0_1.vtk",
    "My_Part_SubA_0_1.vtk",
  ];
  const groups = groupVtkFiles(files);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].rootPrefix, "My_Part");
  assert.deepEqual(groups[0].subParts, ["SubA"]);
});

// ---- findGroupForFile --------------------------------------------------------

test("findGroupForFile locates the group and step for the opened file", () => {
  const files = ["Main_0_2.vtk", "Main_0_4.vtk", "Main_Sub_0_2.vtk"];
  const groups = groupVtkFiles(files);
  const result = findGroupForFile(groups, "Main_0_4.vtk");
  assert.ok(result, "should find a result");
  assert.equal(result!.group.rootPrefix, "Main");
  assert.equal(result!.step, "4");
  assert.equal(result!.rank, 0);
});

test("findGroupForFile returns undefined for unrecognised file", () => {
  const groups = groupVtkFiles(["Main_0_1.vtk"]);
  assert.equal(findGroupForFile(groups, "unknown.vtk"), undefined);
  assert.equal(findGroupForFile(groups, "Other_0_1.vtk"), undefined);
});

// ---- Empty input -------------------------------------------------------------

test("empty file list → no groups", () => {
  assert.deepEqual(groupVtkFiles([]), []);
});

test("all non-matching files → no groups", () => {
  assert.deepEqual(groupVtkFiles(["file.mdpa", "README.md"]), []);
});
