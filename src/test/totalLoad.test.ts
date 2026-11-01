/** Total force on a surface (roadmap item 42): the modulus is total / measure, and the total stays in the case. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { generateCase } from "../problemtype/generate";
import { defaultCaseState } from "../problemtype/api";
import { structural } from "../problemtype/builtins/structural";
import { CaseState } from "../problemtype/types";

const mdpa = (side: number): string => `Begin Properties 0
End Properties
Begin Nodes
1 0.0 0.0 0.0
2 ${side} 0.0 0.0
3 ${side} ${side} 0.0
4 0.0 ${side} 0.0
5 ${side / 2} ${side / 2} 10.0
End Nodes
Begin Elements Element3D4N
1 0 1 2 3 5
2 0 1 3 4 5
End Elements
Begin Conditions SurfaceCondition3D3N
1 0 1 2 3
2 0 1 3 4
End Conditions
Begin SubModelPart Parts
  Begin SubModelPart Solid
    Begin SubModelPartNodes
    1
    2
    3
    4
    5
    End SubModelPartNodes
    Begin SubModelPartElements
    1
    2
    End SubModelPartElements
  End SubModelPart
End SubModelPart
Begin SubModelPart Face
  Begin SubModelPartNodes
  1
  2
  3
  4
  End SubModelPartNodes
  Begin SubModelPartConditions
  1
  2
  End SubModelPartConditions
End SubModelPart
`;

function state(loadMode: string, total: number, part = "Face"): CaseState {
  const s = defaultCaseState(structural.decl);
  s.assignments = [
    { conditionId: "parts", smpPath: "Parts/Solid", values: {} },
    { conditionId: "surfaceLoad", smpPath: part, values: { modulus: total, direction: [0, 0, -1], loadMode } },
  ];
  s.materials = [{ smpPath: "Parts/Solid", lawId: "linear_elastic_3d", values: { YOUNG_MODULUS: 2.0e11 } }];
  return s;
}

const modulusOf = (text: string): number => {
  const doc = JSON.parse(text);
  const p = doc.processes.loads_process_list.find((x: { Parameters: { variable_name: string } }) => x.Parameters.variable_name === "SURFACE_LOAD");
  return p.Parameters.modulus;
};

test("1000 N total on a 10 x 10 face writes a distributed modulus of 10, and records the measure", async () => {
  const out = await generateCase(structural, parseMdpa(mdpa(10)), state("total", 1000), "plate");
  assert.ok(Math.abs(modulusOf(out.projectParameters) - 10) < 1e-12);
  assert.equal(out.loadMeasures?.length, 1);
  assert.ok(Math.abs(out.loadMeasures![0].measure - 100) < 1e-9);
  assert.equal(out.loadMeasures![0].total, 1000);
});

test("re-meshing (a larger face) changes the distributed value, not the total", async () => {
  const out = await generateCase(structural, parseMdpa(mdpa(20)), state("total", 1000), "plate");
  assert.ok(Math.abs(modulusOf(out.projectParameters) - 2.5) < 1e-12);
});

test("distributed mode (and a case file without the field) writes the modulus unchanged", async () => {
  const model = parseMdpa(mdpa(10));
  assert.equal(modulusOf((await generateCase(structural, model, state("distributed", 7), "p")).projectParameters), 7);
  const s = state("distributed", 7);
  delete s.assignments[1].values.loadMode;
  const out = await generateCase(structural, model, s, "p");
  assert.equal(modulusOf(out.projectParameters), 7);
  assert.equal(out.loadMeasures, undefined);
});

test("a part with no measurable cells, or the wrong dimension, is refused by name", async () => {
  const model = parseMdpa(mdpa(10));
  await assert.rejects(generateCase(structural, model, state("total", 1000, "Parts/Solid"), "p"), /surface load needs a part of surface cells|volume/);
  await assert.rejects(generateCase(structural, model, state("total", 1000, "Missing"), "p"), /Total force on "Missing"/);
});
