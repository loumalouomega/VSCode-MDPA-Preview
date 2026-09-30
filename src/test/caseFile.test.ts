import { test } from "node:test";
import assert from "node:assert/strict";

import { serializeCase, parseCaseJson } from "../problemtype/caseFile";
import { defaultCaseState } from "../problemtype/api";
import { structural } from "../problemtype/builtins/structural";
import { BUILTIN_PRESETS, resolvePresetValues, snapshotOf } from "../problemtype/materialCatalog";

test("case state round-trips through serialize/parse", () => {
  const state = defaultCaseState(structural.decl);
  state.assignments.push({
    conditionId: "displacement",
    smpPath: "Support",
    values: { value: [0, 0, 0], constrained: true },
  });
  state.materials.push({ smpPath: "Parts/Solid", lawId: "linear_elastic_3d", values: {} });
  state.output.format = "binary";
  state.output.interval = 5;
  const { state: back, warnings } = parseCaseJson(serializeCase(state));
  assert.deepEqual(warnings, []);
  assert.deepEqual(back, state);
});

test("a material preset snapshot round-trips, and a case without one still loads", () => {
  const state = defaultCaseState(structural.decl);
  state.assignments.push({ conditionId: "parts", smpPath: "Parts/Solid", values: {} });
  const resolved = resolvePresetValues(
    structural.decl.materialLaws.find((l) => l.id === "linear_elastic_3d")!,
    {
      id: "steel",
      name: "Steel S235",
      laws: ["linear_elastic_3d"],
      values: { DENSITY: 7850, YOUNG_MODULUS: 210, POISSON_RATIO: 0.3 },
      units: { DENSITY: "kg/m³", YOUNG_MODULUS: "GPa", POISSON_RATIO: "" },
      reference: { temperature: 20, temperatureUnit: "C" },
      source: { name: "EN 10025-2", version: "2004" },
      origin: "user",
    }
  );
  state.materials.push({
    smpPath: "Parts/Solid",
    lawId: "linear_elastic_3d",
    values: resolved.values,
    preset: snapshotOf(BUILTIN_PRESETS[0], resolved.values),
  });
  // The 210 GPa of the library row is what the case keeps, whatever the
  // library says afterwards.
  assert.equal(resolved.values.YOUNG_MODULUS, 210e9);
  const { state: back, warnings } = parseCaseJson(serializeCase(state));
  assert.deepEqual(warnings, []);
  assert.deepEqual(back, state);
  assert.equal(back!.materials[0].preset!.source.name, BUILTIN_PRESETS[0].source.name);
  assert.deepEqual(back!.materials[0].preset!.laws, BUILTIN_PRESETS[0].laws);
  assert.equal(back!.materials[0].preset!.reference!.temperature, 20);
  // Deep-copied, not shared with the runtime constant.
  assert.notEqual(back!.materials[0].preset!.source, BUILTIN_PRESETS[0].source);

  // A case written before the catalog existed has no snapshot, and a broken
  // one loses the snapshot without losing the material.
  const legacy = parseCaseJson(
    JSON.stringify({
      version: 1,
      problemtypeId: "structural",
      materials: [
        { smpPath: "Parts/Solid", lawId: "linear_elastic_3d", values: { DENSITY: 7850 } },
        { smpPath: "Parts/B", lawId: "linear_elastic_3d", values: {}, preset: "nope" },
      ],
    })
  );
  assert.equal(legacy.state!.materials[0].preset, undefined);
  assert.equal(legacy.state!.materials[1].preset, undefined);
  assert.ok(legacy.warnings.some((w) => w.includes("malformed material preset snapshot")));
});

test("parseCaseJson rejects non-JSON and missing problemtypeId", () => {
  assert.equal(parseCaseJson("not json").state, undefined);
  assert.equal(parseCaseJson("[]").state, undefined);
  assert.equal(parseCaseJson("{}").state, undefined);
});

test("parseCaseJson degrades malformed pieces to defaults with warnings", () => {
  const { state, warnings } = parseCaseJson(
    JSON.stringify({
      version: 99,
      problemtypeId: "structural",
      values: { problem: { endTime: 3 }, junk: 5 },
      assignments: [{ conditionId: "displacement", smpPath: "S" }, { bad: true }],
      materials: "nope",
      output: { format: "weird", interval: -2 },
    })
  );
  assert.ok(state);
  assert.equal(state.problemtypeId, "structural");
  assert.equal(state.values.problem.endTime, 3);
  assert.equal(state.values.junk, undefined); // non-object section dropped
  assert.equal(state.assignments.length, 1);
  assert.deepEqual(state.assignments[0].values, {});
  assert.deepEqual(state.materials, []);
  assert.equal(state.output.format, "ascii");
  assert.equal(state.output.interval, 1);
  assert.ok(warnings.some((w) => w.includes("version 99")));
  assert.ok(warnings.some((w) => w.includes("malformed entry")));
  assert.ok(warnings.some((w) => w.includes('"materials" is not an array')));
});
