import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { findSubModelPart } from "../parser/subModelPartExtract";
import { generateCase } from "../problemtype/generate";
import { planCaseMesh } from "../problemtype/caseMesh";
import { defaultCaseState } from "../problemtype/api";
import { emitLoadConditions, siblingPathFor } from "../problemtype/emitLoadConditions";
import { structural } from "../problemtype/builtins/structural";
import type { CaseState } from "../problemtype/types";

// A tetrahedron with a node-only Support part (point loads) and a line-only
// Loaded part (moving loads travel over its two line elements).
const MESH = `Begin Properties 0
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

Begin Elements Element3D2N
2 0 1 2
3 0 2 3
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

Begin SubModelPart Support
  Begin SubModelPartNodes
  1
  2
  3
  End SubModelPartNodes
End SubModelPart

Begin SubModelPart Loaded
  Begin SubModelPartElements
  2
  3
  End SubModelPartElements
End SubModelPart
`;

const pointEmit = { sibling: "PointLoad", source: "nodes", family: "point" } as const;

function emitOf(conditionId: string) {
  return conditionId === "pointLoad" ? { ...pointEmit } : undefined;
}

test("siblingPathFor appends the suffix under the same parent", () => {
  assert.equal(siblingPathFor("Support", "PointLoad"), "SupportPointLoad");
  assert.equal(siblingPathFor("Parts/Solid", "MovingLoad"), "Parts/SolidMovingLoad");
});

test("point loads emit one 1N condition per node into a sibling", () => {
  const model = parseMdpa(MESH);
  const out = emitLoadConditions(
    model,
    [{ smpPath: "Support", conditionId: "pointLoad" }],
    { domainSize: 3, emitOf, formulationOf: () => "" }
  );
  assert.equal(out.warnings.length, 0);
  assert.deepEqual(out.added, [{ path: "SupportPointLoad", conditions: 3, name: "point" }]);
  const sibling = findSubModelPart(out.model, "SupportPointLoad")!;
  assert.deepEqual([...sibling.nodeIds], [1, 2, 3]);
  assert.equal(sibling.conditionIds.length, 3);
  const block = out.model.blocks.find((b) => b.kind === "Conditions" && b.name === "PointLoadCondition3D1N")!;
  assert.equal(block.count, 3);
  assert.deepEqual([...block.connectivity], [1, 2, 3]);
  // The input model is untouched.
  assert.equal(model.blocks.length, 2);
});

test("a 2D axisymmetric formulation emits the axisymmetric point variant", () => {
  const model = parseMdpa(MESH);
  const axisym = emitLoadConditions(
    model,
    [{ smpPath: "Support", conditionId: "pointLoad" }],
    {
      domainSize: 2,
      emitOf: (id) =>
        id === "pointLoad"
          ? { ...pointEmit, formulationField: "elementBase", axisymmetricPoint: "AxisymPointLoadCondition2D1N" }
          : undefined,
      formulationOf: () => "AxisymSmallDisplacementElement",
    }
  );
  assert.ok(axisym.model.blocks.some((b) => b.name === "AxisymPointLoadCondition2D1N"));
  const plain = emitLoadConditions(
    model,
    [{ smpPath: "Support", conditionId: "pointLoad" }],
    { domainSize: 2, emitOf, formulationOf: () => "SmallDisplacementElement" }
  );
  assert.ok(plain.model.blocks.some((b) => b.name === "PointLoadCondition2D1N"));
});

test("a point moment in 2D warns instead of inventing a condition", () => {
  const model = parseMdpa(MESH);
  const out = emitLoadConditions(
    model,
    [{ smpPath: "Support", conditionId: "pointMoment" }],
    {
      domainSize: 2,
      emitOf: (id) => (id === "pointMoment" ? { sibling: "PointMoment", source: "nodes", family: "moment" } : undefined),
      formulationOf: () => "",
    }
  );
  assert.deepEqual(out.added, []);
  assert.equal(out.model, model);
  assert.match(out.warnings[0], /no 2D condition/);
});

test("an existing sibling and unknown paths are left alone with a warning", () => {
  const model = parseMdpa(MESH);
  const once = emitLoadConditions(
    model,
    [{ smpPath: "Support", conditionId: "pointLoad" }],
    { domainSize: 3, emitOf, formulationOf: () => "" }
  );
  const twice = emitLoadConditions(
    once.model,
    [{ smpPath: "Support", conditionId: "pointLoad" }],
    { domainSize: 3, emitOf, formulationOf: () => "" }
  );
  assert.deepEqual(twice.added, []);
  assert.deepEqual(twice.warnings, []);
  assert.equal(twice.model, once.model);
  const missing = emitLoadConditions(
    model,
    [{ smpPath: "Nowhere", conditionId: "pointLoad" }],
    { domainSize: 3, emitOf, formulationOf: () => "" }
  );
  assert.match(missing.warnings[0], /"Nowhere" is not in this mesh/);
});

test("moving loads re-emit the part's line elements, skipping shapeless ones", () => {
  const model = parseMdpa(MESH);
  const out = emitLoadConditions(
    model,
    [{ smpPath: "Loaded", conditionId: "movingLoad" }],
    {
      domainSize: 3,
      emitOf: (id) => (id === "movingLoad" ? { sibling: "MovingLoad", source: "lines", family: "moving" } : undefined),
      formulationOf: () => "",
    }
  );
  assert.equal(out.warnings.length, 0);
  assert.deepEqual(out.added, [{ path: "LoadedMovingLoad", conditions: 2, name: "moving" }]);
  const block = out.model.blocks.find((b) => b.name === "MovingLoadCondition3D2N")!;
  assert.equal(block.count, 2);
  assert.deepEqual([...block.connectivity], [1, 2, 2, 3]);
  const sibling = findSubModelPart(out.model, "LoadedMovingLoad")!;
  assert.deepEqual([...sibling.nodeIds], [1, 2, 3]);
});

function stateFor(loads: CaseState["assignments"]): CaseState {
  const state = defaultCaseState(structural.decl);
  state.assignments = [
    { conditionId: "parts", smpPath: "Parts/Solid", values: {} },
    ...loads,
  ];
  state.materials = [{ smpPath: "Parts/Solid", lawId: "linear_elastic_3d", values: {} }];
  return state;
}

test("planCaseMesh emits the sibling even when nothing renames", async () => {
  const tetOnly = parseMdpa(`Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
4 0.0 0.0 1.0
End Nodes

Begin Elements SmallDisplacementElement3D4N
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

Begin SubModelPart Support
  Begin SubModelPartNodes
  1
  2
  3
  End SubModelPartNodes
End SubModelPart
`);
  const state = stateFor([{ conditionId: "pointLoad", smpPath: "Support", values: { modulus: 100, direction: [0, 0, -1] } }]);
  const plan = planCaseMesh(structural, tetOnly, state, "m", true);
  assert.equal(plan.shouldWriteMesh, true);
  assert.ok(findSubModelPart(plan.caseModel, "SupportPointLoad"));
  assert.ok(plan.caseModel.blocks.some((b) => b.name === "PointLoadCondition3D1N" && b.count === 3));
});

test("a point-load process targets the emitted sibling", async () => {
  const model = parseMdpa(MESH);
  const out = await generateCase(
    structural,
    model,
    stateFor([{ conditionId: "pointLoad", smpPath: "Support", values: { modulus: 100, direction: [0, 0, -1] } }]),
    "m"
  );
  const loads = JSON.parse(out.projectParameters).processes.loads_process_list;
  assert.equal(loads.length, 1);
  assert.equal(loads[0].Parameters.model_part_name, "Structure.SupportPointLoad");
  assert.equal(loads[0].Parameters.variable_name, "POINT_LOAD");
  assert.equal(loads[0].Parameters.modulus, 100);
});

test("a moving-load process carries the normalized load and the sibling", async () => {
  const model = parseMdpa(MESH);
  const out = await generateCase(
    structural,
    model,
    stateFor([
      {
        conditionId: "movingLoad",
        smpPath: "Loaded",
        values: { modulus: 5, direction: [0, 2, 0], velocity: 2, motionDirection: [1, 0, 0] },
      },
    ]),
    "m"
  );
  const loads = JSON.parse(out.projectParameters).processes.loads_process_list;
  assert.equal(loads.length, 1);
  assert.equal(loads[0].process_name, "SetMovingLoadProcess");
  assert.equal(loads[0].Parameters.model_part_name, "Structure.LoadedMovingLoad");
  assert.deepEqual(loads[0].Parameters.load, [0, 5, 0]);
  assert.deepEqual(loads[0].Parameters.direction, [1, 0, 0]);
  assert.equal(loads[0].Parameters.velocity, 2);
  assert.equal(loads[0].Parameters.motion_type, "base");
});

test("a moving load with no direction is refused at generate time", async () => {
  const model = parseMdpa(MESH);
  await assert.rejects(
    generateCase(
      structural,
      model,
      stateFor([{ conditionId: "movingLoad", smpPath: "Loaded", values: { modulus: 5, direction: [0, 0, 0] } }]),
      "m"
    ),
    /the load direction is zero/
  );
});
