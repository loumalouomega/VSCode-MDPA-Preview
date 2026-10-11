import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  BUILTIN_PRESETS,
  MaterialPreset,
  canonicalUnit,
  convertQuantity,
  describeReference,
  findPreset,
  parsePresetFile,
  presetDrift,
  presetsForLaw,
  quantityOf,
  resolvePresetValues,
  serializePresetFile,
  snapshotOf,
  unitOfField,
  validateMaterialAssignment,
} from "../problemtype/materialCatalog";
import {
  discoverMaterialLibrary,
  importPresetFile,
  writePresetFile,
} from "../problemtype/materialLibrary";
import { fluid } from "../problemtype/builtins/fluid";
import { structural } from "../problemtype/builtins/structural";
import type { MaterialLawSpec } from "../problemtype/types";

const newtonian = (): MaterialLawSpec =>
  fluid.decl.materialLaws.find((l) => l.id === "newtonian_3d")!;
const elastic = (): MaterialLawSpec =>
  structural.decl.materialLaws.find((l) => l.id === "linear_elastic_3d")!;
const water = (): MaterialPreset =>
  BUILTIN_PRESETS.find((p) => p.id === "water-liquid-20c")!;

const user = (over: Partial<MaterialPreset> = {}): MaterialPreset => ({
  id: "mine",
  name: "My fluid",
  laws: ["newtonian_3d"],
  values: { DENSITY: 2, DYNAMIC_VISCOSITY: 3 },
  units: { DENSITY: "kg/m³", DYNAMIC_VISCOSITY: "Pa·s" },
  source: { name: "measured in-house" },
  origin: "user",
  ...over,
});

// --- units --------------------------------------------------------------------

test("a unit resolves to a quantity and converts in both directions", () => {
  assert.equal(quantityOf("kg/m³"), "density");
  assert.equal(quantityOf("Pa·s"), "dynamicViscosity");
  assert.equal(quantityOf("m²/s"), "kinematicViscosity");
  assert.equal(quantityOf("GPa"), "stress");
  assert.equal(quantityOf("furlongs per fortnight"), undefined);
  assert.equal(canonicalUnit("stress"), "Pa");

  const up = convertQuantity(1, "cP", "Pa·s");
  assert.equal(up.ok, true);
  if (up.ok) assert.equal(up.value, 1e-3);
  const down = convertQuantity(1e-3, "Pa·s", "mPa·s");
  assert.equal(down.ok, true);
  if (down.ok) assert.equal(down.value, 1);
  const gcm3 = convertQuantity(1, "g/cm³", "kg/m³");
  assert.equal(gcm3.ok, true);
  if (gcm3.ok) assert.equal(gcm3.value, 1000);
});

test("a conversion that cannot mean anything is refused with a reason", () => {
  const crossed = convertQuantity(1, "kg/m³", "Pa·s");
  assert.equal(crossed.ok, false);
  if (!crossed.ok) assert.match(crossed.reason, /wants "Pa·s"/);

  // An unknown unit on either side is not a licence to pass the number through.
  const undeclaredTarget = convertQuantity(1, "kg/m³", undefined);
  assert.equal(undeclaredTarget.ok, false);
  const undeclaredSource = convertQuantity(1, undefined, "kg/m³");
  assert.equal(undeclaredSource.ok, false);
  // ...but two absent units are an exact match, not a failure.
  const bothUnknown = convertQuantity(7, undefined, undefined);
  assert.equal(bothUnknown.ok, true);
  if (bothUnknown.ok) assert.equal(bothUnknown.value, 7);

  const nonsense = convertQuantity(Number.NaN, "kg/m³", "kg/m³");
  assert.equal(nonsense.ok, false);
});

test("a field's unit comes from the declaration, then the label, then the known id", () => {
  assert.equal(unitOfField({ id: "DENSITY", label: "ρ", type: "number", unit: "g/cm³" }), "g/cm³");
  assert.equal(unitOfField({ id: "ANYTHING", label: "Young modulus [GPa]", type: "number" }), "GPa");
  assert.equal(unitOfField({ id: "YOUNG_MODULUS", label: "stiffness", type: "number" }), "Pa");
  assert.equal(unitOfField({ id: "SOMETHING_ELSE", label: "coefficient", type: "number" }), undefined);
});

// --- resolution ---------------------------------------------------------------

test("μ = ρ·ν happens exactly once, whatever the row already held", () => {
  const law = newtonian();
  const first = resolvePresetValues(law, water(), { DENSITY: 1, DYNAMIC_VISCOSITY: 42 });
  const expected = 998.2 * 1.004e-6;
  assert.equal(first.values.DENSITY, 998.2);
  assert.equal(first.values.DYNAMIC_VISCOSITY, expected);
  assert.deepEqual(first.derived.map((d) => d.variable), ["DYNAMIC_VISCOSITY"]);
  assert.match(first.derived[0].formula, /DENSITY \* KINEMATIC_VISCOSITY/);

  // Applying the same preset to its own result is the same row, not ρ·ν again.
  const second = resolvePresetValues(law, water(), first.values as Record<string, number>);
  assert.deepEqual(second.values, first.values);
  assert.equal(second.values.DYNAMIC_VISCOSITY, expected);
  // ...and it lands on the published figure for water at 20 °C, to 4 digits.
  assert.ok(Math.abs(Number(second.values.DYNAMIC_VISCOSITY) / 1.002e-3 - 1) < 1e-3);
});

test("a directly quoted viscosity wins over the derived one", () => {
  const both = user({
    values: { DENSITY: 1000, KINEMATIC_VISCOSITY: 1.5e-6, DYNAMIC_VISCOSITY: 0.004 },
    units: { DENSITY: "kg/m³", KINEMATIC_VISCOSITY: "m²/s", DYNAMIC_VISCOSITY: "Pa·s" },
  });
  const applied = resolvePresetValues(newtonian(), both, {});
  assert.equal(applied.values.DYNAMIC_VISCOSITY, 0.004);
  assert.deepEqual(applied.derived, []);
});

test("a preset in cP and g/cm³ lands in the law's SI units", () => {
  const metric = user({
    values: { DENSITY: 0.9982, DYNAMIC_VISCOSITY: 1.002 },
    units: { DENSITY: "g/cm³", DYNAMIC_VISCOSITY: "cP" },
  });
  const applied = resolvePresetValues(newtonian(), metric, {});
  const close = (a: unknown, b: number) => assert.ok(Math.abs(Number(a) / b - 1) < 1e-12, `${a} is not ${b}`);
  close(applied.values.DENSITY, 998.2);
  close(applied.values.DYNAMIC_VISCOSITY, 1.002e-3);
  assert.deepEqual(
    applied.conversions.map((c) => `${c.variable} ${c.from}->${c.to}`).sort(),
    ["DENSITY g/cm³->kg/m³", "DYNAMIC_VISCOSITY cP->Pa·s"]
  );
});

test("kinematic-only viscosity needs a density, and says so when there is none", () => {
  const law = newtonian();
  const kinematicOnly = user({
    values: { KINEMATIC_VISCOSITY: 1e-6 },
    units: { KINEMATIC_VISCOSITY: "m²/s" },
  });
  const withoutDensity = resolvePresetValues(law, kinematicOnly, {});
  assert.match(withoutDensity.problems.join(" "), /needs a density/);
  assert.equal(withoutDensity.values.DYNAMIC_VISCOSITY, undefined);

  // The row's own density is a legitimate ρ, and it is used once.
  const withDensity = resolvePresetValues(law, kinematicOnly, { DENSITY: 1000 });
  assert.equal(withDensity.values.DYNAMIC_VISCOSITY, 1e-3);
  assert.equal(withDensity.problems.length, 0);
});

test("the other direction is derived too: ν = μ/ρ", () => {
  const law: MaterialLawSpec = {
    id: "kinematic_only",
    name: "KinematicOnly",
    variables: [{ id: "KINEMATIC_VISCOSITY", label: "Kinematic viscosity [m²/s]", type: "number", unit: "m²/s" }],
  };
  // A preset quoting μ and ρ fills a law that asks for ν, by division.
  const fromDynamic = user({ laws: ["kinematic_only"], values: { DENSITY: 1000, DYNAMIC_VISCOSITY: 0.001 } });
  const applied = resolvePresetValues(law, fromDynamic, {});
  assert.ok(Math.abs(Number(applied.values.KINEMATIC_VISCOSITY) / 1e-6 - 1) < 1e-9);
  assert.match(applied.derived[0].formula, /DYNAMIC_VISCOSITY \/ DENSITY/);

  // A preset that quotes ν directly is used as-is, with no derivation.
  const direct = resolvePresetValues(law, { ...water(), laws: ["kinematic_only"] }, {});
  assert.equal(direct.values.KINEMATIC_VISCOSITY, 1.004e-6);
  assert.deepEqual(direct.derived, []);
});

test("a preset that does not fit the law is refused whole, not partly applied", () => {
  const applied = resolvePresetValues(elastic(), water(), {});
  assert.equal(applied.values.DENSITY, undefined, "even the variable the two laws share");
  assert.match(applied.problems.join(" "), /does not declare compatibility/);
  assert.equal(presetsForLaw([water()], "linear_elastic_3d").length, 0);
  assert.equal(presetsForLaw([water()], "newtonian_3d").length, 1);
});

test("a value in a unit the variable cannot take is reported, not coerced", () => {
  const wrong = user({
    values: { DENSITY: 7 },
    units: { DENSITY: "m" },
  });
  const applied = resolvePresetValues(newtonian(), wrong, {});
  assert.equal(applied.values.DENSITY, undefined);
  assert.match(applied.problems.join(" "), /wants "kg\/m³"/);
});

test("values the preset does not carry keep whatever the row had", () => {
  const onlyDensity = user({ values: { DENSITY: 900 }, units: { DENSITY: "kg/m³" } });
  const applied = resolvePresetValues(newtonian(), onlyDensity, { DYNAMIC_VISCOSITY: 0.005 });
  assert.equal(applied.values.DENSITY, 900);
  assert.equal(applied.values.DYNAMIC_VISCOSITY, 0.005);
});

// --- validation ---------------------------------------------------------------

test("validation refuses the numbers that cannot mean anything", () => {
  const law = newtonian();
  assert.equal(validateMaterialAssignment(law, { DENSITY: 1000, DYNAMIC_VISCOSITY: 1e-3 }).length, 0);

  const zeroDensity = validateMaterialAssignment(law, { DENSITY: 0, DYNAMIC_VISCOSITY: 1e-3 });
  assert.equal(zeroDensity.length, 1);
  assert.equal(zeroDensity[0].severity, "error");
  assert.equal(zeroDensity[0].variable, "DENSITY");

  const negativeViscosity = validateMaterialAssignment(law, { DENSITY: 1000, DYNAMIC_VISCOSITY: -1e-3 });
  assert.equal(negativeViscosity[0].variable, "DYNAMIC_VISCOSITY");

  const notANumber = validateMaterialAssignment(law, { DENSITY: "1000" as never });
  assert.match(notANumber[0].message, /not a finite number/);

  // A stiffness-modulus law refuses a non-positive Young modulus, and a
  // dimensionless ratio is not caught by the positivity rule.
  assert.equal(validateMaterialAssignment(elastic(), { DENSITY: 7850, YOUNG_MODULUS: 0, POISSON_RATIO: 0.3 })[0].variable, "YOUNG_MODULUS");
  assert.equal(validateMaterialAssignment(elastic(), { DENSITY: 7850, YOUNG_MODULUS: 2.1e11, POISSON_RATIO: 0 }).length, 0);
  const sillyPoisson = validateMaterialAssignment(elastic(), { DENSITY: 7850, YOUNG_MODULUS: 2.1e11, POISSON_RATIO: 0.9 });
  assert.equal(sillyPoisson[0].severity, "warning");
});

test("a preset that does not fit the law is a validation error", () => {
  const issues = validateMaterialAssignment(elastic(), { DENSITY: 7850, YOUNG_MODULUS: 2.1e11 }, snapshotOf(water(), {}));
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "error");
});

// --- snapshots and drift ------------------------------------------------------

test("a snapshot copies the resolved values, so the library cannot reach back into a case", () => {
  const resolved = resolvePresetValues(newtonian(), water(), {});
  const snapshot = snapshotOf(water(), resolved.values);
  const editedLibrary = { ...water(), values: { DENSITY: 1000, KINEMATIC_VISCOSITY: 1e-6 } };
  assert.equal(snapshot.values.DENSITY, 998.2);
  assert.equal(editedLibrary.values.DENSITY, 1000);
  assert.equal(snapshot.source.name, water().source.name);
  assert.equal(snapshot.reference?.temperature, 20);
  // A later resolution never writes into the snapshot.
  resolvePresetValues(newtonian(), editedLibrary, {});
  assert.equal(snapshot.values.DENSITY, 998.2);
});

test("drift is reported when the library moved, and only then", () => {
  const law = newtonian();
  const resolved = resolvePresetValues(law, water(), {});
  const snapshot = snapshotOf(water(), resolved.values);
  assert.equal(presetDrift(snapshot, water(), law), undefined);

  const changed = { ...water(), values: { DENSITY: 998.2, KINEMATIC_VISCOSITY: 1.31e-6 }, version: "2" };
  const drift = presetDrift(snapshot, changed, law);
  assert.ok(drift);
  assert.deepEqual(drift.variables, ["DYNAMIC_VISCOSITY"]);
  assert.equal(drift.values.DYNAMIC_VISCOSITY, 998.2 * 1.31e-6);
});

test("a workspace file that reuses a shipped id wins when applied, and both stay listed", () => {
  const override = { ...water(), values: { DENSITY: 1000, KINEMATIC_VISCOSITY: 1e-6 }, file: "water.json" };
  const catalog = [water(), override];
  // Listed twice, so the override is visible rather than silent...
  assert.equal(presetsForLaw(catalog, "newtonian_3d").length, 2);
  // ...but an application resolves to the workspace file.
  assert.equal(findPreset(catalog, "water-liquid-20c"), override);
  assert.equal(resolvePresetValues(newtonian(), findPreset(catalog, "water-liquid-20c")!, {}).values.DENSITY, 1000);
  // A rejected entry never answers a lookup.
  assert.equal(findPreset([{ ...water(), error: "bad" }], "water-liquid-20c"), undefined);
});

test("every shipped preset carries a citation, a reference state and a law", () => {
  assert.ok(BUILTIN_PRESETS.length >= 50);
  for (const preset of BUILTIN_PRESETS) {
    assert.match(preset.source.name, /\S/, `${preset.id} has no source`);
    assert.ok(preset.laws.length > 0, `${preset.id} fits no law`);
    assert.equal(preset.origin, "builtin");
    // A roughness coefficient has no temperature; it states the surface instead.
    assert.ok(
      preset.reference?.temperature !== undefined || preset.reference?.note,
      `${preset.id} has no reference state`
    );
    assert.ok(describeReference(preset.reference));
    for (const [id, value] of Object.entries(preset.values)) {
      assert.equal(typeof value, "number", `${preset.id}.${id}`);
      assert.equal(validateMaterialAssignment(newtonian(), { [id]: value }).length, 0, `${preset.id}.${id} is not a usable value`);
    }
  }
});

test("shipped ids are unique and every row applies cleanly to every law it names", async () => {
  const { structural: st } = { structural };
  const { convectionDiffusion } = await import("../problemtype/builtins/convectionDiffusion");
  const { shallowWater } = await import("../problemtype/builtins/shallowWater");
  const laws = [
    ...fluid.decl.materialLaws,
    ...st.decl.materialLaws,
    ...convectionDiffusion.decl.materialLaws,
    ...shallowWater.decl.materialLaws,
  ];
  const ids = BUILTIN_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate shipped preset id");
  for (const preset of BUILTIN_PRESETS) {
    for (const lawId of preset.laws) {
      const law = laws.find((l) => l.id === lawId);
      assert.ok(law, `${preset.id} names unknown law ${lawId}`);
      const applied = resolvePresetValues(law, preset, {});
      assert.deepEqual(applied.problems, [], `${preset.id} on ${lawId}`);
      assert.deepEqual(validateMaterialAssignment(law, applied.values, preset), [], `${preset.id} on ${lawId}`);
      // Every variable the law declares must be filled from the row (THICKNESS is
      // the model's, not the material's, and keeps whatever the row holds).
      for (const variable of law.variables) {
        if (variable.id === "THICKNESS") continue;
        assert.equal(typeof applied.values[variable.id], "number", `${preset.id} leaves ${variable.id} unset on ${lawId}`);
      }
    }
  }
  // Each law family has rows to pick from.
  for (const lawId of ["newtonian_3d", "linear_elastic_3d", "linear_elastic_plane_stress", "linear_elastic_plane_strain", "thermal", "manning"]) {
    assert.ok(presetsForLaw(BUILTIN_PRESETS, lawId).length >= 5, `few rows for ${lawId}`);
  }
});

test("a structural preset quoted in GPa lands in Pa and keeps the thickness alone", () => {
  const steel = BUILTIN_PRESETS.find((p) => p.id === "steel-structural-en1993")!;
  const out = resolvePresetValues(elastic(), steel, {});
  assert.equal(out.values.DENSITY, 7850);
  assert.equal(out.values.YOUNG_MODULUS, 210e9);
  assert.equal(out.values.POISSON_RATIO, 0.3);
  assert.equal(out.conversions.length, 1);
  assert.deepEqual(out.derived, []);

  const plane = structural.decl.materialLaws.find((l) => l.id === "linear_elastic_plane_stress")!;
  const kept = resolvePresetValues(plane, steel, { THICKNESS: 0.02 });
  assert.equal(kept.values.THICKNESS, 0.02);
  // A fluid law refuses a structural row instead of half filling it.
  assert.match(resolvePresetValues(newtonian(), steel, {}).problems[0], /does not declare compatibility/);
});

test("fluid rows quoting dynamic viscosity are used as given, not re-derived", () => {
  const glycerol = BUILTIN_PRESETS.find((p) => p.id === "glycerol-20c")!;
  const out = resolvePresetValues(newtonian(), glycerol, {});
  assert.equal(out.values.DYNAMIC_VISCOSITY, 1.41);
  assert.deepEqual(out.derived, []);
});

// --- library files ------------------------------------------------------------

test("a preset round-trips through the on-disk form", () => {
  const text = serializePresetFile([user(), water()]);
  const read = parsePresetFile(text, "library.json");
  assert.deepEqual(read.warnings, []);
  assert.equal(read.presets.length, 2);
  assert.equal(read.presets[0].id, "mine");
  assert.deepEqual(read.presets[0].values, { DENSITY: 2, DYNAMIC_VISCOSITY: 3 });
  assert.equal(read.presets[0].file, "library.json");
  assert.equal(read.presets[0].origin, "user");
  // Re-serializing what was read is the same document.
  assert.equal(serializePresetFile(read.presets), text);
});

test("a bad row is reported and the rest of the file still loads", () => {
  const text = JSON.stringify({
    version: 1,
    presets: [
      { id: "no-source", name: "x", values: { DENSITY: 1 } },
      { id: "not-a-number", name: "x", values: { DENSITY: "heavy" }, source: { name: "s" } },
      { id: "ok", name: "x", values: { DENSITY: 1 }, source: { name: "s" } },
    ],
  });
  const read = parsePresetFile(text, "library.json");
  assert.equal(read.presets.length, 1);
  assert.equal(read.presets[0].id, "ok");
  assert.match(read.warnings.join(" "), /no source\.name/);
  assert.match(read.warnings.join(" "), /not a finite number/);

  assert.match(parsePresetFile("{", "broken.json").warnings.join(" "), /not valid JSON/);
  assert.match(parsePresetFile('{"presets":[]}', "empty.json").warnings.join(" "), /no presets/);
});

test("the library is discovered from the configured directories, problems included", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kratos-materials-"));
  try {
    fs.mkdirSync(path.join(root, ".kratos", "materials"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".kratos", "materials", "mine.json"),
      serializePresetFile([user()])
    );
    fs.writeFileSync(path.join(root, ".kratos", "materials", "broken.json"), "{");
    const library = discoverMaterialLibrary([root], [".kratos/materials"]);
    assert.equal(library.presets.length, 1);
    assert.equal(library.presets[0].id, "mine");
    assert.equal(library.problems.length, 1);
    assert.match(library.problems[0].message, /not valid JSON/);

    // A directory that is not there is not a failure.
    assert.deepEqual(discoverMaterialLibrary([root], [".kratos/nope"]), { presets: [], problems: [] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("importing copies a preset into the library and refuses to clobber a different file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kratos-materials-"));
  try {
    const outside = path.join(root, "water.json");
    fs.writeFileSync(outside, serializePresetFile([water()]));
    const extra = [".kratos/materials"];
    const imported = importPresetFile(outside, [root], extra);
    assert.equal(imported.presets.length, 1);
    assert.equal(path.basename(imported.written), "water-liquid-20c.json");
    assert.ok(fs.existsSync(imported.written));
    // Re-importing the identical file is a no-op, not an error.
    assert.equal(importPresetFile(outside, [root], extra).written, imported.written);

    // A different file that claims the same id is the collision worth refusing.
    fs.writeFileSync(outside, serializePresetFile([{ ...water(), values: { DENSITY: 1, KINEMATIC_VISCOSITY: 1e-6 } }]));
    assert.throws(() => importPresetFile(outside, [root], extra), /already exists/);
    assert.throws(() => importPresetFile(path.join(root, "missing.json"), [root], extra), /ENOENT/);

    const library = discoverMaterialLibrary([root], extra);
    assert.deepEqual(library.presets.map((p) => p.id), ["water-liquid-20c"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("exporting refuses to overwrite unless told to", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kratos-materials-"));
  try {
    const file = path.join(root, "export.json");
    writePresetFile(file, [water()]);
    assert.throws(() => writePresetFile(file, [water()]), /already exists/);
    assert.doesNotThrow(() => writePresetFile(file, [water()], true));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
