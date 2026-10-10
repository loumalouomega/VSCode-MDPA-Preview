import { test } from "node:test";
import assert from "node:assert/strict";

import {
  catalogGroups,
  conditionCategory,
  countByCategory,
  groupConditions,
  groupSectionFields,
  summaryChips,
} from "../problemtype/layout";
import { validateDeclaration } from "../problemtype/api";
import { ConditionSpec, ProblemtypeDeclaration } from "../problemtype/types";

const cond = (id: string, list: string, extra: Partial<ConditionSpec> = {}): ConditionSpec => ({
  id,
  label: id,
  list,
  target: "any",
  fields: [],
  processTemplate: {},
  ...extra,
});

test("conditionCategory prefers the declared category, then the process list", () => {
  assert.equal(conditionCategory(cond("a", "constraints_process_list")), "constraints");
  assert.equal(conditionCategory(cond("a", "loads_process_list")), "loads");
  assert.equal(conditionCategory(cond("a", "list_other_processes")), "other");
  assert.equal(conditionCategory(cond("a", "initial_conditions_process_list")), "initial");
  assert.equal(conditionCategory(cond("a", "boundary_conditions_process_list")), "constraints");
  assert.equal(conditionCategory(cond("a", "topography_process_list")), "other");
  assert.equal(conditionCategory(cond("a", "loads_process_list", { category: "initial" })), "initial");
});

test("groupConditions orders branches, drops empty ones and skips the parts condition", () => {
  const decl = {
    partsCondition: "parts",
    conditions: [
      cond("parts", "list_other_processes"),
      cond("load", "loads_process_list"),
      cond("fix", "constraints_process_list"),
      cond("fix2", "constraints_process_list"),
    ],
  };
  const g = groupConditions(decl);
  assert.deepEqual(g.map((b) => b.category), ["constraints", "loads"]);
  assert.deepEqual(g[0].conditions.map((c) => c.id), ["fix", "fix2"]);
  assert.equal(g[0].label, "Boundary conditions");
});

test("countByCategory ignores parts and unknown ids", () => {
  const decl = {
    partsCondition: "parts",
    conditions: [cond("parts", "list_other_processes"), cond("fix", "constraints_process_list")],
  };
  const c = countByCategory(decl, [
    { conditionId: "parts" },
    { conditionId: "fix" },
    { conditionId: "fix" },
    { conditionId: "gone" },
  ]);
  assert.deepEqual(c, { initial: 0, constraints: 2, loads: 0, other: 0 });
});

test("groupSectionFields keeps loose, grouped and advanced fields apart", () => {
  const f = (id: string, extra: object = {}) => ({ id, label: id, type: "number" as const, ...extra });
  const layout = groupSectionFields({
    groups: [
      { id: "time", label: "Time" },
      { id: "empty", label: "Empty" },
    ],
    fields: [f("a"), f("b", { group: "time" }), f("c", { advanced: true }), f("d", { group: "nope" }), f("e", { group: "time", advanced: true })],
  });
  assert.deepEqual(layout.loose.map((x) => x.id), ["a", "d"]);
  assert.deepEqual(layout.groups.map((g) => [g.spec.id, g.fields.map((x) => x.id)]), [["time", ["b", "e"]]]);
  assert.deepEqual(layout.advanced.map((x) => x.id), ["c"]);
});

test("catalogGroups orders families and isolates failed entries", () => {
  const groups = catalogGroups([
    { decl: { family: "fluid" } },
    {},
    { decl: { family: "solid" } },
    { decl: {} },
    { decl: { family: "fluid" } },
  ]);
  assert.deepEqual(groups.map((g) => [g.id, g.indices]), [
    ["solid", [2]],
    ["fluid", [0, 4]],
    ["other", [3]],
    ["failed", [1]],
  ]);
});

test("summaryChips pluralises", () => {
  const decl = { partsCondition: "parts", conditions: [] };
  assert.deepEqual(
    summaryChips(decl, { assignments: [{ conditionId: "parts" }, { conditionId: "x" }, { conditionId: "y" }], materials: [{}] }),
    ["1 domain part", "2 conditions", "1 material"]
  );
});

test("validateDeclaration checks groups, categories, family and bounds", () => {
  const base = (): ProblemtypeDeclaration => ({
    id: "t",
    name: "T",
    analysisStage: "x",
    modelPartName: "R",
    materialsFileName: "M.json",
    domainSizes: [2],
    sections: [{ id: "problem", label: "P", groups: [{ id: "g", label: "G" }], fields: [{ id: "a", label: "A", type: "number", group: "g", min: 0, max: 1 }] }],
    conditions: [cond("c", "loads_process_list", { category: "loads" })],
    materialLaws: [],
    output: { nodalDefaults: [] },
    family: "solid",
  });
  assert.deepEqual(validateDeclaration(base()), []);
  const bad = base();
  bad.sections[0].fields[0].group = "zzz";
  bad.sections[0].fields[0].min = 5;
  (bad.conditions[0] as any).category = "weird";
  (bad as any).family = "nope";
  const errs = validateDeclaration(bad).join("|");
  assert.match(errs, /unknown group "zzz"/);
  assert.match(errs, /min above max/);
  assert.match(errs, /unknown category "weird"/);
  assert.match(errs, /unknown family "nope"/);
});
