import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFlowBalanceRequest, defaultFlowBalanceForm, FlowBalanceForm } from "../parser/flowBalanceForm";

const form = (patch: Partial<FlowBalanceForm> = {}): FlowBalanceForm => ({
  ...defaultFlowBalanceForm(),
  velocity: "VELOCITY",
  pressure: "PRESSURE",
  sections: [{ name: "in", part: "Inlet" }, { name: "", part: "Outlet" }],
  ...patch,
});

test("a complete form builds a spec; a blank section name falls back to the part path", () => {
  const r = buildFlowBalanceRequest(form({ density: "998", dropFrom: "in", dropTo: "Outlet" }));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.spec.sections, [{ name: "in", part: "Inlet" }, { name: "Outlet", part: "Outlet" }]);
  assert.equal(r.spec.velocity, "VELOCITY");
  assert.equal(r.spec.density, 998);
  assert.deepEqual(r.spec.pressureDrop, { from: "in", to: "Outlet" });
  assert.equal(r.spec.orientation, "outward");
  assert.equal(r.spec.pressureDensity, undefined);
});

test("a pressure density and reference ride the spec without touching the mass density", () => {
  const r = buildFlowBalanceRequest(form({ pressureDensity: "1.2", pressureReference: "absolute" }));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.spec.pressureDensity, 1.2);
  assert.equal(r.spec.pressureReference, "absolute");
  assert.equal(r.spec.density, undefined);
});

test("an unset field is null (not requested), and at least one field is required", () => {
  const r = buildFlowBalanceRequest(form({ pressure: "" }));
  assert.ok(r.ok && r.spec.pressure === null);
  const none = buildFlowBalanceRequest(form({ velocity: "", pressure: "" }));
  assert.ok(!none.ok && /velocity field, a pressure field/.test(none.error));
});

test("the error names the offending input", () => {
  const err = (f: FlowBalanceForm): string => {
    const r = buildFlowBalanceRequest(f);
    assert.ok(!r.ok);
    return r.ok ? "" : r.error;
  };
  assert.match(err(form({ sections: [{ name: "", part: "" }] })), /at least one section/);
  assert.match(err(form({ sections: [{ name: "a", part: "Inlet" }, { name: "b", part: "" }] })), /Section 2 has no SubModelPart/);
  assert.match(err(form({ sections: [{ name: "a", part: "Inlet" }, { name: "a", part: "Outlet" }] })), /Two sections are called "a"/);
  assert.match(err(form({ density: "abc" })), /Density must be a positive number/);
  assert.match(err(form({ density: "-1" })), /Density must be a positive number/);
  assert.match(err(form({ velocity: "", density: "1000" })), /together with a velocity field/);
  assert.match(err(form({ pressureDensity: "abc" })), /Pressure density must be a positive number/);
  assert.match(err(form({ pressureDensity: "0" })), /Pressure density must be a positive number/);
  assert.match(err(form({ pressure: "", pressureDensity: "1000" })), /together with a pressure field/);
  assert.match(err(form({ pressureReference: "gauge" })), /only labels a Pa conversion/);
  assert.match(err(form({ dropFrom: "in" })), /both a From and a To/);
  assert.match(err(form({ dropFrom: "in", dropTo: "in" })), /two different sections/);
  assert.match(err(form({ dropFrom: "in", dropTo: "zzz" })), /among the sections above/);
  assert.match(err(form({ pressure: "", dropFrom: "in", dropTo: "Outlet" })), /needs a pressure field/);
});
