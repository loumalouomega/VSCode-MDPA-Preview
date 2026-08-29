/**
 * The mdpa `Begin Properties` value parser (see src/parser/propertiesParser.ts)
 * and its wiring into the line-oriented parser.
 *
 * Two things are pinned here beyond "the values parse": that the addition is
 * **purely additive** — `MetaBlock.lineCount` keeps its historical meaning, so
 * the writer's verbatim copy-out and mergeMesh's reporting are untouched — and
 * that nothing nested inside a Properties block escapes into the model.
 */

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import test from "node:test";

import { parseMdpa } from "../parser/mdpaParser";
import { removeOrphanNodes } from "../parser/removeOrphanNodes";
import { renumberModel } from "../parser/renumberMesh";
import { extractSubModelPart } from "../parser/subModelPartExtract";
import {
  findPropertySet,
  parsePropertyValue,
  propertiesIdFromArgs,
  propertyNumber,
  propertyValue,
} from "../parser/propertiesParser";

const FIXTURE_ROOT = path.resolve(__dirname, "../../src/test/fixtures");
const READ_FIXTURE = path.join(
  FIXTURE_ROOT,
  "kratos/tests/auxiliar_files_for_python_unittest/mdpa_files/test_model_part_io_read.mdpa"
);

function parse(lines: string[]) {
  return parseMdpa(lines.join("\n"));
}

// ---------------------------------------------------------------- value forms

test("a bare number is a number", () => {
  assert.deepEqual(parsePropertyValue("3.4E-5"), { kind: "number", value: 3.4e-5 });
  assert.deepEqual(parsePropertyValue("1"), { kind: "number", value: 1 });
  assert.deepEqual(parsePropertyValue("-2"), { kind: "number", value: -2 });
});

test("Kratos' Python-cased booleans are booleans, not strings", () => {
  assert.deepEqual(parsePropertyValue("False"), { kind: "bool", value: false });
  assert.deepEqual(parsePropertyValue("True"), { kind: "bool", value: true });
  assert.deepEqual(parsePropertyValue("true"), { kind: "bool", value: true });
});

test("a vector parses with or without a space before the payload", () => {
  const spaced = parsePropertyValue("[3] (0.00,0.00,9.8)");
  const tight = parsePropertyValue("[3](0.00,0.00,9.8)");
  assert.deepEqual(spaced, { kind: "vector", values: [0, 0, 9.8] });
  assert.deepEqual(tight, spaced);
});

test("a matrix parses into rows", () => {
  const v = parsePropertyValue("[3,3] ((0, 0.27,0.27),(0.087,0,0.27),(0.075,0.23,0))");
  assert.deepEqual(v, {
    kind: "matrix",
    rows: [
      [0, 0.27, 0.27],
      [0.087, 0, 0.27],
      [0.075, 0.23, 0],
    ],
  });
});

test("a constitutive law name is kept verbatim and SILENTLY", () => {
  // Every real structural mdpa carries one of these. If an unrecognised value
  // emitted a diagnostic, opening such a file would produce a wall of warnings
  // — so `string` is the silent universal fallback, and only a value that
  // announces a structure it then fails to honour is worth reporting.
  const seen: string[] = [];
  const v = parsePropertyValue("LinearElastic3DLaw", (m) => seen.push(m));
  assert.deepEqual(v, { kind: "string", value: "LinearElastic3DLaw" });
  assert.equal(seen.length, 0);
});

test("a declared size that disagrees with the payload keeps the values and reports", () => {
  const seen: string[] = [];
  const v = parsePropertyValue("[3] (1,2)", (m) => seen.push(m));
  assert.deepEqual(v, { kind: "vector", values: [1, 2] });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /declares \[3\] but carries 2/);
});

test("a structured value whose payload is not numbers degrades to a string", () => {
  const seen: string[] = [];
  const v = parsePropertyValue("[3] (a,b,c)", (m) => seen.push(m));
  assert.deepEqual(v, { kind: "string", value: "[3] (a,b,c)" });
  assert.equal(seen.length, 1);
});

// ------------------------------------------------------------------- the id

test("a missing or unreadable Properties id is refused, never defaulted to 0", () => {
  // Defaulting would let a malformed header shadow the real `Properties 0`
  // that every example mesh declares.
  assert.equal(propertiesIdFromArgs(["1"]), 1);
  assert.equal(propertiesIdFromArgs([]), undefined);
  assert.equal(propertiesIdFromArgs(["oops"]), undefined);
});

test("a Properties block with no readable id is diagnosed and its values dropped", () => {
  const m = parse([
    "Begin Properties",
    "    DENSITY 1.0",
    "End Properties",
    "Begin Nodes",
    "1 0 0 0",
    "End Nodes",
  ]);
  assert.equal(m.properties, undefined);
  assert.ok(m.diagnostics.some((d) => /no readable id/.test(d.message)));
});

test("a duplicate Properties id keeps the FIRST block and reports", () => {
  const m = parse([
    "Begin Properties 1",
    "    DENSITY 1.0",
    "End Properties",
    "Begin Properties 1",
    "End Properties",
  ]);
  assert.equal(m.properties!.length, 1);
  assert.equal(propertyNumber(m.properties![0], "DENSITY"), 1);
  assert.ok(m.diagnostics.some((d) => /Duplicate "Begin Properties 1"/.test(d.message)));
});

// --------------------------------------------------------------- the wiring

test("a mesh with no Properties gets no properties slot at all", () => {
  const m = parse(["Begin Nodes", "1 0 0 0", "End Nodes"]);
  assert.equal(m.properties, undefined);
});

test("an empty Properties block still registers, so its id resolves", () => {
  const m = parse(["Begin Properties 0", "End Properties"]);
  assert.deepEqual(m.properties!.map((p) => p.id), [0]);
});

test("blank lines and comments inside a Properties block are tolerated", () => {
  const m = parse([
    "Begin Properties 1",
    "",
    "    DENSITY 2700.0  // kg/m3",
    "",
    "End Properties",
  ]);
  assert.equal(propertyNumber(m.properties![0], "DENSITY"), 2700);
});

test("a nested Table is attached to its Properties set, not leaked as a meta block", () => {
  const m = parse([
    "Begin Properties 1",
    "    DENSITY 1.0",
    "    Begin Table TEMPERATURE VISCOSITY",
    "        200. 2e-6",
    "        300. 3e-6",
    "    End Table",
    "End Properties",
  ]);
  const set = m.properties![0];
  assert.equal(set.tables.length, 1);
  assert.deepEqual(set.tables[0].args, ["TEMPERATURE", "VISCOSITY"]);
  assert.deepEqual(set.tables[0].rows, [
    [200, 2e-6],
    [300, 3e-6],
  ]);
  // It used to become a stray top-level MetaBlock; now the only one is the
  // Properties block itself.
  assert.deepEqual(m.meta.map((x) => x.label), ["Properties 1"]);
});

test("a nested Table does NOT change the enclosing block's lineCount", () => {
  // The writer's verbatim path and mergeMesh's reporting both read `meta`, so
  // this number must keep meaning exactly what it meant before.
  const m = parse([
    "Begin Properties 1",
    "    DENSITY 1.0",
    "    Begin Table TEMPERATURE VISCOSITY",
    "        200. 2e-6",
    "    End Table",
    "End Properties",
  ]);
  assert.equal(m.meta[0].lineCount, 1);
});

test("a SubModelPart nested inside Properties is swallowed, not parsed as a real part", () => {
  // handleBegin dispatches on the block type alone, so before the trap door
  // this produced a genuine top-level SubModelPart out of nowhere.
  const m = parse([
    "Begin Properties 1",
    "    Begin SubModelPart Bogus",
    "        Begin SubModelPartNodes",
    "            1",
    "        End SubModelPartNodes",
    "    End SubModelPart",
    "End Properties",
    "Begin Nodes",
    "1 0 0 0",
    "End Nodes",
  ]);
  assert.deepEqual(m.subModelParts, []);
  assert.equal(m.properties!.length, 1);
});

test("a real SubModelPart after a Properties block is still parsed", () => {
  // The trap door must close when the Properties block does.
  const m = parse([
    "Begin Properties 1",
    "End Properties",
    "Begin Nodes",
    "1 0 0 0",
    "End Nodes",
    "Begin SubModelPart Real",
    "    Begin SubModelPartNodes",
    "        1",
    "    End SubModelPartNodes",
    "End SubModelPart",
  ]);
  assert.deepEqual(m.subModelParts.map((p) => p.name), ["Real"]);
});

test("a variable named __proto__ is an ordinary value, not a prototype write", () => {
  // Names come off disk; a bare obj[name] lookup would reach Object.prototype.
  const m = parse(["Begin Properties 1", "    __proto__ 5", "End Properties"]);
  const set = m.properties![0];
  assert.deepEqual(propertyValue(set, "__proto__"), { kind: "number", value: 5 });
  assert.equal(propertyValue(set, "constructor"), undefined);
  assert.equal(propertyNumber(set, "toString"), undefined);
});

// ------------------------------------------------------------- real fixture

test("the reference Kratos fixture parses every value form it carries", () => {
  const m = parseMdpa(fs.readFileSync(READ_FIXTURE, "utf8"));
  const set = findPropertySet(m.properties, 1)!;
  assert.ok(set);
  assert.equal(propertyNumber(set, "DENSITY"), 3.4e-5);
  assert.deepEqual(propertyValue(set, "COMPUTE_LUMPED_MASS_MATRIX"), {
    kind: "bool",
    value: false,
  });
  assert.deepEqual(propertyValue(set, "VOLUME_ACCELERATION"), {
    kind: "vector",
    values: [0, 0, 9.8],
  });
  const tensor = propertyValue(set, "LOCAL_INERTIA_TENSOR");
  assert.equal(tensor?.kind, "matrix");
  assert.equal(tensor.kind === "matrix" ? tensor.rows.length : 0, 3);
  assert.equal(set.tables.length, 1);
});

test("the reference fixture's Properties lineCount is unchanged by this feature", () => {
  const m = parseMdpa(fs.readFileSync(READ_FIXTURE, "utf8"));
  const meta = m.meta.find((x) => x.label === "Properties 1");
  assert.equal(meta!.lineCount, 7);
});

test("properties survive the operations that keep propertyIds", () => {
  // The slot is OPTIONAL, so an op that builds a full MdpaModel literal drops
  // it with no type error. These are the ones that keep `propertyIds` on their
  // cells, so a dropped slot would leave every id dangling.
  const src = [
    "Begin Properties 7",
    "    CROSS_AREA 0.01",
    "End Properties",
    "Begin Nodes",
    "1 0 0 0",
    "2 1 0 0",
    "3 2 0 0",
    "End Nodes",
    "Begin Elements Element3D2N",
    "1 7 1 2",
    "End Elements",
    "Begin SubModelPart Part",
    "    Begin SubModelPartNodes",
    "        1",
    "        2",
    "    End SubModelPartNodes",
    "    Begin SubModelPartElements",
    "        1",
    "    End SubModelPartElements",
    "End SubModelPart",
  ].join("\n");
  const model = parseMdpa(src);
  assert.equal(propertyNumber(findPropertySet(model.properties, 7)!, "CROSS_AREA"), 0.01);

  // node 3 is referenced by nothing
  const pruned = removeOrphanNodes(model).model;
  assert.ok(findPropertySet(pruned.properties, 7), "removeOrphanNodes dropped properties");

  const renumbered = renumberModel(model, { start: 100 }).model;
  assert.ok(findPropertySet(renumbered.properties, 7), "renumber dropped properties");

  const part = extractSubModelPart(model, "Part");
  assert.ok(part, "the part should extract");
  assert.ok(findPropertySet(part!.properties, 7), "extractSubModelPart dropped properties");
  assert.equal(part!.blocks[0].propertyIds![0], 7, "…while its cells still point at 7");
});

test("parsed properties survive a JSON round trip", () => {
  // They ride to the webview on MdpaModel, and the screenshot harness
  // re-serializes every message through JSON.stringify — which is why the
  // container is a plain array of plain objects and never a Map.
  const m = parseMdpa(fs.readFileSync(READ_FIXTURE, "utf8"));
  const revived = JSON.parse(JSON.stringify(m.properties)) as typeof m.properties;
  assert.equal(propertyNumber(findPropertySet(revived, 1)!, "DENSITY"), 3.4e-5);
});
