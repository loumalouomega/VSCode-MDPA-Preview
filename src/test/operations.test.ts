import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { applyOp, replayOps, serializeOps, parseOpsJson, OpRecord } from "../parser/operations";

const SRC = `Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 1.0 1.0 0.0
4 5.0 5.0 5.0
End Nodes

Begin Elements Element2D3N
1 1 1 2 3
End Elements
`;

test("applyOp dispatches to the right transform", () => {
  const m = parseMdpa(SRC);
  const quad = applyOp(m, { op: "linearToQuadratic" });
  assert.ok(!quad.noop);
  assert.ok(quad.model.nodeCount > m.nodeCount);
  assert.ok(quad.highlightNodes && quad.highlightNodes.length === 3);

  const orphan = applyOp(m, { op: "removeOrphanNodes" });
  assert.equal(orphan.model.nodeCount, 3); // node 4 dropped
});

test("applyOp reports noop when a transform changes nothing", () => {
  const m = parseMdpa(SRC);
  const clean = applyOp(m, { op: "removeOrphanNodes" }).model; // node 4 gone
  const again = applyOp(clean, { op: "removeOrphanNodes" });
  assert.equal(again.noop, true);
  assert.equal(again.model, clean);
});

test("replayOps folds a whole op list from the base", () => {
  const m = parseMdpa(SRC);
  const ops: OpRecord[] = [
    { op: "removeOrphanNodes" },
    { op: "transformCoords", scale: 2, dx: 0, dy: 0, dz: 0 },
    { op: "linearToQuadratic" },
  ];
  const out = replayOps(m, ops);
  // orphan removed (4→3 base nodes) then quadratic adds mid-edge nodes.
  assert.ok(out.model.nodeCount > 3);
  // node 2 scaled from (1,0,0) → (2,0,0)
  const i2 = [...out.model.nodeIds].indexOf(2);
  assert.equal(out.model.coords[i2 * 3], 2);
  // last op is linearToQuadratic → highlightNodes present
  assert.ok(out.highlightNodes && out.highlightNodes.length > 0);
});

test("replay of a prefix reproduces intermediate state (undo math)", () => {
  const m = parseMdpa(SRC);
  const ops: OpRecord[] = [
    { op: "removeOrphanNodes" },
    { op: "linearToQuadratic" },
  ];
  const afterFirst = replayOps(m, ops.slice(0, 1)).model;
  assert.equal(afterFirst.nodeCount, 3);
  const afterBoth = replayOps(m, ops).model;
  assert.ok(afterBoth.nodeCount > 3);
});

test("JSON recipe round-trips and replays identically", () => {
  const m = parseMdpa(SRC);
  const ops: OpRecord[] = [
    { op: "mergeNodes", tolerance: 1e-6 },
    { op: "transformCoords", scale: 0.5, dx: 1, dy: 2, dz: 3 },
  ];
  const json = serializeOps(ops, "test.mdpa");
  const { operations, warnings } = parseOpsJson(json);
  assert.equal(warnings.length, 0);
  assert.deepEqual(operations, ops);

  const a = replayOps(m, ops).model;
  const b = replayOps(m, operations).model;
  assert.deepEqual([...a.coords], [...b.coords]);
});

test("parseOpsJson skips unknown / malformed ops with warnings", () => {
  const json = JSON.stringify({
    version: 1,
    operations: [
      { op: "linearToQuadratic" },
      { op: "explode" },
      { op: "mergeNodes" }, // missing tolerance
      { op: "transformCoords", scale: 1, dx: 0, dy: 0, dz: 0 },
    ],
  });
  const { operations, warnings } = parseOpsJson(json);
  assert.deepEqual(operations.map((o) => o.op), ["linearToQuadratic", "transformCoords"]);
  assert.equal(warnings.length, 2);
});

test("parseOpsJson rejects non-JSON and missing operations array", () => {
  assert.deepEqual(parseOpsJson("not json").operations, []);
  assert.deepEqual(parseOpsJson('{"foo":1}').operations, []);
});
