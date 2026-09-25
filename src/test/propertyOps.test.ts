/**
 * Property authoring ops (propertyOps.ts): shared-edit vs clone-and-reassign,
 * the delete guard, and the assign path — including the no-propertyIds block
 * case where the assignment invents the row. Round-trips go through the
 * model-emitted writer (`writeMdpa`), which is the whole point of keeping
 * Properties ON the model rather than copied as source text.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseMdpa } from "../parser/mdpaParser";
import { writeMdpa } from "../parser/writers/mdpaWriter";
import { assignProperty, cloneProperty, createProperty, deleteProperty, maxPropertyId, setProperty } from "../parser/propertyOps";

const SRC = [
  "Begin Properties 7",
  " DENSITY 2700.0",
  " CONSTITUTIVE_LAW LinearElastic3DLaw",
  "End Properties",
  "",
  "Begin Nodes",
  " 1 0.0 0.0 0.0",
  " 2 1.0 0.0 0.0",
  " 3 1.0 1.0 0.0",
  " 4 0.0 1.0 0.0",
  " 5 2.0 0.0 0.0",
  "End Nodes",
  "",
  "Begin Elements Element2D3N",
  " 1 5 1 2 3",
  " 2 5 2 3 1",
  " 3 9 3 4 5",
  "End Elements",
  "",
  "Begin Conditions PointCondition2D1N",
  " 1 5 1",
  " 2 7 4",
  "End Conditions",
  "",
  "Begin SubModelPart Beam_West",
  " Begin SubModelPartElements",
  "  1",
  " End SubModelPartElements",
  "End SubModelPart",
].join("\n");

const base = () => parseMdpa(SRC);

test("setProperty edits the shared set in place and round-trips through the writer", () => {
  const r = setProperty(base(), 7, "DENSITY", { kind: "number", value: 3050.5 });
  assert.equal(r.changed, true);
  const text = writeMdpa(r.model, { sourceText: SRC });
  const back = parseMdpa(text);
  const set7 = back.properties?.find((s) => s.id === 7);
  assert.ok(set7);
  assert.equal(set7.variables.DENSITY.kind, "number");
  assert.equal((set7.variables.DENSITY as { value: number }).value, 3050.5);
  // the string value survived untouched
  assert.equal((set7.variables.CONSTITUTIVE_LAW as { value: string }).value, "LinearElastic3DLaw");
});

test("setProperty refuses an unknown id and noops on an identical value", () => {
  const m = base();
  assert.equal(setProperty(m, 99, "DENSITY", { kind: "number", value: 1 }).changed, false);
  const r = setProperty(m, 7, "DENSITY", { kind: "number", value: 2700 });
  assert.equal(r.changed, false);
  assert.equal(r.model, m); // same model reference handed back
});

test("createProperty picks the next free id by default and seeds one variable", () => {
  const m = base();
  assert.equal(maxPropertyId(m.properties), 7);
  const r = createProperty(m, { name: "YOUNG_MODULUS", value: { kind: "number", value: 2.1e11 } });
  assert.equal(r.changed, true);
  const created = r.model.properties!.find((s) => s.id === 8);
  assert.ok(created);
  assert.deepEqual(Object.keys(created.variables), ["YOUNG_MODULUS"]);
  assert.equal(createProperty(r.model, { id: 8 }).message, "Properties id 8 already exists.");
  assert.equal(createProperty(m, { name: "NAME_ONLY" }).message, "setting \"NAME_ONLY\" needs a value.");
});

test("cloneProperty copies variables and tables to a fresh id and touches no block", () => {
  const m = base();
  const propertyIdsBefore = m.blocks.map((b) => Array.from(b.propertyIds ?? []));
  const r = cloneProperty(m, 7);
  assert.equal(r.changed, true);
  assert.equal(r.model.properties!.length, 2);
  const clone = r.model.properties!.find((s) => s.id === 8)!;
  assert.equal((clone.variables.DENSITY as { value: number }).value, 2700);
  assert.equal((clone.variables.CONSTITUTIVE_LAW as { value: string }).value, "LinearElastic3DLaw");
  assert.deepEqual(clone.variables.DENSITY, m.properties![0].variables.DENSITY);
  assert.deepEqual(r.model.blocks.map((b) => Array.from(b.propertyIds ?? [])), propertyIdsBefore);
  assert.equal(cloneProperty(r.model, 7, 8).message, "Properties id 8 already exists.");
});

test("deleteProperty refuses while blocks reference the set, then deletes", () => {
  const m = base();
  const refused = deleteProperty(m, 7);
  assert.equal(refused.changed, false);
  assert.equal(refused.message!.includes("still assigned"), true);
  // reassign ALL referenced entities off it first — the conditions fixture
  // carries one too (its ENTITY id space is 1-2, mirroring the elements')
  const cloned = cloneProperty(m, 7);
  const movedElements = assignProperty(cloned.model, { kind: "Elements", ids: [1, 2, 3] }, 8);
  const moved = assignProperty(movedElements.model, { kind: "Conditions", ids: [2] }, 8);
  assert.equal(moved.changed, true);
  const after = deleteProperty(moved.model, 7);
  assert.equal(after.changed, true);
  assert.equal(after.model.properties!.length, 1);
  assert.equal(deleteProperty(after.model, 7).changed, false, "already gone");
  assert.equal(deleteProperty(m, 42).changed, false);
});

test("assignProperty invents propertyIds rows on a block that has none", () => {
  // a block with no propertyIds at all: strip the parsed arrays first
  const m = base();
  for (const b of m.blocks) delete (b as { propertyIds?: Int32Array }).propertyIds;
  const flag = createProperty(m, { name: "CROSS_AREA", value: { kind: "number", value: 1e-4 } });
  const r = assignProperty(flag.model, { part: "Beam_West" }, 8);
  assert.equal(r.changed, true);
  const block = r.model.blocks.find((b) => b.name === "Element2D3N")!;
  assert.ok(block.propertyIds);
  assert.equal(block.propertyIds[0], 8, "element 1 is in the part");
  assert.equal(block.propertyIds[1], 0, "element 2 is not");
});

test("assignProperty keeps independent id spaces and refuses bad scopes", () => {
  const m = base();
  const made = createProperty(m, {});
  // Conditions entity 2's row carries property 7 — colliding numbering across
  // kinds (elements and conditions both reach entity 2) must never leak.
  const otherKind = assignProperty(made.model, { kind: "Conditions", ids: [2] }, 8);
  assert.equal(otherKind.changed, true);
  const cond = otherKind.model.blocks.find((b) => b.kind === "Conditions")!;
  assert.equal(cond.propertyIds![1], 8, "condition entity 2 got the row");
  assert.equal(cond.propertyIds![0], 5, "condition entity 1 untouched");
  assert.deepEqual(
    Array.from(otherKind.model.blocks.find((b) => b.kind === "Elements")!.propertyIds ?? []),
    Array.from(m.blocks.find((b) => b.kind === "Elements")!.propertyIds ?? []),
    "Elements id space untouched"
  );
  assert.equal(assignProperty(made.model, { kind: "Geometries", ids: [1] }, 8).message, "Geometries carry no Properties — assign to Elements or Conditions.");
  assert.equal(assignProperty(m, { part: "Nonexistent" }, 8).changed, false);
  assert.equal(assignProperty(m, { kind: "Elements", ids: [1] }, 42).message, "Properties 42 does not exist — create it first.");
});
