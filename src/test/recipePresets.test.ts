import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  findRecipePreset,
  parseRecipePreset,
  safePresetFileName,
  serializeRecipePreset,
} from "../parser/recipePresets";
import { discoverRecipePresets } from "../recipePresetLibrary";

const good = JSON.stringify({
  version: 1,
  name: "Smooth Half",
  description: "Taubin smooth, then halve the name",
  naming: "{stem}_{recipe}{ext}",
  outputExt: ".vtu",
  operations: [
    { op: "smooth", method: "taubin", iterations: 5 },
    { op: "bogusOp" },
  ],
});

test("a valid preset parses with its defaults and validated ops", () => {
  const { preset, warnings } = parseRecipePreset(good, "/lib/smooth.json");
  assert.equal(preset?.name, "Smooth Half");
  assert.equal(preset?.description, "Taubin smooth, then halve the name");
  assert.equal(preset?.naming, "{stem}_{recipe}{ext}");
  assert.equal(preset?.outputExt, ".vtu");
  assert.equal(preset?.ops.length, 1);
  assert.equal(preset?.ops[0].op, "smooth");
  assert.match(warnings.join("\n"), /Skipped unknown operation "bogusOp"/);
});

test("invalid batch defaults fall back with warnings", () => {
  const { preset, warnings } = parseRecipePreset(
    JSON.stringify({ name: "x", naming: "fixed.vtu", outputExt: "vtu", overwrite: "yes", operations: [] }),
    "x.json"
  );
  assert.equal(preset?.naming, undefined);
  assert.equal(preset?.outputExt, undefined);
  assert.equal(preset?.overwrite, undefined);
  assert.match(warnings.join("\n"), /"naming" must contain/);
  assert.match(warnings.join("\n"), /"outputExt" must start with a dot/);
  assert.match(warnings.join("\n"), /"overwrite" must be a boolean/);
});

test("a missing name falls back to the file stem", () => {
  const { preset, warnings } = parseRecipePreset(JSON.stringify({ operations: [] }), "/lib/my_stuff.json");
  assert.equal(preset?.name, "my_stuff");
  assert.match(warnings.join("\n"), /no usable "name"/);
});

test("malformed files never throw", () => {
  assert.equal(parseRecipePreset("nope", "b.json").preset, undefined);
  assert.equal(parseRecipePreset('[1,2]', "b.json").preset, undefined);
});

test("serialize round trip keeps name, defaults and ops", () => {
  const { preset } = parseRecipePreset(good);
  const again = parseRecipePreset(
    serializeRecipePreset({ name: preset!.name, description: preset!.description, naming: preset!.naming, ops: preset!.ops })
  );
  assert.equal(again.preset?.name, "Smooth Half");
  assert.equal(again.preset?.naming, "{stem}_{recipe}{ext}");
  assert.equal(again.preset?.ops.length, 1);
  assert.equal(safePresetFileName("Smooth Half!"), "Smooth_Half");
});

test("last match wins on duplicate names", () => {
  const a = parseRecipePreset(JSON.stringify({ name: "Dup", operations: [{ op: "scale", sx: 1, sy: 1, sz: 1 }] })).preset!;
  const b = parseRecipePreset(JSON.stringify({ name: "dup", operations: [{ op: "scale", sx: 2, sy: 2, sz: 2 }] })).preset!;
  assert.equal(findRecipePreset([a, b], "DUP"), b);
  assert.equal(findRecipePreset([a], "missing"), undefined);
});

test("discovery reads good files and reports broken ones", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "recipes-"));
  const lib = path.join(root, ".kratos", "recipes");
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, "smooth.json"), good);
  fs.writeFileSync(path.join(lib, "broken.json"), "{oops");
  fs.writeFileSync(path.join(lib, "empty.json"), JSON.stringify({ name: "Empty", operations: [{ op: "bogusOp" }] }));
  const found = discoverRecipePresets([root], [".kratos/recipes"]);
  assert.equal(found.presets.length, 1);
  assert.equal(found.presets[0].name, "Smooth Half");
  assert.equal(found.problems.length, 2);
  assert.match(found.problems.map((p) => p.message).join("\n"), /not valid JSON/);
  fs.rmSync(root, { recursive: true, force: true });
});
