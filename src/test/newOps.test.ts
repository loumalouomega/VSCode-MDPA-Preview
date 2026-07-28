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
  assert.throws(() => applyOp(model(), { op: "mergeMesh", path: "x.mdpa" }), /applyOpAsync/);

  assert.deepEqual(opRecordFromMessage({ op: "mergeMesh", path: "other.mdpa" }), {
    op: "mergeMesh",
    path: "other.mdpa",
  });
  assert.equal(opRecordFromMessage({ op: "mergeMesh", path: "" }), undefined);
  assert.equal(opRecordFromMessage({ op: "mergeMesh" }), undefined);
});

test("mergeMesh round-trips through a JSON recipe", () => {
  const ops: OpRecord[] = [{ op: "mergeMesh", path: "other.mdpa", weld: true, tolerance: 1e-6 }];
  const { operations, warnings } = parseOpsJson(serializeOps(ops, "tet.mdpa"));
  assert.equal(warnings.length, 0);
  assert.deepEqual(operations, ops);
});

test("mergeMesh reports a missing file as a noop rather than throwing", async () => {
  const { applyOpAsync } = await import("../parser/operations");
  const r = await applyOpAsync(model(), { op: "mergeMesh", path: "/does/not/exist.mdpa" });
  assert.equal(r.noop, true);
  assert.match(r.message ?? "", /Could not read/);
});

test("mergeMesh reads a .mdpa file for its `path`, not just meshFileParser's formats", async () => {
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
  const r = await applyOpAsync(model(), { op: "mergeMesh", path: otherPath, name: "Merged" });
  assert.equal(r.noop, undefined);
  assert.equal(r.model.nodeCount, 8);
  assert.ok(r.model.subModelParts.some((p) => p.name === "Merged"));
});
