import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { couplingInterfaceDeclarationProblems, interfacePairProblems, interfacePairs } from "../problemtype/interfaceCheck";
import { fsi } from "../problemtype/builtins/fsi";
import { cosim } from "../problemtype/builtins/cosim";
import type { Assignment, ProblemtypeDeclaration } from "../problemtype/types";

// Two unit squares side by side in 2D: the fluid on the left (x 0..1), the
// solid on the right (x 1..2), sharing the edge x = 1. A third, far-away edge
// (x = 5) lets a pairing miss.
const MDPA_2D = `Begin Nodes
1 0 0 0
2 1 0 0
3 1 1 0
4 0 1 0
5 1 0 0
6 2 0 0
7 2 1 0
8 1 1 0
9 5 0 0
10 5 1 0
End Nodes

Begin Elements Element2D4N
1 0 1 2 3 4
2 0 5 6 7 8
End Elements

Begin Conditions LineCondition2D2N
1 0 2 3
2 0 5 8
3 0 9 10
End Conditions

Begin SubModelPart FluidEdge
  Begin SubModelPartNodes
  2
  3
  End SubModelPartNodes
  Begin SubModelPartConditions
  1
  End SubModelPartConditions
End SubModelPart

Begin SubModelPart SolidEdge
  Begin SubModelPartNodes
  5
  8
  End SubModelPartNodes
  Begin SubModelPartConditions
  2
  End SubModelPartConditions
End SubModelPart

Begin SubModelPart FarEdge
  Begin SubModelPartNodes
  9
  10
  End SubModelPartNodes
  Begin SubModelPartConditions
  3
  End SubModelPartConditions
End SubModelPart

Begin SubModelPart NodesOnly
  Begin SubModelPartNodes
  2
  3
  End SubModelPartNodes
End SubModelPart

Begin SubModelPart Solid
  Begin SubModelPartNodes
  5
  6
  7
  8
  End SubModelPartNodes
  Begin SubModelPartElements
  2
  End SubModelPartElements
End SubModelPart
`;

const a = (conditionId: string, smpPath: string): Assignment => ({ conditionId, smpPath, values: {} });
const decl = fsi.decl as ProblemtypeDeclaration;

test("a matching pair of 2D edges that touch passes", () => {
  const model = parseMdpa(MDPA_2D);
  assert.deepEqual(interfacePairProblems(decl, model, [a("fluidInterface", "FluidEdge"), a("structureInterface", "SolidEdge")], 2), []);
});

test("a pair that does not overlap is refused, naming both parts", () => {
  const model = parseMdpa(MDPA_2D);
  const problems = interfacePairProblems(decl, model, [a("fluidInterface", "FluidEdge"), a("structureInterface", "FarEdge")], 2);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /"FluidEdge" and "FarEdge" do not overlap/);
});

test("pairs follow assignment order", () => {
  const model = parseMdpa(MDPA_2D);
  const swapped = [
    a("fluidInterface", "FluidEdge"),
    a("fluidInterface", "FarEdge"),
    a("structureInterface", "FarEdge"),
    a("structureInterface", "SolidEdge"),
  ];
  assert.deepEqual(interfacePairs(decl.couplingInterfaces![0], swapped), [
    ["FluidEdge", "FarEdge"],
    ["FarEdge", "SolidEdge"],
  ]);
  assert.equal(interfacePairProblems(decl, model, swapped, 2).length, 2);
  const ordered = [swapped[0], swapped[1], swapped[3], swapped[2]];
  assert.deepEqual(interfacePairProblems(decl, model, ordered, 2), []);
});

test("a node-only side, a volume side and the wrong dimension are refused", () => {
  const model = parseMdpa(MDPA_2D);
  const nodes = interfacePairProblems(decl, model, [a("fluidInterface", "NodesOnly"), a("structureInterface", "SolidEdge")], 2);
  assert.match(nodes.join("|"), /"NodesOnly" \(FSI fluid interface\) has no line conditions or elements — only nodes/);
  const area = interfacePairProblems(decl, model, [a("fluidInterface", "FluidEdge"), a("structureInterface", "Solid")], 2);
  assert.match(area.join("|"), /"Solid" \(FSI structure interface\) has no line .* \(it holds surface cells\)/);
  // The same edges read as a 3D case need faces.
  const as3d = interfacePairProblems(decl, model, [a("fluidInterface", "FluidEdge"), a("structureInterface", "SolidEdge")], 3);
  assert.equal(as3d.length, 2);
  assert.match(as3d[0], /no surface \(face\) conditions or elements \(it holds line cells\)/);
});

test("count mismatch is refused; a missing side or part is left to the other checks", () => {
  const model = parseMdpa(MDPA_2D);
  const mismatch = interfacePairProblems(
    decl,
    model,
    [a("fluidInterface", "FluidEdge"), a("fluidInterface", "FarEdge"), a("structureInterface", "SolidEdge")],
    2
  );
  assert.match(mismatch[0], /FSI interface: 2 SubModelParts assigned as "FSI fluid interface" but 1 as "FSI structure interface"/);
  assert.deepEqual(interfacePairProblems(decl, model, [a("fluidInterface", "FluidEdge")], 2), []);
  assert.deepEqual(interfacePairProblems(decl, model, [a("fluidInterface", "Ghost"), a("structureInterface", "SolidEdge")], 2), []);
});

test("cosim declares the same interface pair; declarations are checked", () => {
  assert.deepEqual(cosim.decl.couplingInterfaces, [{ label: "Coupling interface", sides: ["fluidInterface", "structureInterface"] }]);
  assert.deepEqual(couplingInterfaceDeclarationProblems(decl), []);
  const bad = { ...decl, couplingInterfaces: [{ label: "x", sides: ["fluidInterface", "f_inlet"] as [string, string] }, { label: "y", sides: ["nope", "structureInterface"] as [string, string] }] };
  const problems = couplingInterfaceDeclarationProblems(bad);
  assert.match(problems.join("|"), /both sides belong to domain "fluid"/);
  assert.match(problems.join("|"), /unknown condition "nope"/);
});
