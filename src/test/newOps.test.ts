/**
 * Registration plumbing for the six native ops added alongside the meshio++
 * oracles: linearize, refine, simplexify, crop, fieldCalc, averageField.
 * The transforms themselves are tested in their own files; this pins that
 * each is reachable through applyOp / opRecordFromMessage / recipe JSON —
 * the checklist CLAUDE.md calls out as easy to half-finish.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyOp,
  isAsyncOp,
  opRecordFromMessage,
  parseOpsJson,
  serializeOps,
  OP_LABELS,
  OpRecord,
} from "../parser/operations";
import { parseMdpa } from "../parser/mdpaParser";

const TET_SRC = `Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
4 0.0 0.0 1.0
End Nodes

Begin Elements Element3D4N
1 0 1 2 3 4
End Elements

Begin NodalData T
1 10.0
2 20.0
3 30.0
4 40.0
End NodalData
`;

const model = () => parseMdpa(TET_SRC);

test("the six new ops are synchronous (not gated as async)", () => {
  for (const op of [
    "linearize",
    "refine",
    "simplexify",
    "crop",
    "fieldCalc",
    "averageField",
  ] as const) {
    assert.equal(isAsyncOp(op), false, `${op} should not require applyOpAsync`);
  }
});

test("applyOp dispatches refine/simplexify/linearize/fieldCalc/crop", () => {
  const refined = applyOp(model(), { op: "refine", levels: 1 });
  assert.equal(refined.noop, undefined);
  assert.equal(refined.model.blocks[0].count, 8);

  const simplex = applyOp(model(), { op: "simplexify" });
  assert.equal(simplex.noop, true); // a tet is already a simplex

  const back = applyOp(refined.model, { op: "linearize" });
  assert.equal(back.model.blocks[0].count, 8); // still refined; only order drops

  const calc = applyOp(model(), { op: "fieldCalc", expr: "T*2", location: "Nodal", output: "T2" });
  assert.equal(calc.noop, undefined);
  assert.ok(calc.model.fields.some((f) => f.variable === "T2"));

  const crop = applyOp(model(), {
    op: "crop",
    kind: "bbox",
    lo: [-9, -9, -9],
    hi: [9, 9, 9],
    mode: "all",
  });
  assert.equal(crop.noop, true); // whole mesh is inside
});

test("opRecordFromMessage validates each new op's params", () => {
  assert.deepEqual(opRecordFromMessage({ op: "linearize" }), { op: "linearize" });
  assert.deepEqual(opRecordFromMessage({ op: "simplexify" }), { op: "simplexify" });

  assert.deepEqual(opRecordFromMessage({ op: "refine", levels: "2" }), { op: "refine", levels: 2 });
  assert.equal(opRecordFromMessage({ op: "refine", levels: 0 }), undefined);

  assert.deepEqual(
    opRecordFromMessage({
      op: "crop",
      kind: "bbox",
      lo: [0, 0, 0],
      hi: [1, 1, 1],
      mode: "any",
    }),
    { op: "crop", kind: "bbox", lo: [0, 0, 0], hi: [1, 1, 1], mode: "any" }
  );
  assert.equal(opRecordFromMessage({ op: "crop", kind: "bbox", lo: [0, 0] }), undefined);
  assert.equal(opRecordFromMessage({ op: "crop", kind: "sphere" }), undefined);

  assert.deepEqual(
    opRecordFromMessage({ op: "fieldCalc", expr: "T*2", location: "Nodal", output: "T2" }),
    { op: "fieldCalc", expr: "T*2", location: "Nodal", output: "T2" }
  );
  assert.equal(
    opRecordFromMessage({ op: "fieldCalc", expr: "", location: "Nodal", output: "T2" }),
    undefined
  );
  assert.equal(
    opRecordFromMessage({ op: "fieldCalc", expr: "T*2", location: "Nowhere", output: "T2" }),
    undefined
  );

  assert.deepEqual(
    opRecordFromMessage({ op: "averageField", variable: "T", direction: "nodalToElemental" }),
    { op: "averageField", variable: "T", direction: "nodalToElemental" }
  );
  assert.equal(
    opRecordFromMessage({ op: "averageField", variable: "T", direction: "sideways" }),
    undefined
  );
});

test("each new op round-trips through a JSON recipe", () => {
  const ops: OpRecord[] = [
    { op: "refine", levels: 1 },
    { op: "simplexify" },
    { op: "linearize" },
    { op: "crop", kind: "bbox", lo: [0, 0, 0], hi: [1, 1, 1], mode: "all" },
    { op: "fieldCalc", expr: "T*2", location: "Nodal", output: "T2" },
    { op: "averageField", variable: "T", direction: "nodalToElemental" },
  ];
  const { operations, warnings } = parseOpsJson(serializeOps(ops, "tet.mdpa"));
  assert.equal(warnings.length, 0);
  assert.deepEqual(operations, ops);
});

// --- mergeMesh (path-based async op) ---------------------------------------

test("mergeMesh is async (reads a second file) and validates its message", () => {
  assert.equal(isAsyncOp("mergeMesh"), true);
  assert.throws(() => applyOp(model(), { op: "mergeMesh", paths: ["x.mdpa"] }), /applyOpAsync/);

  assert.deepEqual(opRecordFromMessage({ op: "mergeMesh", paths: ["a.mdpa", "b.mdpa"] }), {
    op: "mergeMesh",
    paths: ["a.mdpa", "b.mdpa"],
  });
  assert.equal(opRecordFromMessage({ op: "mergeMesh", paths: [] }), undefined);
  assert.equal(opRecordFromMessage({ op: "mergeMesh", paths: [""] }), undefined);
  assert.equal(opRecordFromMessage({ op: "mergeMesh", paths: ["ok.mdpa", 7] }), undefined);
  assert.equal(opRecordFromMessage({ op: "mergeMesh" }), undefined);
});

test("mergeMesh still accepts the pre-N-ary single `path` spelling", () => {
  // Saved recipes and problem archives on disk can predate the extension that
  // reads them, so the old shape has to keep working — normalized, not special-cased.
  assert.deepEqual(opRecordFromMessage({ op: "mergeMesh", path: "other.mdpa" }), {
    op: "mergeMesh",
    paths: ["other.mdpa"],
  });
  assert.equal(opRecordFromMessage({ op: "mergeMesh", path: "" }), undefined);

  const legacy = JSON.stringify({
    version: 1,
    source: "tet.mdpa",
    operations: [{ op: "mergeMesh", path: "other.mdpa", weld: true }],
  });
  const { operations, warnings } = parseOpsJson(legacy);
  assert.equal(warnings.length, 0, "an old recipe loads without complaint");
  assert.deepEqual(operations, [{ op: "mergeMesh", paths: ["other.mdpa"], weld: true }]);
});

test("mergeMesh round-trips through a JSON recipe", () => {
  const ops: OpRecord[] = [
    { op: "mergeMesh", paths: ["a.mdpa", "b.mdpa"], weld: true, tolerance: 1e-6 },
  ];
  const { operations, warnings } = parseOpsJson(serializeOps(ops, "tet.mdpa"));
  assert.equal(warnings.length, 0);
  assert.deepEqual(operations, ops);
});

test("mergeMesh reports a missing file as a noop rather than throwing", async () => {
  const { applyOpAsync } = await import("../parser/operations");
  const r = await applyOpAsync(model(), { op: "mergeMesh", paths: ["/does/not/exist.mdpa"] });
  assert.equal(r.noop, true);
  assert.match(r.message ?? "", /Could not read/);
});

test("mergeMesh reads a .mdpa file for its path, not just meshFileParser's formats", async () => {
  // pickMergeMeshFile's dialog lists .mdpa first, so this is the single most
  // likely file a user picks — parseMeshFile (meshFileParser.ts) doesn't
  // handle it, mdpaParser.ts does; applyOpAsync must dispatch between them.
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { applyOpAsync } = await import("../parser/operations");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mergeMesh-mdpa-"));
  const otherPath = path.join(dir, "other.mdpa");
  fs.writeFileSync(otherPath, TET_SRC);
  const r = await applyOpAsync(model(), { op: "mergeMesh", paths: [otherPath], name: "Merged" });
  assert.equal(r.noop, undefined);
  assert.equal(r.model.nodeCount, 8);
  assert.ok(r.model.subModelParts.some((p) => p.name === "Merged"));
});

test("mergeMesh merges several files in one operation, naming each after its stem", async () => {
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { applyOpAsync } = await import("../parser/operations");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mergeMesh-many-"));
  const beam = path.join(dir, "beam.mdpa");
  const column = path.join(dir, "column.mdpa");
  fs.writeFileSync(beam, TET_SRC);
  fs.writeFileSync(column, TET_SRC);
  const r = await applyOpAsync(model(), { op: "mergeMesh", paths: [beam, column] });
  assert.equal(r.noop, undefined);
  assert.equal(r.model.nodeCount, 12);
  assert.deepEqual(
    r.model.subModelParts.map((p) => p.path).filter((p) => p === "beam" || p === "column"),
    ["beam", "column"]
  );
});

test("mergeMesh keeps the files it could read when one of several is missing", async () => {
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { applyOpAsync } = await import("../parser/operations");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mergeMesh-partial-"));
  const good = path.join(dir, "good.mdpa");
  fs.writeFileSync(good, TET_SRC);
  const r = await applyOpAsync(model(), {
    op: "mergeMesh",
    paths: [good, "/does/not/exist.mdpa"],
  });
  assert.equal(r.noop, undefined, "one bad file does not discard the good one");
  assert.equal(r.model.nodeCount, 8);
  assert.match(r.message ?? "", /Could not read/);
});

// --- renumber (sync id compaction) ------------------------------------------

test("renumber is sync and validates its message", () => {
  assert.equal(isAsyncOp("renumber"), false);
  assert.doesNotThrow(() => applyOp(model(), { op: "renumber" }));

  assert.deepEqual(opRecordFromMessage({ op: "renumber" }), { op: "renumber" });
  assert.deepEqual(opRecordFromMessage({ op: "renumber", target: "nodes" }), {
    op: "renumber",
    target: "nodes",
  });
  assert.deepEqual(opRecordFromMessage({ op: "renumber", start: 5 }), { op: "renumber", start: 5 });
  assert.equal(opRecordFromMessage({ op: "renumber", target: "bogus" }), undefined);
  assert.equal(opRecordFromMessage({ op: "renumber", start: 0 }), undefined);
  assert.equal(opRecordFromMessage({ op: "renumber", start: 1.5 }), undefined);
});

test("renumber round-trips through a JSON recipe", () => {
  const ops: OpRecord[] = [{ op: "renumber", target: "entities", start: 1 }];
  const { operations, warnings } = parseOpsJson(serializeOps(ops, "tet.mdpa"));
  assert.equal(warnings.length, 0);
  assert.deepEqual(operations, ops);

  const bad = parseOpsJson(
    JSON.stringify({ version: 1, source: "x", operations: [{ op: "renumber", start: 0 }] })
  );
  assert.equal(bad.operations.length, 0);
  assert.match(bad.warnings[0], /invalid start/);
});

test("renumber compacts a gappy id space through applyOp", () => {
  const gappy = parseMdpa(`Begin Properties 0
End Properties

Begin Nodes
5 0.0 0.0 0.0
40 1.0 0.0 0.0
41 0.0 1.0 0.0
End Nodes

Begin Elements Element2D3N
9 0 5 40 41
End Elements
`);
  const r = applyOp(gappy, { op: "renumber" });
  assert.equal(r.noop, undefined);
  assert.deepEqual(Array.from(r.model.nodeIds), [1, 2, 3]);
  assert.deepEqual(Array.from(r.model.blocks[0].entityIds), [1]);
  // An already-compact mesh has nothing to do.
  assert.equal(applyOp(r.model, { op: "renumber" }).noop, true);
});

// --- registry wiring --------------------------------------------------------

test("every op in OP_LABELS is reachable from a recipe", () => {
  // KNOWN_OPS is a Set<OpName>, so TypeScript cannot tell when an op is missing
  // from it — the op simply becomes unloadable from every saved recipe with a
  // "Skipped unknown operation" warning. This is the guard for that one site.
  for (const name of Object.keys(OP_LABELS)) {
    const { warnings } = parseOpsJson(
      JSON.stringify({ version: 1, source: "x", operations: [{ op: name }] })
    );
    assert.ok(
      !warnings.some((w) => w.includes("unknown operation")),
      `"${name}" is in OP_LABELS but missing from KNOWN_OPS`
    );
  }
});
