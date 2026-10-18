import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { generateCase } from "../problemtype/generate";
import { defaultCaseState } from "../problemtype/api";
import { fluid } from "../problemtype/builtins/fluid";
import type { Assignment, CaseState, JsonObject, JsonValue } from "../problemtype/types";

const MDPA = `Begin Properties 0
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
  Begin SubModelPart Fluid
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

function state(assignments: Assignment[] = [], materials: CaseState["materials"] = [{ smpPath: "Parts/Fluid", lawId: "newtonian_3d", values: {} }]): CaseState {
  const s = defaultCaseState(fluid.decl);
  s.assignments = [{ conditionId: "parts", smpPath: "Parts/Fluid", values: {} }, ...assignments];
  s.materials = materials;
  return s;
}

async function aux(assignments: Assignment[], materials?: CaseState["materials"]): Promise<JsonObject[]> {
  const out = await generateCase(fluid, parseMdpa(MDPA), state(assignments, materials), "case");
  return (JSON.parse(out.projectParameters).processes as Record<string, JsonObject[]>).auxiliar_process_list;
}

const statsOf = (aux: JsonObject[]): JsonObject[] =>
  aux.filter((p) => p.python_module === "integration_point_statistics_process").map((p) => p.Parameters as JsonObject);

test("a VELOCITY average tags itself and carries the solver's keys", async () => {
  const procs = statsOf(await aux([{ conditionId: "integrationStats", smpPath: "Parts/Fluid", values: { statisticType: "average", variable: "VELOCITY" } }]));
  assert.equal(procs.length, 1);
  assert.deepEqual(procs[0], {
    model_part_name: "FluidModelPart.Parts.Fluid",
    output_file_name: "statistics",
    dimension: 3,
    start_time: 0,
    statistics: [{ type: "average", variable: "VELOCITY", tags: ["VELOCITY_X", "VELOCITY_Y", "VELOCITY_Z"] }],
  });
});

test("a scalar average writes no tags; entries on one part merge into one process", async () => {
  const procs = statsOf(
    await aux([
      { conditionId: "integrationStats", smpPath: "Parts/Fluid", values: { statisticType: "average", variable: "PRESSURE", outputFile: "pool", startTime: 2 } },
      { conditionId: "integrationStats", smpPath: "Parts/Fluid", values: { statisticType: "variance", variable: "PRESSURE", outputFile: "pool", startTime: 2 } },
    ])
  );
  assert.equal(procs.length, 1);
  assert.deepEqual((procs[0].statistics as JsonObject[]).map((s) => s.type), ["average", "variance"]);
  assert.deepEqual((procs[0].statistics as JsonObject[])[1], { type: "variance", variables: ["PRESSURE"] });
});

test("a higher moment without its average, a bad count and stray tags are refused before anything is written", async () => {
  await assert.rejects(
    aux([{ conditionId: "integrationStats", smpPath: "Parts/Fluid", values: { statisticType: "variance", variable: "PRESSURE" } }]),
    /needs its average/
  );
  await assert.rejects(
    aux([{ conditionId: "integrationStats", smpPath: "Parts/Fluid", values: { statisticType: "average", variable: "PRESSURE,VELOCITY" } }]),
    /one variable/
  );
  await assert.rejects(
    aux([{ conditionId: "integrationStats", smpPath: "Parts/Fluid", values: { statisticType: "third_order_moment", variable: "VELOCITY,PRESSURE" } }]),
    /three variables/
  );
  await assert.rejects(
    aux([
      { conditionId: "integrationStats", smpPath: "Parts/Fluid", values: { statisticType: "average", variable: "PRESSURE" } },
      { conditionId: "integrationStats", smpPath: "Parts/Fluid", values: { statisticType: "variance", variable: "PRESSURE", tags: "P" } },
    ]),
    /tags belong to an average/
  );
  await assert.rejects(
    aux([
      { conditionId: "integrationStats", smpPath: "Parts/Fluid", values: { statisticType: "average", variable: "PRESSURE", outputFile: "a" } },
      { conditionId: "integrationStats", smpPath: "Parts/Fluid", values: { statisticType: "average", variable: "VELOCITY", outputFile: "b" } },
    ]),
    /one statistics file per part/
  );
});

test("the temperature-dependent law writes the viscosity table, not a variable", async () => {
  const out = await generateCase(
    fluid,
    parseMdpa(MDPA),
    state([], [{ smpPath: "Parts/Fluid", lawId: "temperature_dependent_3d", values: { DENSITY: 997, TEMPERATURE_TABLE: "293.15,1e-3; 373.15,2.8e-4" } }]),
    "case"
  );
  const props = JSON.parse(out.materials).properties;
  assert.equal(props[0].Material.constitutive_law.name, "NewtonianTemperatureDependent3DLaw");
  assert.deepEqual(props[0].Material.Tables, {
    Table1: { input_variable: "TEMPERATURE", output_variable: "DYNAMIC_VISCOSITY", data: [[293.15, 1e-3], [373.15, 2.8e-4]] },
  });
  assert.ok(!("TEMPERATURE_TABLE" in props[0].Material.Variables), "the table text is not a material variable");
  await assert.rejects(
    generateCase(fluid, parseMdpa(MDPA), state([], [{ smpPath: "Parts/Fluid", lawId: "temperature_dependent_3d", values: { TEMPERATURE_TABLE: "hot" } }]), "case"),
    /at least two pairs/
  );
  await assert.rejects(
    generateCase(fluid, parseMdpa(MDPA), state([], [{ smpPath: "Parts/Fluid", lawId: "temperature_dependent_3d", values: { TEMPERATURE_TABLE: "293,1e-3; hot" } }]), "case"),
    /not an "input,output" pair/
  );
});

test("an initial temperature writes the TEMPERATURE initial process", async () => {
  const out = await generateCase(
    fluid,
    parseMdpa(MDPA),
    state([{ conditionId: "initialTemperature", smpPath: "Parts/Fluid", values: { value: 350 } }]),
    "case"
  );
  const initial = (JSON.parse(out.projectParameters).processes as Record<string, JsonObject[]>).initial_conditions_process_list;
  const t = initial.find((p) => (p.Parameters as JsonObject).variable_name === "TEMPERATURE");
  assert.ok(t, "TEMPERATURE initial process");
  assert.equal((t!.Parameters as JsonObject).value, 350);
});
