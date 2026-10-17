import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { generateCase } from "../problemtype/generate";
import { defaultCaseState } from "../problemtype/api";
import { structural } from "../problemtype/builtins/structural";
import type { CaseState, JsonValue } from "../problemtype/types";

const TET = `Begin Properties 0
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

Begin SubModelPart Support
  Begin SubModelPartNodes
  1
  2
  3
  End SubModelPartNodes
End SubModelPart
`;

function stateFor(lawId: string, values: Record<string, JsonValue> = {}): CaseState {
  const state = defaultCaseState(structural.decl);
  state.assignments = [
    { conditionId: "parts", smpPath: "Parts/Solid", values: {} },
    { conditionId: "displacement", smpPath: "Support", values: { value: [0, 0, 0], constrained: true } },
  ];
  state.materials = [{ smpPath: "Parts/Solid", lawId, values }];
  return state;
}

test("the curated laws are grouped and the factories carry their block keys", () => {
  const laws = structural.decl.materialLaws;
  assert.ok(laws.length >= 30, `expected the curated set, found ${laws.length} laws`);
  for (const law of laws) {
    assert.ok(law.group && law.group.length > 0, `law "${law.id}" has no picker group`);
  }
  const groups = new Set(laws.map((l) => l.group));
  for (const group of ["Elastic", "Hyperelastic", "Plasticity", "Damage", "Viscous", "Beam", "Shell", "Discrete"]) {
    assert.ok(groups.has(group), `no "${group}" laws offered`);
  }
  // Factory rows name the factory and fix its block keys; the scanner cannot
  // see a factory name, so `application` supplies ConstitutiveLawsApplication.
  for (const id of ["plasticity_iso_3d", "plasticity_kin_3d", "damage_iso_3d"]) {
    const law = laws.find((l) => l.id === id)!;
    assert.ok(law.name.endsWith("Factory"), `${id} should name its factory`);
    assert.deepEqual(law.parameters, { law_type: "3D", yield_surface: "VonMises", plastic_potential: "VonMises" });
    assert.equal(law.application, "ConstitutiveLawsApplication");
  }
  const j2 = laws.find((l) => l.id === "plasticity_j2_3d")!;
  assert.equal(j2.name, "SmallStrainJ2Plasticity3DLaw");
  assert.equal(j2.application, "ConstitutiveLawsApplication");
});

test("a factory law writes its block keys and pulls its application", async () => {
  const out = await generateCase(structural, parseMdpa(TET), stateFor("plasticity_iso_3d", { YIELD_STRESS: 2.5e8 }), "m");
  const material = JSON.parse(out.materials).properties[0].Material;
  assert.deepEqual(material.constitutive_law, {
    name: "SmallStrainIsotropicPlasticityFactory",
    law_type: "3D",
    yield_surface: "VonMises",
    plastic_potential: "VonMises",
  });
  assert.equal(material.Variables.YIELD_STRESS, 2.5e8);
  assert.equal(material.Variables.DENSITY, 7850);
  assert.ok(out.applications.includes("ConstitutiveLawsApplication"));
  assert.ok(out.mainScript.includes("ConstitutiveLawsApplication"));
});

test("an elastic case does not require the ConstitutiveLawsApplication", async () => {
  const out = await generateCase(structural, parseMdpa(TET), stateFor("linear_elastic_3d"), "m");
  assert.ok(!out.applications.includes("ConstitutiveLawsApplication"));
});

test("a factory law outside its formulation or dimension is refused", async () => {
  const model = parseMdpa(TET);
  const beam = stateFor("plasticity_iso_3d");
  beam.values.problem.elementBase = "CrBeamElement";
  await assert.rejects(
    generateCase(structural, model, beam, "m"),
    /SmallStrainIsotropicPlasticityFactory" is not available for the current setup/
  );
  const flat = stateFor("damage_iso_plane_stress");
  await assert.rejects(
    generateCase(structural, model, flat, "m"),
    /written for a 2D mesh, but this case is 3D/
  );
});
