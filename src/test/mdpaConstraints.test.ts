/**
 * `Begin Constraints` round-trip.
 *
 * Kratos master/slave constraints are parsed only as a `MetaBlock` label + line
 * count, so the source text is the only place their contents survive a Save.
 * Before the trailing-verbatim group existed they were dropped outright while
 * the `SubModelPartConstraints` id lists referencing them were still written —
 * a file that names constraints it no longer contains.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { parseMdpa } from "../parser/mdpaParser";
import { writeMdpa } from "../parser/writers/mdpaWriter";
import { renumberModel } from "../parser/renumberMesh";

const FIXTURE_ROOT = path.resolve(__dirname, "../../src/test/fixtures");

function fixture(rel: string): string {
  return fs.readFileSync(path.join(FIXTURE_ROOT, rel), "utf8");
}

const IO_READ = "kratos/tests/auxiliar_files_for_python_unittest/mdpa_files/test_model_part_io_read.mdpa";
const CUBE = "applications/MetisApplication/tests/cube.mdpa";

test("Constraints blocks survive a same-format save", () => {
  const src = fixture(IO_READ);
  const before = (src.match(/^Begin Constraints\b/gm) ?? []).length;
  assert.ok(before > 0, "fixture must actually declare constraints");

  const out = writeMdpa(parseMdpa(src), { sourceText: src });
  assert.equal((out.match(/^Begin Constraints\b/gm) ?? []).length, before);

  // Not just the header — the body has to come with it.
  assert.match(out, /^Begin Constraints LinearMasterSlaveConstraint DISPLACEMENT_X$/m);
  assert.match(out, /^1 0\.0 \[0\.5\] 1 2$/m);
  assert.match(out, /^2 0\.0 \[0\.25, 0\.25\] 1 3 972$/m);
});

test("Constraints are written AFTER the nodes and the entity blocks", () => {
  // Kratos' ReadConstraintsBlock resolves master/slave ids against nodes it has
  // already read, so a leading position would produce an unreadable file.
  const src = fixture(IO_READ);
  const out = writeMdpa(parseMdpa(src), { sourceText: src });

  const endNodes = out.indexOf("End Nodes");
  const firstConstraint = out.indexOf("Begin Constraints");
  assert.ok(endNodes >= 0 && firstConstraint >= 0);
  assert.ok(firstConstraint > endNodes, "Constraints must follow End Nodes");

  const lastEntityEnd = Math.max(out.lastIndexOf("End Elements"), out.lastIndexOf("End Conditions"));
  assert.ok(firstConstraint > lastEntityEnd, "Constraints must follow the entity blocks");
});

test("the written file no longer names constraints it does not contain", () => {
  const src = fixture(CUBE);
  assert.match(src, /Begin SubModelPartConstraints/);

  const out = writeMdpa(parseMdpa(src), { sourceText: src });
  const declares = /Begin SubModelPartConstraints\s*\n\s*\d/.test(out);
  assert.ok(declares, "fixture's SubModelPartConstraints lists should still be written");
  assert.ok(
    (out.match(/^Begin Constraints\b/gm) ?? []).length > 0,
    "so the Constraints blocks defining them must be present too"
  );
});

test("re-parsing the output finds the Constraints blocks again", () => {
  const src = fixture(IO_READ);
  const out = writeMdpa(parseMdpa(src), { sourceText: src });
  const reparsed = parseMdpa(out);
  const labels = reparsed.meta.filter((m) => m.label.startsWith("Constraints"));
  assert.equal(labels.length, (src.match(/^Begin Constraints\b/gm) ?? []).length);
});

test("no warning when the node ids are untouched", () => {
  const src = fixture(IO_READ);
  const warnings: string[] = [];
  writeMdpa(parseMdpa(src), { sourceText: src, onWarning: (m) => warnings.push(m) });
  assert.deepEqual(warnings, []);
});

test("warns when renumbering has taken the node ids the verbatim text names", () => {
  const src = fixture(IO_READ);
  const renumbered = renumberModel(parseMdpa(src), { target: "nodes", start: 100 }).model;

  const warnings: string[] = [];
  const out = writeMdpa(renumbered, { sourceText: src, onWarning: (m) => warnings.push(m) });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Constraints block/);
  assert.match(warnings[0], /no longer in the mesh/);
  // Advisory only: the constraints are still written, because a file that keeps
  // them is strictly better than the one that silently dropped them.
  assert.match(out, /^Begin Constraints\b/m);
});

test("adding nodes is not reported — every id a constraint names is still there", () => {
  const src = fixture(IO_READ);
  const model = parseMdpa(src);
  const coords = new Float32Array(model.coords.length + 3);
  coords.set(model.coords);
  const grown = {
    ...model,
    nodeCount: model.nodeCount + 1,
    nodeIds: Int32Array.from([...Array.from(model.nodeIds), 10_000]),
    coords,
  };
  const warnings: string[] = [];
  writeMdpa(grown, { sourceText: src, onWarning: (m) => warnings.push(m) });
  assert.deepEqual(warnings, []);
});

test("renumberModel reports the constraints its node renumbering invalidates", () => {
  // The writer's id-SET test cannot see a pure permutation (reorder then
  // renumber keeps {1..N}), so the operation that knows it renumbered says so.
  const src = fixture(IO_READ);
  const res = renumberModel(parseMdpa(src), { target: "nodes", start: 100 });
  const hit = res.diagnostics.find((d) => /Constraints blocks/.test(d.message));
  assert.ok(
    hit,
    `expected a constraints warning, got ${res.diagnostics.map((d) => d.message)}`
  );
  assert.match(hit.message, /keyed by NODE id/);
});

test("a source with no constraints is unaffected", () => {
  const src = `Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
End Nodes

Begin Elements Element2D3N
1 0 1 2 3
End Elements
`;
  const model = parseMdpa(src);
  const warnings: string[] = [];
  const withHook = writeMdpa(model, { sourceText: src, onWarning: (m) => warnings.push(m) });

  assert.deepEqual(warnings, []);
  assert.ok(!withHook.includes("Begin Constraints"));
  // The trailing group must not perturb the byte output of the common case.
  assert.equal(withHook, writeMdpa(model, { sourceText: src }));
});
