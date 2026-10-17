import { test } from "node:test";
import assert from "node:assert/strict";

import {
  defineProblemtype,
  validateDeclaration,
  resolveProcessTemplate,
  defaultCaseState,
  flattenValues,
  dottedModelPart,
  fieldDefault,
} from "../problemtype/api";
import {
  Assignment,
  ConditionSpec,
  GenContext,
  JsonObject,
  ProblemtypeDeclaration,
} from "../problemtype/types";

const minimalDecl = (): ProblemtypeDeclaration => ({
  id: "t",
  name: "Test",
  analysisStage: "KratosMultiphysics.X.y_analysis",
  modelPartName: "Root",
  materialsFileName: "Materials.json",
  domainSizes: [2, 3],
  sections: [
    {
      id: "problem",
      label: "Problem",
      fields: [
        { id: "endTime", label: "End", type: "number", default: 2.5 },
        { id: "mode", label: "Mode", type: "enum", options: [{ value: "a" }, { value: "b" }] },
      ],
    },
  ],
  conditions: [
    {
      id: "bc",
      label: "BC",
      list: "constraints_process_list",
      target: "any",
      fields: [{ id: "value", label: "V", type: "number", default: 7 }],
      processTemplate: {
        python_module: "assign_scalar_variable_process",
        Parameters: { model_part_name: "$path", root: "$root", value: "$field:value" },
      },
    },
  ],
  materialLaws: [],
  output: { nodalDefaults: ["DISPLACEMENT"] },
});

const ctxFor = (decl: ProblemtypeDeclaration): GenContext => ({
  mdpaStem: "case",
  domainSize: 3,
  modelPartName: decl.modelPartName,
  materialsFileName: decl.materialsFileName,
  values: {},
  assignments: [],
  materials: [],
  partsModelParts: [],
  skinModelParts: [],
  subModelParts: [],
});

test("validateDeclaration accepts a minimal declaration", () => {
  assert.deepEqual(validateDeclaration(minimalDecl()), []);
});

test("validateDeclaration flags missing metadata, duplicates and bad refs", () => {
  const decl = minimalDecl();
  decl.id = "";
  decl.domainSizes = [];
  decl.sections.push({ id: "s2", label: "S2", fields: [{ id: "endTime", label: "dup", type: "number" }] });
  decl.conditions.push({ ...decl.conditions[0] }); // duplicate condition id
  decl.partsCondition = "nope";
  const errors = validateDeclaration(decl);
  assert.ok(errors.some((e) => e.includes("missing id")));
  assert.ok(errors.some((e) => e.includes("domainSizes")));
  assert.ok(errors.some((e) => e.includes('duplicate field id "endTime"')));
  assert.ok(errors.some((e) => e.includes('duplicate condition id "bc"')));
  assert.ok(errors.some((e) => e.includes('partsCondition "nope"')));
});

test("validateDeclaration checks meshNaming tables", () => {
  const decl = minimalDecl();
  decl.meshNaming = {
    elements: {
      field: "mode",
      names: {
        a: "Element{dim}D{nodes}N",
        b: { 3: { 8: "Hexahedron3D8N", 4: "Tetrahedron3D4N" } },
      },
    },
    conditions: { 2: "LineLoadCondition", 3: "SurfaceLoadCondition" },
  };
  assert.deepEqual(validateDeclaration(decl), []);

  const bad = minimalDecl();
  bad.meshNaming = {
    elements: {
      field: "mode",
      names: {
        c: "Element", // not an option of "mode"
        a: "Element{dimX}", // unknown placeholder
        b: { 3: { 8: "Hexahedron3D8N{dim}" } }, // a shape table holds exact names
      },
    },
  };
  const errors = validateDeclaration(bad);
  assert.ok(errors.some((e) => e.includes('"c" is not an option of "mode"')));
  assert.ok(errors.some((e) => e.includes("only {dim} and {nodes}")));
  assert.ok(errors.some((e) => e.includes("exact names, not templates")));

  const noField = minimalDecl();
  noField.meshNaming = { conditions: { field: "nope", names: { a: "X" } } };
  assert.ok(validateDeclaration(noField).some((e) => e.includes('field "nope" is not a section field')));
});

test("validateDeclaration checks material-law metadata", () => {
  const decl = minimalDecl();
  decl.materialLaws = [
    {
      id: "clapp",
      name: "SmallStrainIsotropicPlasticityFactory",
      variables: [],
      application: "ConstitutiveLawsApplication",
      group: "Plasticity",
      parameters: { law_type: "SmallStrainIsotropicPlasticityFactory" },
      when: { field: "mode", equals: "a" },
    },
  ];
  assert.deepEqual(validateDeclaration(decl), []);

  const bad = minimalDecl();
  bad.materialLaws = [
    {
      id: "x",
      name: "X",
      variables: [],
      application: "constitutive_laws",
      group: "",
      parameters: { name: "Y" },
      when: [{ field: "nope", equals: 1 }],
    },
    { id: "y", name: "Y", variables: [], parameters: [] as unknown as JsonObject },
  ];
  const errors = validateDeclaration(bad).join("\n");
  assert.match(errors, /application must be a Kratos application name/);
  assert.match(errors, /group must be a non-empty name/);
  assert.match(errors, /parameters may not set "name"/);
  assert.match(errors, /"when" names unknown field "nope"/);
  assert.match(errors, /parameters must be an object/);
});

test("defineProblemtype throws on an invalid declaration or missing solverSettings", () => {
  const bad = minimalDecl();
  bad.analysisStage = "";
  assert.throws(() => defineProblemtype(bad, { solverSettings: () => ({}) }), /analysisStage/);
  assert.throws(
    () => defineProblemtype(minimalDecl(), {} as never),
    /solverSettings is required/
  );
});

test("resolveProcessTemplate substitutes $path/$root/$field with fallback to defaults", () => {
  const decl = minimalDecl();
  const cond = decl.conditions[0];
  const a: Assignment = { conditionId: "bc", smpPath: "Boundary/Left", values: {} };
  const ctx = ctxFor(decl);
  const resolved = resolveProcessTemplate(cond, a, ctx) as {
    Parameters: { model_part_name: string; root: string; value: number };
  };
  assert.equal(resolved.Parameters.model_part_name, "Root.Boundary.Left");
  assert.equal(resolved.Parameters.root, "Root");
  assert.equal(resolved.Parameters.value, 7); // declared default
  a.values.value = 42;
  const resolved2 = resolveProcessTemplate(cond, a, ctx) as typeof resolved;
  assert.equal(resolved2.Parameters.value, 42);
});

test("resolveProcessTemplate resolves placeholders nested in arrays", () => {
  const decl = minimalDecl();
  const cond: ConditionSpec = {
    ...decl.conditions[0],
    processTemplate: { Parameters: { list: ["$field:value", ["$path"]] } },
  };
  const a: Assignment = { conditionId: "bc", smpPath: "S", values: { value: 1 } };
  const out = resolveProcessTemplate(cond, a, ctxFor(decl)) as {
    Parameters: { list: [number, [string]] };
  };
  assert.deepEqual(out.Parameters.list, [1, ["Root.S"]]);
});

test("buildProcess hook can fall back to the template by returning undefined", async () => {
  const decl = minimalDecl();
  const rt = defineProblemtype(decl, {
    solverSettings: () => ({}),
    buildProcess: (cond) => (cond.id === "other" ? { custom: true } : undefined),
  });
  const a: Assignment = { conditionId: "bc", smpPath: "S", values: {} };
  const out = (await rt.buildProcess(decl.conditions[0], a, ctxFor(decl))) as {
    python_module: string;
  };
  assert.equal(out.python_module, "assign_scalar_variable_process");
});

test("defaultCaseState + flattenValues honour declared and type defaults", () => {
  const decl = minimalDecl();
  const state = defaultCaseState(decl);
  assert.equal(state.problemtypeId, "t");
  assert.equal(state.values.problem.endTime, 2.5);
  assert.equal(state.values.problem.mode, "a"); // first enum option
  assert.deepEqual(state.output.nodalVariables, ["DISPLACEMENT"]);
  state.values.problem.endTime = 9;
  const flat = flattenValues(decl, state);
  assert.equal(flat.endTime, 9);
  assert.equal(flat.mode, "a");
});

test("fieldDefault produces type-appropriate zeros", () => {
  assert.equal(fieldDefault({ id: "a", label: "", type: "number" }), 0);
  assert.equal(fieldDefault({ id: "a", label: "", type: "bool" }), false);
  assert.deepEqual(fieldDefault({ id: "a", label: "", type: "vector3" }), [0, 0, 0]);
  assert.equal(fieldDefault({ id: "a", label: "", type: "string" }), "");
});

test("dottedModelPart joins the root and slash path with dots", () => {
  assert.equal(dottedModelPart("Structure", "Parts/Solid"), "Structure.Parts.Solid");
  assert.equal(dottedModelPart("Structure", "Top"), "Structure.Top");
});

test("validateDeclaration checks field requirements", () => {
  const ok = minimalDecl();
  ok.sections[0].requiresFields = [{ variable: "DISTANCE", components: 1, kind: "Nodal", when: { field: "mode", equals: "a" } }];
  ok.conditions[0].requiresFields = [{ variable: "TEMPERATURE" }];
  assert.deepEqual(validateDeclaration(ok), []);
  const bad = minimalDecl();
  bad.sections[0].requiresFields = [
    { variable: "" } as never,
    { variable: "A", components: 2 } as never,
    { variable: "B", kind: "Cell" } as never,
    { variable: "C", when: { field: "nope", equals: 1 } },
  ];
  bad.conditions[0].requiresFields = [{ variable: "D", when: { field: "value", equals: 1 } } as never];
  const errors = validateDeclaration(bad).join("\n");
  assert.match(errors, /without variable/);
  assert.match(errors, /components must be 1 or 3/);
  assert.match(errors, /unknown kind "Cell"/);
  assert.match(errors, /names unknown field "nope"/);
  assert.match(errors, /only valid on a section/);
});
