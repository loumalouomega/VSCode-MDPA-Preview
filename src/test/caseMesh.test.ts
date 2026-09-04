import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { defaultCaseState } from "../problemtype/api";
import { structural } from "../problemtype/builtins/structural";
import { CaseState } from "../problemtype/types";
import { planCaseMesh } from "../problemtype/caseMesh";

// One tetrahedron (3D) with SubModelParts — same shape as mcpTools.test.ts.
const MDPA_3D = `Begin Properties 0
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

Begin SubModelPart Parts
  Begin SubModelPart Solid
    Begin SubModelPartNodes
    1
    2
    3
    4
    End SubModelPartNodes
    Begin SubModelPartElements
    1
    End SubModelPartElements
  End SubModelPart
End SubModelPart
`;

function structuralState(): CaseState {
  const state = defaultCaseState(structural.decl);
  state.assignments = [{ conditionId: "parts", smpPath: "Parts/Solid", values: {} }];
  state.materials = [
    { smpPath: "Parts/Solid", lawId: "linear_elastic_3d", values: { YOUNG_MODULUS: 2.0e11 } },
  ];
  return state;
}

test("an .mdpa source is referenced directly when no rename occurred", () => {
  // Point-only fixture: stride-1 blocks are kept as-is, so nothing renames.
  const model = parseMdpa(`Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
End Nodes

Begin SubModelPart P
  Begin SubModelPartNodes
  1
  End SubModelPartNodes
End SubModelPart
`);
  const plan = planCaseMesh(structural, model, defaultCaseState(structural.decl), "beam", true);
  assert.equal(plan.shouldWriteMesh, false);
  assert.equal(plan.caseStem, "beam");
  assert.deepEqual(plan.renames, []);
});

test("an .mdpa source needing renames writes a _case copy", () => {
  const model = parseMdpa(MDPA_3D);
  const plan = planCaseMesh(structural, model, structuralState(), "beam", true);
  assert.ok(plan.renames.length > 0);
  assert.equal(plan.shouldWriteMesh, true);
  assert.equal(plan.caseStem, "beam_case");
});

test("a non-.mdpa source is always converted, even with nothing to rename", () => {
  const model = parseMdpa(`Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
End Nodes

Begin SubModelPart P
  Begin SubModelPartNodes
  1
  End SubModelPartNodes
End SubModelPart
`);
  const plan = planCaseMesh(structural, model, defaultCaseState(structural.decl), "beam", false);
  assert.equal(plan.shouldWriteMesh, true);
  assert.equal(plan.caseStem, "beam_case");
});

test("a mesh with no SubModelParts warns when assignments exist, not otherwise", () => {
  const model = parseMdpa(`Begin Properties 0
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
`);
  assert.equal(model.subModelParts.length, 0);
  const withAssignments = planCaseMesh(structural, model, structuralState(), "beam", true);
  assert.ok(withAssignments.warnings.some((w) => w.includes("no SubModelParts")));
  const bare = planCaseMesh(structural, model, defaultCaseState(structural.decl), "beam", true);
  assert.ok(!bare.warnings.some((w) => w.includes("no SubModelParts")));
});
