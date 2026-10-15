import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultCaseState } from "../problemtype/api";
import {
  caseValueAddresses,
  caseValueLabel,
  formatCaseAddress,
  parseCaseAddress,
  readCaseValue,
  withCaseValue,
} from "../problemtype/caseAddress";
import { structural } from "../problemtype/builtins/structural";
import type { CaseState } from "../problemtype/types";

function caseWithLoads(): CaseState {
  const state = defaultCaseState(structural.decl);
  state.assignments = [
    { conditionId: "parts", smpPath: "Parts/Solid", values: {} },
    { conditionId: "pressure", smpPath: "Load/Top", values: { value: 5 } },
  ];
  state.materials = [{ smpPath: "Parts/Solid", lawId: structural.decl.materialLaws[0].id, values: { YOUNG_MODULUS: 2e11 } }];
  return state;
}

test("addresses parse and format, with nested SubModelPart paths and components", () => {
  for (const a of [
    "section:problem/timeStep",
    "assignment:pressure@Load/Top/value",
    "assignment:displacement@Supports/Left/Base/value[1]",
    "material:Parts/Solid/YOUNG_MODULUS",
  ]) {
    const parsed = parseCaseAddress(a);
    assert.ok(parsed, a);
    assert.equal(formatCaseAddress(parsed), a);
  }
  assert.deepEqual(parseCaseAddress("assignment:d@A/B/value[2]"), { kind: "assignment", conditionId: "d", smpPath: "A/B", fieldId: "value", component: 2 });
  for (const bad of ["", "section", "section:x", "section:a/b/c", "assignment:p/value", "foo:a/b", "material:/x"]) {
    assert.equal(parseCaseAddress(bad), undefined, bad);
  }
});

test("enumeration lists section, assignment and material numbers with current values", () => {
  const decl = structural.decl;
  const state = caseWithLoads();
  const options = caseValueAddresses(decl, state);
  const pressure = options.find((o) => o.address === "assignment:pressure@Load/Top/value");
  assert.ok(pressure);
  assert.equal(pressure.value, 5);
  assert.equal(pressure.group, "Conditions");
  const young = options.find((o) => o.address === "material:Parts/Solid/YOUNG_MODULUS");
  assert.equal(young?.value, 2e11);
  assert.equal(young?.group, "Materials");
  // Non-numeric fields (enums, bools) are never offered.
  assert.ok(options.every((o) => Number.isFinite(o.value)));
  assert.ok(options.some((o) => o.address.startsWith("section:")));
  assert.equal(caseValueLabel(decl, state, "assignment:pressure@Load/Top/value"), pressure.label);
  assert.equal(caseValueLabel(decl, state, "section:nope/x"), "section:nope/x");
});

test("read and write by address, never mutating the input", () => {
  const decl = structural.decl;
  const state = caseWithLoads();
  assert.equal(readCaseValue(decl, state, "assignment:pressure@Load/Top/value"), 5);
  const next = withCaseValue(decl, state, "assignment:pressure@Load/Top/value", 7)!;
  assert.equal(readCaseValue(decl, next, "assignment:pressure@Load/Top/value"), 7);
  assert.equal(readCaseValue(decl, state, "assignment:pressure@Load/Top/value"), 5);
  const mat = withCaseValue(decl, state, "material:Parts/Solid/YOUNG_MODULUS", 1e9)!;
  assert.equal(mat.materials[0].values.YOUNG_MODULUS, 1e9);
  assert.equal(state.materials[0].values.YOUNG_MODULUS, 2e11);
  const numberSection = caseValueAddresses(decl, state).find((o) => o.address.startsWith("section:") && !o.address.endsWith("]"))!;
  const sec = withCaseValue(decl, state, numberSection.address, 42)!;
  assert.equal(readCaseValue(decl, sec, numberSection.address), 42);
  // Nothing numeric there, or a component on a scalar: refused.
  assert.equal(withCaseValue(decl, state, "assignment:pressure@Nowhere/value", 1), undefined);
  assert.equal(withCaseValue(decl, state, "assignment:pressure@Load/Top/value[0]", 1), undefined);
});
