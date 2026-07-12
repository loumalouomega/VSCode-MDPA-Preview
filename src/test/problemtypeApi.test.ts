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
