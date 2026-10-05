/**
 * Field dimensions (former roadmap item 12): an OpenFOAM `dimensions [..]` vector is read onto the
 * field, survives the edits that keep a field, labels the exports, gates comparison, and is the
 * ONLY thing the explicit kinematic-pressure → Pa conversion trusts — never a field's name.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  DIMENSIONLESS,
  KINEMATIC_PRESSURE,
  PRESSURE,
  checkCompatible,
  convertFieldUnits,
  describeExponents,
  fieldUnitLabel,
  labelWithUnit,
  normalizeExponents,
} from "../parser/fieldDimensions";
import { parseFoamField } from "../parser/openfoamFields";
import { parseMeshFile } from "../parser/meshFileParser";
import { writeMeshioBytes } from "../parser/meshio";
import { compareFieldData, compareFieldModel, compareMeshes } from "../parser/meshCompare";
import { applyOp, opRecordFromMessage, parseOpsJson, serializeOps } from "../parser/operations";
import { mergeManyModels } from "../parser/mergeMesh";
import { sliceField } from "../parser/subModelPartExtract";
import { removeOrphanNodes } from "../parser/removeOrphanNodes";
import { refineModel } from "../parser/refineMesh";
import { seriesToCsv, FieldSeries } from "../parser/fieldSeries";
import { prepareTable, toCsv } from "../parser/dataTable";
import { meshInfo, meshTransform, meshCompare } from "../mcp/tools";
import type { FieldData, MdpaDiagnostic, MdpaModel } from "../parser/types";

const hdr = (cls: string, obj: string) =>
  `FoamFile\n{\n    version 2.0;\n    format ascii;\n    class ${cls};\n    object ${obj};\n}\n`;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "field-dims-"));
}

/** A one-hexahedron OpenFOAM case at time 0 carrying `p` (given dimensions line) and an undimensioned `T`. */
async function writeCase(dir: string, name: string, pDims: string | undefined, pValue = 100): Promise<string> {
  const marker = path.join(dir, `${name}.foam`);
  const model = {
    nodeCount: 8,
    nodeIds: new Int32Array([1, 2, 3, 4, 5, 6, 7, 8]),
    coords: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]),
    blocks: [
      {
        kind: "Elements" as const,
        name: "hex",
        vtkCellType: 12,
        count: 1,
        stride: 8,
        entityIds: new Int32Array([1]),
        connectivity: new Int32Array([1, 2, 3, 4, 5, 6, 7, 8]),
      },
    ],
    subModelParts: [],
    meta: [],
    fields: [],
    diagnostics: [],
    is3D: true,
    bounds: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] },
  };
  const { data, companions } = await writeMeshioBytes(model as never, ".foam", { stem: name });
  fs.writeFileSync(marker, data);
  for (const c of companions) {
    const p = path.join(dir, c.name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c.data);
  }
  fs.mkdirSync(path.join(dir, "0"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "0", "p"),
    hdr("volScalarField", "p") + (pDims ? `dimensions [${pDims}];\n` : "") + `internalField uniform ${pValue};\n`
  );
  fs.writeFileSync(path.join(dir, "0", "T"), hdr("volScalarField", "T") + "internalField uniform 300;\n");
  return marker;
}

const elemental = (m: MdpaModel, name: string): FieldData =>
  m.fields.find((f) => f.kind === "Elemental" && f.variable === name)!;

// ---- the pure module ---------------------------------------------------------------

test("exponents are described in named and SI forms, and only 5- or 7-entry sets are dimensions", () => {
  assert.equal(describeExponents(PRESSURE), "Pa");
  assert.equal(describeExponents(KINEMATIC_PRESSURE), "m²/s²");
  assert.equal(describeExponents(DIMENSIONLESS), "1");
  assert.equal(describeExponents([1, 2, -3, 0, 0, 0, 0]), "kg·m²·s⁻³");
  assert.deepEqual(normalizeExponents([0, 2, -2, 0, 0]), [0, 2, -2, 0, 0, 0, 0], "5 entries are padded");
  assert.equal(normalizeExponents([0, 2, -2]), undefined);
  assert.equal(normalizeExponents([0, 2, NaN, 0, 0, 0, 0]), undefined);
  assert.equal(fieldUnitLabel({}), undefined, "absent dimensions are UNKNOWN, not '1'");
  assert.equal(labelWithUnit({ variable: "p", dimensions: { exponents: [...KINEMATIC_PRESSURE] } }), "p [m²/s²]");
  assert.equal(labelWithUnit({ variable: "PRESSURE" }), "PRESSURE");
});

test("displayAlternatives offers same-dimension SI units and never rewrites samples", async () => {
  const { displayAlternatives, displayScaleFor } = await import("../parser/fieldDimensions");
  const pa = { dimensions: { exponents: [1, -1, -2, 0, 0, 0, 0] } };
  const alts = displayAlternatives(pa).map((a) => a.unit);
  assert.ok(alts.includes("Pa") && alts.includes("kPa") && alts.includes("MPa"));
  assert.equal(displayScaleFor(pa, "kPa"), 1000);
  assert.equal(displayScaleFor(pa, "MPa"), 1e6);
  assert.equal(displayScaleFor(pa, undefined), 1);
  assert.equal(displayScaleFor(pa, "furlongs"), 1, "unknown names fall back to raw numbers");
  assert.deepEqual(displayAlternatives({}), [], "unknown dimensions offer nothing");
  assert.deepEqual(displayAlternatives({ dimensions: { exponents: [0, 0, 0, 1, 0, 0, 0] } }).map((a) => a.unit), ["K"]);
  // Switching units is view-only: raw 1000 Pa reads 1 in kPa and back.
  assert.equal(1000 / displayScaleFor(pa, "kPa"), 1);
  assert.equal(1 * displayScaleFor(pa, "kPa"), 1000);
});

test("a meshio++ round trip cannot carry dimensions: adopted fields stay unknown", async () => {
  const { meshioToModel, modelToMeshio } = await import("../parser/meshioConvert");
  const { tetBar } = await import("./fixtures/shapes");
  const stamped = {
    ...tetBar(2),
    fields: tetBar(2).fields.map((f) =>
      f.variable === "T" ? { ...f, dimensions: { exponents: [0, 0, 0, 1, 0, 0, 0] } } : f
    ),
  };
  const back = meshioToModel(modelToMeshio(stamped, []), []);
  const t = back.fields.find((f) => f.variable === "T");
  assert.ok(t, "the field survives the round trip");
  assert.equal(t!.dimensions, undefined, "dimensions do not survive a meshio++ round trip by construction");
});

test("exponentsForUnitName maps curated SI spellings and nothing else", async () => {
  const { exponentsForUnitName } = await import("../parser/fieldDimensions");
  assert.deepEqual(exponentsForUnitName("Pa"), [1, -1, -2, 0, 0, 0, 0]);
  assert.deepEqual(exponentsForUnitName("kPa"), [1, -1, -2, 0, 0, 0, 0], "scale is not dimensions");
  assert.deepEqual(exponentsForUnitName("m/s"), [0, 1, -1, 0, 0, 0, 0]);
  assert.deepEqual(exponentsForUnitName("m²/s²"), [0, 2, -2, 0, 0, 0, 0]);
  assert.deepEqual(exponentsForUnitName("kg/m3"), [1, -3, 0, 0, 0, 0, 0]);
  assert.deepEqual(exponentsForUnitName("K"), [0, 0, 0, 1, 0, 0, 0]);
  assert.equal(exponentsForUnitName(""), undefined, "blank stays unknown");
  assert.equal(exponentsForUnitName("°C"), undefined, "offsets are not factors");
  assert.equal(exponentsForUnitName("furlongs per fortnight"), undefined, "unknown stays unknown");
});

test("checkCompatible: equal ok, different refused, one unknown proceeds with a note", () => {
  const kin = { variable: "p", dimensions: { exponents: [...KINEMATIC_PRESSURE] } };
  const pa = { variable: "p_Pa", dimensions: { exponents: [...PRESSURE] } };
  const unknown = { variable: "PRESSURE" };
  assert.equal(checkCompatible(kin, kin).status, "ok");
  const bad = checkCompatible(kin, pa);
  assert.equal(bad.status, "mismatch");
  assert.match((bad as { message: string }).message, /convertFieldUnits/);
  const note = checkCompatible(kin, unknown);
  assert.equal(note.status, "unverified");
  assert.equal(checkCompatible(unknown, { variable: "X" }).status, "ok");
});

test("derivativeDimensions divides by length and drops the gauge/absolute reference", async () => {
  const { derivativeDimensions } = await import("../parser/fieldDimensions");
  const k = { dimensions: { exponents: [0, 0, 0, 1, 0, 0, 0] } };
  assert.deepEqual(derivativeDimensions(k, 1)?.exponents, [0, -1, 0, 1, 0, 0, 0]);
  assert.deepEqual(derivativeDimensions(k, 2)?.exponents, [0, -2, 0, 1, 0, 0, 0]);
  const gauge = {
    dimensions: { exponents: [...KINEMATIC_PRESSURE], reference: "gauge" as const },
  };
  const d = derivativeDimensions(gauge, 1)!;
  assert.deepEqual(d.exponents, [0, 1, -2, 0, 0, 0, 0]);
  assert.equal(d.reference, undefined, "a derivative has no gauge/absolute reference");
  const conv = {
    dimensions: { exponents: [...PRESSURE], convertedFrom: { variable: "p", density: 1.2 } },
  };
  assert.deepEqual(derivativeDimensions(conv, 1)?.convertedFrom, { variable: "p", density: 1.2 });
  assert.equal(derivativeDimensions({}, 1), undefined);
  assert.equal(derivativeDimensions(undefined, 1), undefined);
});

const kinematic = (values: number[] = [1, 2, 3]): FieldData => ({
  kind: "Elemental",
  variable: "p",
  components: 1,
  ids: Int32Array.from(values.map((_, i) => i + 1)),
  values: Float64Array.from(values),
  dimensions: { exponents: [...KINEMATIC_PRESSURE] },
});

test("convertFieldUnits multiplies by the density, keeps the source and records the provenance", () => {
  const src = kinematic();
  const r = convertFieldUnits([src], { variable: "p", density: 1.2, reference: "gauge" });
  assert.ok(r.changed, r.message);
  assert.equal(r.fields.length, 2);
  const out = r.fields.find((f) => f.variable === "p_Pa")!;
  assert.deepEqual(Array.from(out.values), [1.2, 2.4, 3.5999999999999996]);
  assert.deepEqual(out.dimensions, { exponents: [...PRESSURE], reference: "gauge", convertedFrom: { variable: "p", density: 1.2 } });
  assert.deepEqual(Array.from(src.values), [1, 2, 3], "the original samples are untouched");
  assert.deepEqual(r.fields[0].dimensions, { exponents: [...KINEMATIC_PRESSURE] });
});

test("convertFieldUnits: the four distinct refusals", () => {
  // Dimensional pressure is already Pa.
  const pa: FieldData = { ...kinematic(), dimensions: { exponents: [...PRESSURE] } };
  const already = convertFieldUnits([pa], { variable: "p", density: 1 });
  assert.equal(already.changed, false);
  assert.match(already.message, /already \[Pa\]/);
  // Unknown dimensions: a name is not evidence.
  const { dimensions: _d, ...bare } = kinematic();
  const unknown = convertFieldUnits([bare as FieldData], { variable: "p", density: 1 });
  assert.equal(unknown.changed, false);
  assert.match(unknown.message, /no recorded dimensions/);
  assert.match(unknown.message, /not evidence/);
  // Other dimensions (a velocity).
  const vel: FieldData = { ...kinematic(), dimensions: { exponents: [0, 1, -1, 0, 0, 0, 0] } };
  assert.match(convertFieldUnits([vel], { variable: "p", density: 1 }).message, /not a kinematic pressure/);
  // A density that is not positive and finite.
  for (const density of [0, -1, NaN, Infinity]) {
    assert.equal(convertFieldUnits([kinematic()], { variable: "p", density }).changed, false);
  }
  // The output must be new.
  assert.match(convertFieldUnits([kinematic()], { variable: "p", density: 1, output: "p" }).message, /new field/);
});

test("convertFieldUnits takes the density from a same-kind scalar field", () => {
  const rho = (ids: number[], values: number[], dims?: number[]): FieldData => ({
    kind: "Elemental",
    variable: "RHO",
    components: 1,
    ids: Int32Array.from(ids),
    values: Float64Array.from(values),
    ...(dims ? { dimensions: { exponents: dims } } : {}),
  });
  const src = [kinematic(), rho([1, 2, 3], [2, 3, 4], [1, -3, 0, 0, 0, 0, 0])];
  const r = convertFieldUnits(src, { variable: "p", densityField: { variable: "RHO" } });
  assert.ok(r.changed, r.message);
  const out = r.fields.find((f) => f.variable === "p_Pa")!;
  assert.deepEqual(Array.from(out.values), [2, 6, 12]);
  assert.deepEqual(out.dimensions?.convertedFrom, { variable: "p", densityField: "RHO" });
  // A gap on either side stays a gap: RHO missing id 3 drops that row.
  const gapped = convertFieldUnits([kinematic(), rho([1, 2], [2, 3], [1, -3, 0, 0, 0, 0, 0])], {
    variable: "p",
    densityField: { variable: "RHO" },
  });
  assert.ok(gapped.changed);
  assert.deepEqual(Array.from(gapped.fields.find((f) => f.variable === "p_Pa")!.ids), [1, 2]);
  assert.match(gapped.message, /stayed gaps/);
  // An undimensioned density field is taken on the caller's word, and said so.
  const bare = convertFieldUnits([kinematic(), rho([1, 2, 3], [2, 2, 2])], {
    variable: "p",
    densityField: { variable: "RHO" },
  });
  assert.ok(bare.changed);
  assert.match(bare.message, /taken on your word/);
  // A density field with known, non-density dimensions is refused.
  const wrong = convertFieldUnits(
    [kinematic(), rho([1, 2, 3], [2, 2, 2], [0, 1, -1, 0, 0, 0, 0])],
    { variable: "p", densityField: { variable: "RHO" } }
  );
  assert.equal(wrong.changed, false);
  assert.match(wrong.message, /not a density/);
  // A different kind cannot form per-entity products.
  const nodal: FieldData = { ...rho([1, 2, 3], [2, 2, 2]), kind: "Nodal" };
  assert.match(
    convertFieldUnits([kinematic(), nodal], { variable: "p", densityField: { variable: "RHO" } }).message,
    /same entity kind/
  );
  // Scalar and field conflict, and both/neither is refused.
  assert.match(
    convertFieldUnits(src, { variable: "p", density: 1, densityField: { variable: "RHO" } }).message,
    /not both/
  );
  assert.match(convertFieldUnits([kinematic()], { variable: "p" } as never).message, /never inferred/);
  // Re-running with the same field replaces; a different source refuses.
  const again = convertFieldUnits(r.fields, { variable: "p", densityField: { variable: "RHO" } });
  assert.ok(again.changed);
  assert.equal(again.fields.filter((f) => f.variable === "p_Pa").length, 1);
  const clash = convertFieldUnits(r.fields, { variable: "p", density: 1 });
  assert.equal(clash.changed, false);
  assert.match(clash.message, /refusing to replace/);
});

test("convertFieldUnits: the same density re-runs idempotently, a conflicting one is refused", () => {
  const first = convertFieldUnits([kinematic()], { variable: "p", density: 1.2 });
  const again = convertFieldUnits(first.fields, { variable: "p", density: 1.2 });
  assert.ok(again.changed);
  assert.equal(again.fields.filter((f) => f.variable === "p_Pa").length, 1, "replaced, not stacked");
  const conflict = convertFieldUnits(first.fields, { variable: "p", density: 998 });
  assert.equal(conflict.changed, false);
  assert.match(conflict.message, /already converted with density 1\.2/);
  // A field that merely happens to share the output name is not this op's to overwrite.
  const clash: FieldData = { kind: "Elemental", variable: "p_Pa", components: 1, ids: Int32Array.of(1), values: Float64Array.of(9) };
  assert.match(convertFieldUnits([kinematic(), clash], { variable: "p", density: 1 }).message, /already exists/);
});

// ---- reader --------------------------------------------------------------------------

test("parseFoamField reads the dimensions vector, pads 5 entries and reports a malformed set", () => {
  const d: MdpaDiagnostic[] = [];
  const src = (dims: string) => hdr("volScalarField", "p") + `dimensions [${dims}];\ninternalField uniform 1;\n`;
  assert.deepEqual(parseFoamField(src("1 -1 -2 0 0 0 0"), "p", d)?.dimensions, [1, -1, -2, 0, 0, 0, 0]);
  assert.deepEqual(parseFoamField(src("0 2 -2 0 0"), "p", d)?.dimensions, [0, 2, -2, 0, 0, 0, 0]);
  assert.equal(d.length, 0);
  const bad = parseFoamField(src("0 2 -2"), "p", d);
  assert.equal(bad?.dimensions, undefined);
  assert.ok(d.some((x) => /not a numeric 5- or 7-entry set/.test(x.message)));
  assert.equal(parseFoamField(hdr("volScalarField", "p") + "internalField uniform 1;\n", "p", [])?.dimensions, undefined);
});

test("a read case carries dimensions on the field that stated them and NOT on one that did not", async () => {
  const dir = tmpDir();
  const marker = await writeCase(dir, "run", "0 2 -2 0 0 0 0");
  const m = await parseMeshFile(marker);
  assert.deepEqual(elemental(m, "p").dimensions, { exponents: [0, 2, -2, 0, 0, 0, 0] });
  assert.equal(elemental(m, "T").dimensions, undefined, "no dimensions line means UNKNOWN");
  assert.equal(fieldUnitLabel(elemental(m, "p")), "m²/s²");
});

test("the OpenFOAM field writer writes a field's recorded dimensions and dimensionless zeros otherwise", async () => {
  const dir = tmpDir();
  const marker = await writeCase(dir, "run", "0 2 -2 0 0 0 0");
  const m = await parseMeshFile(marker);
  const out = await writeMeshioBytes(m, ".foam", { stem: "out" });
  const text = (name: string) => Buffer.from(out.companions.find((c) => c.name === name)!.data).toString("utf8");
  assert.match(text("0/p"), /dimensions\s+\[0 2 -2 0 0 0 0\];/);
  assert.match(text("0/T"), /dimensions\s+\[0 0 0 0 0 0 0\];/);
});

// ---- carried through edits -----------------------------------------------------------

test("dimensions survive the ops that rebuild a field: slice, orphan removal, refine", async () => {
  const dir = tmpDir();
  const m = await parseMeshFile(await writeCase(dir, "run", "0 2 -2 0 0 0 0"));
  const p = elemental(m, "p");
  assert.deepEqual(sliceField(p, new Set([1]))?.dimensions, p.dimensions);
  const trimmed = removeOrphanNodes({ ...m, nodeCount: m.nodeCount });
  assert.ok(trimmed.model.fields.every((f) => f.variable !== "p" || f.dimensions));
  const refined = refineModel(m, 1);
  assert.deepEqual(elemental(refined.model, "p").dimensions, p.dimensions);
});

test("conditionField keeps the units of a clamp and leaves normalize/standardize UNKNOWN", async () => {
  const dir = tmpDir();
  const m = await parseMeshFile(await writeCase(dir, "run", "0 2 -2 0 0 0 0"));
  const clamp = opRecordFromMessage({ op: "conditionField", kind: "Elemental", variable: "p", mode: "clamp", lo: 0, hi: 5 })!;
  assert.deepEqual(elemental(applyOp(m, clamp).model, "p").dimensions, elemental(m, "p").dimensions);
  const norm = opRecordFromMessage({ op: "conditionField", kind: "Elemental", variable: "p", mode: "normalize" })!;
  assert.equal(elemental(applyOp(m, norm).model, "p").dimensions, undefined);
});

test("merging fields with different dimensions renames imported rows; known + unknown merges to unknown", async () => {
  const dir = tmpDir();
  const a = await parseMeshFile(await writeCase(dir, "a", "0 2 -2 0 0 0 0"));
  const pa = await parseMeshFile(await writeCase(dir, "b", "1 -1 -2 0 0 0 0"));
  const mismatch = mergeManyModels(a, [{ model: pa, name: "b" }], {});
  assert.equal(elemental(mismatch.model, "p").ids.length, 1, "the base p stays under its original name");
  const imported = elemental(mismatch.model, "p_2");
  assert.equal(imported.ids.length, 1, "the imported p is preserved under a unique name");
  assert.deepEqual(imported.dimensions, pa.fields.find((f) => f.kind === "Elemental" && f.variable === "p")!.dimensions);
  assert.ok(mismatch.model.diagnostics.some((d) => /different dimensions.*renamed.*p_2/.test(d.message)));

  const bare = await parseMeshFile(await writeCase(dir, "c", undefined));
  const mixed = mergeManyModels(a, [{ model: bare, name: "c" }], {});
  assert.equal(elemental(mixed.model, "p").ids.length, 2);
  assert.equal(elemental(mixed.model, "p").dimensions, undefined);
});

// ---- comparison -----------------------------------------------------------------------

test("comparison refuses two known, different dimensions and points at the conversion", async () => {
  const dir = tmpDir();
  const kin = await parseMeshFile(await writeCase(dir, "a", "0 2 -2 0 0 0 0", 100));
  const pa = await parseMeshFile(await writeCase(dir, "b", "1 -1 -2 0 0 0 0", 120));
  const d = compareFieldData(elemental(kin, "p"), elemental(pa, "p"), 0, 0);
  assert.deepEqual(d.dimensionMismatch, { a: "m²/s²", b: "Pa" });
  assert.equal(d.compared, 0);
  assert.equal(compareMeshes(kin, pa).verdict, "different");

  const r = await compareFieldModel(kin, pa, { variable: "p", kind: "Elemental" });
  assert.equal(r.written.length, 0);
  assert.match(r.message ?? "", /convertFieldUnits/);

  // After the explicit conversion the two compare, and the difference is in Pa.
  const conv = applyOp(kin, opRecordFromMessage({ op: "convertFieldUnits", variable: "p", density: 1.2, kind: "Elemental" })!);
  assert.equal(elemental(conv.model, "p_Pa").values[0], 120);
  const ok = await compareFieldModel(conv.model, pa, { variable: "p_Pa", sourceVariable: "p", kind: "Elemental", output: "dp" });
  assert.deepEqual(ok.written, ["Elemental:dp_DIFF", "Elemental:dp_ABS", "Elemental:dp_REL"]);
  assert.deepEqual(elemental(ok.model, "dp_DIFF").dimensions?.exponents, [...PRESSURE]);
  assert.deepEqual(elemental(ok.model, "dp_REL").dimensions?.exponents, [...DIMENSIONLESS]);
});

test("comparing a dimensioned field with an undimensioned one proceeds, and says what is assumed", async () => {
  const dir = tmpDir();
  const kin = await parseMeshFile(await writeCase(dir, "a", "0 2 -2 0 0 0 0", 100));
  const bare = await parseMeshFile(await writeCase(dir, "b", undefined, 130));
  const r = await compareFieldModel(kin, bare, { variable: "p", kind: "Elemental" });
  assert.equal(r.written.length, 3);
  assert.match(r.message ?? "", /Dimensions of "p" are unknown/);
  assert.equal(elemental(r.model, "p_DIFF").dimensions, undefined);
});

// ---- labels and exports ---------------------------------------------------------------

test("CSV headers carry the unit only for a field that states its dimensions", async () => {
  const dir = tmpDir();
  const m = await parseMeshFile(await writeCase(dir, "run", "0 2 -2 0 0 0 0"));
  const table = prepareTable(m, "Elements", {});
  const header = toCsv(table).split(/\r?\n/)[0].split(",");
  assert.ok(header.includes("p [m²/s²]"), header.join("|"));
  assert.ok(header.includes("T"), "an undimensioned field keeps its bare header");

  const series = {
    kind: "Elemental", variable: "p", entityId: 1, components: 1, componentNames: ["p"], unit: "m²/s²",
    labels: ["0"], frameIndices: [0], values: [[1]], present: 1, missingField: 0, missingId: 0, errors: [], cancelled: false,
  } as FieldSeries;
  assert.equal(seriesToCsv(series).split("\r\n")[0], "step,frame,p [m²/s²]");
  assert.equal(seriesToCsv({ ...series, unit: undefined }).split("\r\n")[0], "step,frame,p");
});

// ---- recipes and MCP -------------------------------------------------------------------

test("the record validates its density and round-trips through a recipe", () => {
  assert.equal(opRecordFromMessage({ op: "convertFieldUnits", variable: "p", density: 0 }), undefined);
  assert.equal(opRecordFromMessage({ op: "convertFieldUnits", variable: "p", density: "x" }), undefined);
  assert.equal(opRecordFromMessage({ op: "convertFieldUnits", variable: "p", density: 1, reference: "relative" }), undefined);
  const rec = opRecordFromMessage({ op: "convertFieldUnits", variable: "p", density: 1.2, reference: "absolute", output: "p_abs" })!;
  const back = parseOpsJson(serializeOps([rec], "test.mdpa"));
  assert.deepEqual(back.warnings, []);
  assert.deepEqual(back.operations, [rec]);
});

test("the record takes a density field xor a scalar density", () => {
  assert.equal(opRecordFromMessage({ op: "convertFieldUnits", variable: "p" }), undefined);
  assert.equal(
    opRecordFromMessage({ op: "convertFieldUnits", variable: "p", density: 1, densityField: "RHO" }),
    undefined
  );
  const rec = opRecordFromMessage({
    op: "convertFieldUnits",
    variable: "p",
    densityField: { variable: "RHO", kind: "Elemental" },
  })!;
  const back = parseOpsJson(serializeOps([rec], "test.mdpa"));
  assert.deepEqual(back.warnings, []);
  assert.deepEqual(back.operations, [rec]);
});

test("MCP: mesh_info reports dimensions, mesh_transform converts, mesh_compare refuses a mismatch", async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "ca"));
  fs.mkdirSync(path.join(dir, "cb"));
  const a = await writeCase(path.join(dir, "ca"), "a", "0 2 -2 0 0 0 0", 100);
  const info = (await meshInfo({ path: a })) as { fields: { variable: string; unit?: string; dimensions?: unknown }[] };
  const p = info.fields.find((f) => f.variable === "p")!;
  assert.equal(p.unit, "m²/s²");
  assert.ok(p.dimensions);
  assert.equal(info.fields.find((f) => f.variable === "T")!.unit, undefined);

  const out = path.join(dir, "converted.vtu");
  const t = (await meshTransform({
    path: a,
    outputPath: out,
    ops: [{ op: "convertFieldUnits", variable: "p", kind: "Elemental", density: 1.2, reference: "gauge" }],
  })) as { outcomes?: { message?: string; noop?: boolean }[] };
  assert.ok(!t.outcomes?.[0]?.noop, JSON.stringify(t));
  assert.match(t.outcomes?.[0]?.message ?? "", /"p_Pa" \[Pa\]/);

  // Converting a field with no recorded dimensions is a noop that says why.
  const none = (await meshTransform({
    path: a,
    outputPath: path.join(dir, "none.vtu"),
    ops: [{ op: "convertFieldUnits", variable: "T", kind: "Elemental", density: 1 }],
  })) as { outcomes?: { message?: string; noop?: boolean }[] };
  assert.equal(none.outcomes?.[0]?.noop, true);
  assert.match(none.outcomes?.[0]?.message ?? "", /no recorded dimensions/);

  const b = await writeCase(path.join(dir, "cb"), "b", "1 -1 -2 0 0 0 0", 120);
  const cmp = (await meshCompare({ pathA: a, pathB: b, variable: "p", kind: "Elemental" })) as { written: string[]; message?: string };
  assert.deepEqual(cmp.written, []);
  assert.match(cmp.message ?? "", /convertFieldUnits/);
});
