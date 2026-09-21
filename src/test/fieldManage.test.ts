/**
 * Field rename / keep / drop / conditioning. The conditioning half is
 * cross-checked against the live meshio++ `dataCondition` for every mode,
 * scope and NaN policy (the semantics upstream documents), so a native
 * implementation cannot drift from the kernel it deliberately does not call.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseMdpa } from "../parser/mdpaParser";
import {
  renameFieldModel,
  dropFieldsModel,
  keepFieldsModel,
  conditionFieldModel,
  ConditionFieldParams,
  isValidFieldName,
} from "../parser/fieldManage";
import { loadMeshio } from "../parser/meshio";
import { MdpaModel, FieldData } from "../parser/types";

function model(): MdpaModel {
  const s = [
    "Begin Nodes", "1 0 0 0", "2 1 0 0", "3 0 1 0", "4 1 1 0", "End Nodes",
    "Begin Elements Element2D3N", "1 0 1 2 3", "2 0 2 3 4", "End Elements",
    "Begin NodalData TEMP", "1 0 1", "2 0 2", "3 0 3", "4 0 10", "End NodalData",
    "Begin NodalData VEL", "1 0 (3,4,0)", "2 0 (0,0,5)", "3 0 (6,8,0)", "4 0 (1,0,0)", "End NodalData",
    "Begin ElementalData MAT", "1 0 5", "End ElementalData",
  ].join("\n");
  const r = parseMdpa(s) as unknown as { model?: MdpaModel };
  return (r.model ?? (r as unknown as MdpaModel)) as MdpaModel;
}
const field = (m: MdpaModel, kind: string, name: string): FieldData =>
  m.fields.find((f) => f.kind === kind && f.variable === name)!;

test("rename keeps values, refuses a clash unless told to overwrite, and rejects illegal names", () => {
  const m = model();
  const r = renameFieldModel(m, { kind: "Nodal", variable: "TEMP", newName: "T2" });
  assert.equal(r.renamed, true);
  assert.deepEqual([...field(r.model, "Nodal", "T2").values], [1, 2, 3, 10]);
  assert.equal(r.model.fields.some((f) => f.variable === "TEMP"), false);
  // clash
  const clash = renameFieldModel(m, { kind: "Nodal", variable: "TEMP", newName: "VEL" });
  assert.equal(clash.renamed, false);
  assert.match(clash.message!, /already exists/);
  const over = renameFieldModel(m, { kind: "Nodal", variable: "TEMP", newName: "VEL", onConflict: "overwrite" });
  assert.equal(over.renamed, true);
  assert.equal(over.model.fields.filter((f) => f.variable === "VEL").length, 1);
  assert.equal(field(over.model, "Nodal", "VEL").components, 1);
  for (const bad of ["a:b", "9x", "has space", ""]) {
    assert.equal(isValidFieldName(bad), false);
    assert.equal(renameFieldModel(m, { kind: "Nodal", variable: "TEMP", newName: bad }).renamed, false);
  }
  assert.equal(renameFieldModel(m, { kind: "Elemental", variable: "TEMP", newName: "X" }).renamed, false);
});

test("rename follows a global reduction's source field", () => {
  const m: MdpaModel = { ...model(), globals: { tmax: { variable: "TEMP", kind: "Nodal", reduction: "max" } } };
  const r = renameFieldModel(m, { kind: "Nodal", variable: "TEMP", newName: "T2" });
  assert.equal(r.globalsUpdated, 1);
  assert.equal(r.model.globals!.tmax.variable, "T2");
});

test("drop removes by name and reports unmatched names and orphaned globals", () => {
  const m: MdpaModel = { ...model(), globals: { tmax: { variable: "TEMP", kind: "Nodal", reduction: "max" } } };
  const r = dropFieldsModel(m, { variables: ["TEMP", "NOPE"] });
  assert.deepEqual(r.removed, ["Nodal:TEMP"]);
  assert.deepEqual(r.missing, ["NOPE"]);
  assert.deepEqual(r.orphanedGlobals, ["tmax"]);
  assert.equal(dropFieldsModel(m, { variables: ["NOPE"] }).model, m, "no match hands the model back");
  // a kind restriction leaves same-named fields elsewhere alone
  const both: MdpaModel = { ...m, fields: [...m.fields, { ...field(m, "Elemental", "MAT"), kind: "Conditional" }] };
  const only = dropFieldsModel(both, { kind: "Elemental", variables: ["MAT"] });
  assert.deepEqual(only.removed, ["Elemental:MAT"]);
  assert.ok(only.model.fields.some((f) => f.kind === "Conditional" && f.variable === "MAT"));
});

test("keep retains only the listed names; a kind restriction leaves other locations untouched", () => {
  const m = model();
  const all = keepFieldsModel(m, { variables: ["TEMP"] });
  assert.deepEqual(all.model.fields.map((f) => f.variable), ["TEMP"]);
  const nodalOnly = keepFieldsModel(m, { kind: "Nodal", variables: ["TEMP"] });
  assert.deepEqual(nodalOnly.model.fields.map((f) => f.variable).sort(), ["MAT", "TEMP"]);
  assert.deepEqual(nodalOnly.removed, ["Nodal:VEL"]);
});

test("clamp / normalize / standardize on a scalar, a fixed flag survives in place", () => {
  const m = model();
  const clamp = conditionFieldModel(m, { kind: "Nodal", variable: "TEMP", mode: "clamp", lo: 2, hi: 3 });
  assert.deepEqual([...field(clamp.model, "Nodal", "TEMP").values], [2, 2, 3, 3]);
  const norm = conditionFieldModel(m, { kind: "Nodal", variable: "TEMP", mode: "normalize", lo: -1, hi: 1 });
  assert.equal(field(norm.model, "Nodal", "TEMP").values[0], -1);
  assert.equal(field(norm.model, "Nodal", "TEMP").values[3], 1);
  const std = conditionFieldModel(m, { kind: "Nodal", variable: "TEMP", mode: "standardize" });
  const v = [...field(std.model, "Nodal", "TEMP").values];
  assert.ok(Math.abs(v.reduce((a, b) => a + b) / 4) < 1e-12);
  assert.ok(Math.abs(Math.sqrt(v.reduce((a, b) => a + b * b, 0) / 4) - 1) < 1e-12);
  // original untouched
  assert.deepEqual([...field(m, "Nodal", "TEMP").values], [1, 2, 3, 10]);
});

test("an output name keeps the source and adds a sibling; gaps stay gaps", () => {
  const m = model();
  const r = conditionFieldModel(m, { kind: "Nodal", variable: "TEMP", mode: "normalize", output: "TEMP_N" });
  assert.deepEqual([...field(r.model, "Nodal", "TEMP").values], [1, 2, 3, 10]);
  assert.equal(field(r.model, "Nodal", "TEMP_N").ids.length, 4);
  // sparse: MAT covers one of two elements — conditioning writes exactly that one row
  const sparse = conditionFieldModel(m, { kind: "Elemental", variable: "MAT", mode: "clamp", lo: 0, hi: 1 });
  assert.equal(field(sparse.model, "Elemental", "MAT").ids.length, 1);
  assert.equal(sparse.conditioned, 1);
});

test("refusals: unknown field, bad range, bad output name, fail policy", () => {
  const m = model();
  assert.equal(conditionFieldModel(m, { kind: "Nodal", variable: "X", mode: "clamp" }).conditioned, 0);
  assert.equal(conditionFieldModel(m, { kind: "Nodal", variable: "TEMP", mode: "normalize", lo: 1, hi: 1 }).conditioned, 0);
  assert.equal(conditionFieldModel(m, { kind: "Nodal", variable: "TEMP", mode: "clamp", lo: 2, hi: 1 }).conditioned, 0);
  assert.equal(conditionFieldModel(m, { kind: "Nodal", variable: "TEMP", mode: "clamp", output: "a:b" }).conditioned, 0);
  const nan: MdpaModel = { ...m, fields: [{ ...field(m, "Nodal", "TEMP"), values: Float64Array.from([1, NaN, 3, 10]) }] };
  assert.throws(() => conditionFieldModel(nan, { kind: "Nodal", variable: "TEMP", mode: "clamp", nanPolicy: "fail" }), /Non-finite/);
});

// ---- cross-check against the kernel this module deliberately does not call ----

interface Case {
  name: string;
  variable: string;
  p: Omit<ConditionFieldParams, "kind" | "variable">;
  values?: number[];
}
const CASES: Case[] = [
  { name: "scalar standardize", variable: "TEMP", p: { mode: "standardize" } },
  { name: "scalar normalize to [-1,1]", variable: "TEMP", p: { mode: "normalize", lo: -1, hi: 1 } },
  { name: "scalar clamp", variable: "TEMP", p: { mode: "clamp", lo: 2, hi: 3 } },
  { name: "vector normalize (component)", variable: "VEL", p: { mode: "normalize" } },
  { name: "vector standardize (component)", variable: "VEL", p: { mode: "standardize" } },
  { name: "vector normalize (magnitude)", variable: "VEL", p: { mode: "normalize", scope: "magnitude" } },
  { name: "vector standardize (magnitude)", variable: "VEL", p: { mode: "standardize", scope: "magnitude" } },
  { name: "vector clamp (magnitude)", variable: "VEL", p: { mode: "clamp", lo: 0, hi: 4, scope: "magnitude" } },
  { name: "NaN ignored in the statistics", variable: "TEMP", values: [1, NaN, 3, 10], p: { mode: "standardize" } },
  { name: "NaN replaced", variable: "TEMP", values: [1, NaN, 3, 10], p: { mode: "clamp", lo: 0, hi: 4, nanPolicy: "replace", nanReplacement: -7 } },
  { name: "constant normalize", variable: "TEMP", values: [5, 5, 5, 5], p: { mode: "normalize", lo: 2, hi: 3 } },
  { name: "constant standardize", variable: "TEMP", values: [5, 5, 5, 5], p: { mode: "standardize" } },
];

for (const c of CASES) {
  test(`matches meshio++ dataCondition: ${c.name}`, async () => {
    const m0 = model();
    const src = field(m0, "Nodal", c.variable);
    const values = c.values ? Float64Array.from(c.values) : src.values;
    const m: MdpaModel = { ...m0, fields: [{ ...src, values }] };
    const ours = field(conditionFieldModel(m, { kind: "Nodal", variable: c.variable, ...c.p }).model, "Nodal", c.variable).values;

    const w = await loadMeshio();
    const comps = src.components;
    const mesh = {
      dim: 3,
      points: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
      cells: [{ type: "triangle", nodesPerCell: 3, data: new Int32Array([0, 1, 2, 1, 3, 2]) }],
      point_data: { [c.variable]: Float64Array.from(values) },
      point_data_components: comps > 1 ? { [c.variable]: comps } : {},
      cell_data: {},
      field_data: {},
    } as unknown as Parameters<typeof w.dataCondition>[0];
    const theirs = w.dataCondition(
      mesh, "point", [c.variable], c.p.mode, c.p.lo ?? 0, c.p.hi ?? 1, c.p.scope ?? "component",
      c.p.nanPolicy ?? "ignore", c.p.nanReplacement ?? 0, ""
    ).point_data![c.variable] as ArrayLike<number>;
    assert.equal(ours.length, theirs.length);
    for (let i = 0; i < ours.length; i++) {
      const a = ours[i];
      const b = Number(theirs[i]);
      if (Number.isNaN(b)) assert.ok(Number.isNaN(a), `row ${i}: ${a} vs NaN`);
      else assert.ok(Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b)), `row ${i}: ${a} vs ${b}`);
    }
  });
}

// ---- as operations ------------------------------------------------------------

import { applyOp, isAsyncOp, opRecordFromMessage, parseOpsJson, serializeOps, OpRecord } from "../parser/operations";

test("the field-management ops are synchronous and reachable from messages, applyOp and recipes", () => {
  for (const op of ["renameField", "keepFields", "dropFields", "conditionField"] as const) assert.equal(isAsyncOp(op), false);
  const recs: OpRecord[] = [
    opRecordFromMessage({ op: "renameField", kind: "Nodal", variable: "TEMP", newName: "T2" })!,
    opRecordFromMessage({ op: "dropFields", variables: "VEL, MAT" })!,
    opRecordFromMessage({ op: "keepFields", kind: "Nodal", variables: ["TEMP"] })!,
    opRecordFromMessage({ op: "conditionField", kind: "Nodal", variable: "TEMP", mode: "normalize", lo: "0", hi: "10", output: "TN" })!,
  ];
  for (const r of recs) assert.ok(r, "every message builds a record");
  assert.deepEqual((recs[1] as { variables: string[] }).variables, ["VEL", "MAT"]);
  // applyOp
  let m = model();
  const renamed = applyOp(m, recs[0]);
  assert.match(renamed.message!, /Renamed Nodal:TEMP to T2/);
  m = renamed.model;
  const dropped = applyOp(m, recs[1]);
  assert.match(dropped.message!, /Removed 2 field\(s\)/);
  const cond = applyOp(model(), recs[3]);
  assert.match(cond.message!, /Normalized Nodal:TEMP onto \[0, 10\]/);
  // noops carry a reason
  assert.equal(applyOp(model(), { op: "dropFields", variables: ["NOPE"] }).noop, true);
  assert.equal(applyOp(model(), { op: "renameField", kind: "Nodal", variable: "NOPE", newName: "X" }).noop, true);
  // a recipe round-trips
  const back = parseOpsJson(serializeOps(recs, "x.mdpa"));
  assert.deepEqual(back.warnings, []);
  assert.deepEqual(back.operations, recs);
});

test("malformed field-management messages and recipe entries are refused", () => {
  assert.equal(opRecordFromMessage({ op: "renameField", kind: "Nodal", variable: "T", newName: "a:b" }), undefined);
  assert.equal(opRecordFromMessage({ op: "renameField", kind: "Sideways", variable: "T", newName: "X" }), undefined);
  assert.equal(opRecordFromMessage({ op: "dropFields", variables: "  ,  " }), undefined);
  assert.equal(opRecordFromMessage({ op: "conditionField", kind: "Nodal", variable: "T", mode: "sharpen" }), undefined);
  assert.equal(opRecordFromMessage({ op: "conditionField", kind: "Nodal", variable: "T", mode: "normalize", lo: 1, hi: 1 }), undefined);
  assert.equal(opRecordFromMessage({ op: "conditionField", kind: "Nodal", variable: "T", mode: "clamp", lo: "abc" }), undefined);
  const bad = parseOpsJson(JSON.stringify({ version: 1, operations: [
    { op: "renameField", kind: "Nodal", variable: "T", newName: "bad name" },
    { op: "dropFields", variables: [] },
    { op: "conditionField", kind: "Nodal", variable: "T", mode: "normalize", lo: 2, hi: 1 },
  ] }));
  assert.equal(bad.operations.length, 0);
  assert.equal(bad.warnings.length, 3);
});
