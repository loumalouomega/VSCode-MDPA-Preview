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
  constraintNodeIds,
  countConstraints,
  definedConstraintIds,
} from "../parser/constraintsParser";
import { cropModel } from "../parser/cropMesh";
import { extractSkinModel } from "../parser/extractSkin";
import { extractSubModelPart } from "../parser/subModelPartExtract";
import { mergeManyModels } from "../parser/mergeMesh";
import { mergeNodes } from "../parser/mergeNodes";
import { refineModel } from "../parser/refineMesh";
import { removeOrphanNodes } from "../parser/removeOrphanNodes";
import { renumberModel } from "../parser/renumberMesh";
import { translateCoords } from "../parser/transformCoords";
import { MdpaDiagnostic } from "../parser/types";

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

// ------------------------------------------------------------- maintenance

test("renumbering the nodes takes the constraints with it", () => {
  // What the deleted "keyed by NODE id" warning could only approximate.
  const model = parseMdpa(fixture(IO_READ));
  const r = renumberModel(model, { target: "nodes", start: 100 });

  const out = writeMdpa(r.model);
  const declared = new Set<number>(Array.from(r.model.nodeIds));
  for (const block of r.model.constraints ?? []) {
    for (const row of block.rows) {
      for (const id of constraintNodeIds(row)) {
        assert.ok(declared.has(id), `constraint names node ${id}, which the mesh no longer has`);
      }
    }
  }
  assert.match(out, /^Begin Constraints\b/m);

  const warnings: string[] = [];
  writeMdpa(r.model, { sourceText: fixture(IO_READ), onWarning: (m) => warnings.push(m) });
  assert.deepEqual(warnings, [], "and the save no longer has anything to warn about");
});

test("renumbering compacts the constraint id space and the lists that name it", () => {
  const model = parseMdpa(fixture(CUBE));
  const shifted = {
    ...model,
    constraints: model.constraints!.map((b) => ({
      ...b,
      rows: b.rows.map((row) => (row.kind === "raw" ? row : { ...row, id: row.id * 10 })),
    })),
    subModelParts: model.subModelParts.map(function bump(p): typeof p {
      return {
        ...p,
        constraintIds: Int32Array.from(Array.from(p.constraintIds, (id) => id * 10)),
        children: p.children.map(bump),
      };
    }),
  };

  const r = renumberModel(shifted, { target: "entities" });
  assert.equal(r.constraintsRenumbered, 40);
  assert.deepEqual(
    definedConstraintIds(r.model.constraints),
    [...Array(40)].map((_, i) => i + 1),
    "ids compact into a gapless run"
  );

  const listed = new Set<number>();
  const walk = (parts: typeof r.model.subModelParts): void => {
    for (const p of parts) {
      for (const id of p.constraintIds) listed.add(id);
      walk(p.children);
    }
  };
  walk(r.model.subModelParts);
  assert.ok(listed.size > 0, "the fixture lists constraint ids");
  for (const id of listed) assert.ok(id >= 1 && id <= 40, `list still names ${id}`);
});

test("a raw row stops the id space being renumbered around it", () => {
  const model = parseMdpa(fixture(CUBE));
  const withRaw = {
    ...model,
    constraints: model.constraints!.map((b, i) =>
      i === 0 ? { ...b, rows: [...b.rows, { kind: "raw" as const, text: "who knows" }] } : b
    ),
  };
  const r = renumberModel(withRaw, { target: "entities" });
  assert.equal(r.constraintsRenumbered, 0);
  assert.ok(r.diagnostics.some((d: MdpaDiagnostic) => /could not be parsed/.test(d.message)));
});

test("welding two constrained nodes together drops the self-reference", () => {
  const src = `Begin Nodes
1 0.0 0.0 0.0
2 0.0 0.0 0.0
3 1.0 0.0 0.0
End Nodes

Begin Elements Element2D3N
1 0 1 2 3
End Elements

Begin Constraints LinearMasterSlaveConstraint DISPLACEMENT_X
7 0.0 [1.0] 1 2
8 0.0 [1.0] 1 3
End Constraints

Begin SubModelPart Tied
  Begin SubModelPartConstraints
  7
  8
  End SubModelPartConstraints
End SubModelPart
`;
  const r = mergeNodes(parseMdpa(src), 1e-6);
  assert.equal(r.constraintsDropped, 1, "node 2 welds onto node 1, so constraint 7 ties 1 to 1");
  assert.deepEqual(definedConstraintIds(r.model.constraints), [8]);
  assert.deepEqual(Array.from(r.model.subModelParts[0].constraintIds), [8]);

  const warnings: string[] = [];
  writeMdpa(r.model, { onWarning: (m) => warnings.push(m) });
  assert.deepEqual(warnings, [], "so the written file names nothing it does not define");
});

test("a node only a constraint names is not treated as an orphan", () => {
  // The highest-risk site: before this, cleaning up would delete the referent.
  const src = `Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
4 5.0 5.0 5.0
End Nodes

Begin Elements Element2D3N
1 0 1 2 3
End Elements

Begin Constraints LinearMasterSlaveConstraint DISPLACEMENT_X
1 0.0 [1.0] 1 4
End Constraints
`;
  const r = removeOrphanNodes(parseMdpa(src));
  assert.equal(r.removed, 0);
  assert.ok(Array.from(r.model.nodeIds).includes(4));
});

test("cropping away a constrained node drops the constraint with it", () => {
  const src = `Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
4 9.0 9.0 0.0
5 10.0 9.0 0.0
6 9.0 10.0 0.0
End Nodes

Begin Elements Element2D3N
1 0 1 2 3
2 0 4 5 6
End Elements

Begin Constraints LinearMasterSlaveConstraint DISPLACEMENT_X
1 0.0 [1.0] 1 4
2 0.0 [1.0] 1 2
End Constraints
`;
  const r = cropModel(parseMdpa(src), {
    kind: "bbox",
    lo: [-1, -1, -1],
    hi: [2, 2, 1],
    mode: "all",
  });
  assert.equal(r.droppedConstraints, 1, "constraint 1 reaches the cropped-away corner");
  assert.deepEqual(definedConstraintIds(r.model.constraints), [2]);
  assert.ok(!Array.from(r.model.nodeIds).includes(4), "and the node is really gone");
});

test("merging offsets the constraint id space past the base's own definitions", () => {
  // The base defines constraints that no SubModelPart lists — the exact shape
  // that would collide if only the id LISTS were consulted.
  const base = parseMdpa(fixture(IO_READ));
  const other = parseMdpa(fixture(IO_READ));
  const r = mergeManyModels(base, [{ model: other, name: "Second" }], {});

  const ids = definedConstraintIds(r.model.constraints);
  assert.equal(ids.length, 4);
  assert.equal(new Set(ids).size, 4, "no id collides");

  const declared = new Set<number>(Array.from(r.model.nodeIds));
  for (const block of r.model.constraints ?? []) {
    for (const row of block.rows) {
      for (const id of constraintNodeIds(row)) assert.ok(declared.has(id));
    }
  }
  const wrapper = r.model.subModelParts.find((p) => p.path === "Second")!;
  assert.deepEqual(Array.from(wrapper.constraintIds), ids.slice(2));
});

test("extracting a SubModelPart no longer drags the whole file's constraints along", () => {
  // The shipped defect: exportSubModelPart passes the WHOLE source text to the
  // writer, so a verbatim Constraints block landed in a file holding a fraction
  // of its nodes.
  const src = fixture(CUBE);
  const model = parseMdpa(src);
  const part = model.subModelParts[0];
  const sub = extractSubModelPart(model, part.path)!;

  const warnings: string[] = [];
  const out = writeMdpa(sub, { sourceText: src, onWarning: (m) => warnings.push(m) });
  assert.deepEqual(warnings, []);

  const declared = new Set<number>(Array.from(sub.nodeIds));
  for (const block of sub.constraints ?? []) {
    for (const row of block.rows) {
      for (const id of constraintNodeIds(row)) assert.ok(declared.has(id));
    }
  }
  assert.ok(!/Begin Constraints[\s\S]*Begin Constraints/.test(out), "not every block came along");
});

test("a skin names no constraints at all", () => {
  const src = fixture(CUBE);
  const { model: skin } = extractSkinModel(parseMdpa(src));
  assert.equal(skin.constraints, undefined);

  const warnings: string[] = [];
  const out = writeMdpa(skin, { onWarning: (m) => warnings.push(m) });
  assert.deepEqual(warnings, [], "and lists none either");
  assert.ok(!out.includes("SubModelPartConstraints"));
});

test("operations that only add nodes or move them carry constraints untouched", () => {
  // The two shapes that are safe by construction: refine adds nodes and keeps
  // every existing id, and a transform moves coordinates without touching ids.
  const model = parseMdpa(fixture(IO_READ));
  for (const [label, next] of [
    ["refine", refineModel(model, 1).model],
    ["translate", translateCoords(model, 1, 2, 3)],
  ] as Array<[string, typeof model]>) {
    assert.deepEqual(next.constraints, model.constraints, label);
  }
});
