/**
 * `Begin Constraints` end to end: parsed into real entities, emitted from the
 * model, and maintained by every operation that relabels or removes nodes.
 *
 * This file used to pin the *stopgap* — constraints kept only as a `MetaBlock`
 * label + line count and copied through a Save as verbatim source text, with
 * the two ways that node-id keying could go stale merely reported. Those two
 * warnings are gone because the thing they warned about no longer happens; what
 * remains from that era, and is still exactly the contract, is that the blocks
 * survive a save, that they are written AFTER the nodes (Kratos'
 * `ReadConstraintsBlock` resolves master/slave ids against nodes it has already
 * read), and that a file never names constraints it does not contain.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { parseMdpa } from "../parser/mdpaParser";
import { writeMdpa } from "../parser/writers/mdpaWriter";
import {
  LinearConstraint,
  countConstraints,
  definedConstraintIds,
} from "../parser/constraintsParser";

const FIXTURE_ROOT = path.resolve(__dirname, "../../src/test/fixtures");

function fixture(rel: string): string {
  return fs.readFileSync(path.join(FIXTURE_ROOT, rel), "utf8");
}

const IO_READ = "kratos/tests/auxiliar_files_for_python_unittest/mdpa_files/test_model_part_io_read.mdpa";
const CUBE = "applications/MetisApplication/tests/cube.mdpa";

// ----------------------------------------------------------------- parsing

test("the rows of a Constraints block become real entities", () => {
  const model = parseMdpa(fixture(IO_READ));
  assert.equal(model.constraints?.length, 2, "one ConstraintBlock per SOURCE block");

  const [first, second] = model.constraints!;
  assert.equal(first.name, "LinearMasterSlaveConstraint");
  assert.deepEqual(first.variables, ["DISPLACEMENT_X"]);

  const a = first.rows[0] as LinearConstraint;
  assert.deepEqual(
    { id: a.id, constant: a.constant, weights: a.weights, slaveIds: a.slaveIds, masterIds: a.masterIds },
    { id: 1, constant: 0, weights: [0.5], slaveIds: [1], masterIds: [2] }
  );

  const b = second.rows[0] as LinearConstraint;
  assert.deepEqual(b.weights, [0.25, 0.25]);
  assert.deepEqual(b.masterIds, [3, 972]);
});

test("a tab-separated, CRLF block with two header variables parses too", () => {
  const model = parseMdpa(fixture(CUBE));
  assert.equal(model.constraints?.length, 1);
  const block = model.constraints![0];
  assert.deepEqual(block.variables, ["TEMPERATURE", "TEMPERATURE"]);
  assert.deepEqual(countConstraints(model.constraints), { linear: 40, raw: 0 });
  assert.deepEqual(definedConstraintIds(model.constraints), [...Array(40)].map((_, i) => i + 1));
  assert.deepEqual((block.rows[0] as LinearConstraint).masterIds, [80]);
});

test("the MetaBlock line counts are untouched by the addition", () => {
  // Purely additive, exactly as the Properties value parser was: the writer's
  // verbatim copy-out and mergeMesh's reporting both read these numbers.
  const model = parseMdpa(fixture(IO_READ));
  const labels = model.meta.filter((m) => m.label.startsWith("Constraints"));
  assert.equal(labels.length, 2);
  assert.deepEqual(labels.map((m) => m.lineCount), [1, 1]);
});

test("a mesh with no Constraints block carries no slot at all", () => {
  const model = parseMdpa("Begin Nodes\n1 0 0 0\nEnd Nodes\n");
  assert.equal(model.constraints, undefined);
});

// ----------------------------------------------------------------- writing

test("Constraints blocks survive a same-format save", () => {
  const src = fixture(IO_READ);
  const before = (src.match(/^Begin Constraints\b/gm) ?? []).length;
  assert.ok(before > 0, "fixture must actually declare constraints");

  const out = writeMdpa(parseMdpa(src), { sourceText: src });
  assert.equal((out.match(/^Begin Constraints\b/gm) ?? []).length, before);

  // Not just the header — the body has to come with it. Rows are now emitted
  // rather than copied, and are indented like every other row this writer
  // produces, so the anchor allows the leading whitespace.
  assert.match(out, /^Begin Constraints LinearMasterSlaveConstraint DISPLACEMENT_X$/m);
  assert.match(out, /^\s*1 0\.0 \[0\.5\] 1 2$/m);
  assert.match(out, /^\s*2 0\.0 \[0\.25, 0\.25\] 1 3 972$/m);
});

test("constraints are written from the MODEL, with no source text at hand", () => {
  // Impossible under the verbatim stopgap, and the reason Save As and every
  // Export path now keep them.
  const out = writeMdpa(parseMdpa(fixture(IO_READ)));
  assert.match(out, /^Begin Constraints LinearMasterSlaveConstraint DISPLACEMENT_X$/m);
  assert.match(out, /^\s*2 0\.0 \[0\.25, 0\.25\] 1 3 972$/m);
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
  assert.ok(
    firstConstraint < out.indexOf("Begin SubModelPart"),
    "and precede the SubModelParts that name their ids"
  );
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

test("a written file re-parses to the same constraints it was written from", () => {
  for (const rel of [IO_READ, CUBE]) {
    const src = fixture(rel);
    const model = parseMdpa(src);
    const round = parseMdpa(writeMdpa(model, { sourceText: src }));
    assert.deepEqual(round.constraints, model.constraints, rel);
  }
});

// ---------------------------------------------------------------- warnings

test("no warning for an ordinary save", () => {
  const src = fixture(IO_READ);
  const warnings: string[] = [];
  writeMdpa(parseMdpa(src), { sourceText: src, onWarning: (m) => warnings.push(m) });
  assert.deepEqual(warnings, []);
});

test("constraints an operation dropped are named, not copied back in", () => {
  // The one thing the source knows that the model does not. Copying the text
  // would key it to node ids the operation has just replaced.
  const src = fixture(IO_READ);
  const stripped = { ...parseMdpa(src), constraints: undefined };
  const warnings: string[] = [];
  const out = writeMdpa(stripped, { sourceText: src, onWarning: (m) => warnings.push(m) });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /2 Constraints block\(s\)/);
  assert.match(warnings[0], /an operation dropped them/);
  assert.ok(!out.includes("Begin Constraints"), "and they are omitted rather than copied");
});

test("a SubModelPart naming a constraint the file does not define is reported", () => {
  // The original defect class, now detectable with no source text at all.
  const model = parseMdpa(fixture(IO_READ));
  const warnings: string[] = [];
  writeMdpa(
    {
      ...model,
      subModelParts: [
        {
          name: "Tied",
          nodeIds: new Int32Array(0),
          elementIds: new Int32Array(0),
          conditionIds: new Int32Array(0),
          geometryIds: new Int32Array(0),
          constraintIds: Int32Array.from([1, 99]),
          path: "Tied",
          children: [],
        },
      ],
    },
    { onWarning: (m) => warnings.push(m) }
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /1 SubModelPart constraint id\(s\)/);
  assert.match(warnings[0], /99/);
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
  // The constraints step must not perturb the byte output of the common case.
  assert.equal(withHook, writeMdpa(model, { sourceText: src }));
});
