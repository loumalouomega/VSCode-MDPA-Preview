import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import {
  applyOp,
  applyOpAsync,
  replayOps,
  replayOpsAsync,
  isAsyncOp,
  serializeOps,
  parseOpsJson,
  opRecordFromMessage,
  OpRecord,
} from "../parser/operations";

const SRC = `Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 1.0 1.0 0.0
4 5.0 5.0 5.0
End Nodes

Begin Elements Element2D3N
1 1 1 2 3
End Elements

Begin SubModelPart Parent
  Begin SubModelPart Child
  End SubModelPart
End SubModelPart
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
    { op: "scale", sx: 2, sy: 2, sz: 2 },
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
    { op: "scale", sx: 0.5, sy: 0.5, sz: 0.5 },
    { op: "translate", dx: 1, dy: 2, dz: 3 },
    { op: "rotate", axis: "z", angle: 30 },
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
      { op: "rotate", axis: "z", angle: 45 },
    ],
  });
  const { operations, warnings } = parseOpsJson(json);
  assert.deepEqual(operations.map((o) => o.op), ["linearToQuadratic", "rotate"]);
  assert.equal(warnings.length, 2);
});

test("opRecordFromMessage builds validated records from sidebar params", () => {
  assert.deepEqual(opRecordFromMessage({ op: "scale", sx: "2", sy: 3, sz: 1 }), {
    op: "scale",
    sx: 2,
    sy: 3,
    sz: 1,
  });
  assert.deepEqual(opRecordFromMessage({ op: "translate", dx: 1, dy: 0, dz: -2 }), {
    op: "translate",
    dx: 1,
    dy: 0,
    dz: -2,
  });
  assert.deepEqual(opRecordFromMessage({ op: "rotate", axis: "y", angle: 90, cx: 1, cy: 2, cz: 3 }), {
    op: "rotate",
    axis: "y",
    angle: 90,
    cx: 1,
    cy: 2,
    cz: 3,
  });
  // Center defaults to the origin when omitted.
  assert.deepEqual(opRecordFromMessage({ op: "rotate", axis: "z", angle: 45 }), {
    op: "rotate",
    axis: "z",
    angle: 45,
    cx: 0,
    cy: 0,
    cz: 0,
  });
  assert.deepEqual(opRecordFromMessage({ op: "removeOrphanNodes" }), {
    op: "removeOrphanNodes",
  });
  // Invalid: bad axis, non-positive tolerance, unknown op → undefined.
  assert.equal(opRecordFromMessage({ op: "rotate", axis: "w", angle: 1 }), undefined);
  assert.equal(opRecordFromMessage({ op: "mergeNodes", tolerance: 0 }), undefined);
  assert.equal(opRecordFromMessage({ op: "explode" }), undefined);
});

test("applyOp renames a SubModelPart and rebases nested paths", () => {
  const m = parseMdpa(SRC);
  const out = applyOp(m, { op: "renameSubModelPart", path: "Parent", newName: "Inlet" });
  assert.ok(!out.noop);
  const part = out.model.subModelParts.find((p) => p.name === "Inlet")!;
  assert.ok(part);
  assert.equal(part.children[0].path, "Inlet/Child");
  // A missing path is a noop.
  const miss = applyOp(m, { op: "renameSubModelPart", path: "Nope", newName: "X" });
  assert.equal(miss.noop, true);
});

test("renameSubModelPart round-trips through a JSON recipe", () => {
  const ops: OpRecord[] = [
    { op: "renameSubModelPart", path: "Parent", newName: "Inlet" },
  ];
  const { operations, warnings } = parseOpsJson(serializeOps(ops, "test.mdpa"));
  assert.equal(warnings.length, 0);
  assert.deepEqual(operations, ops);
  // Message validation: both params required.
  assert.deepEqual(
    opRecordFromMessage({ op: "renameSubModelPart", path: "Parent", newName: "Inlet" }),
    { op: "renameSubModelPart", path: "Parent", newName: "Inlet" }
  );
  assert.equal(opRecordFromMessage({ op: "renameSubModelPart", path: "Parent" }), undefined);
  assert.equal(opRecordFromMessage({ op: "renameSubModelPart", path: "Parent", newName: "" }), undefined);
});

test("parseOpsJson rejects non-JSON and missing operations array", () => {
  assert.deepEqual(parseOpsJson("not json").operations, []);
  assert.deepEqual(parseOpsJson('{"foo":1}').operations, []);
});

// ---- MMG operations (remesh / levelset) --------------------------------------

const TET_SRC = `Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 1.0 1.0 0.0
4 0.0 1.0 0.0
5 0.0 0.0 1.0
6 1.0 0.0 1.0
7 1.0 1.0 1.0
8 0.0 1.0 1.0
End Nodes

Begin Elements Element3D4N
1 0 1 2 3 7
2 0 1 3 4 7
3 0 1 4 8 7
4 0 1 8 5 7
5 0 1 5 6 7
6 0 1 6 2 7
End Elements
`;

test("MMG ops are async-only: applyOp throws, applyOpAsync runs them", async () => {
  const m = parseMdpa(TET_SRC);
  assert.ok(isAsyncOp("remesh"));
  assert.ok(isAsyncOp("levelset"));
  assert.ok(!isAsyncOp("scale"));
  assert.throws(() => applyOp(m, { op: "remesh", mode: "optimize" }), /applyOpAsync/);
  const out = await applyOpAsync(m, { op: "remesh", mode: "factor", factor: 0.5 });
  assert.ok(!out.noop, out.message);
  assert.ok(out.model.nodeCount > m.nodeCount);
});

test("replayOpsAsync folds MMG and plain ops together", async () => {
  const m = parseMdpa(TET_SRC);
  const out = await replayOpsAsync(m, [
    { op: "remesh", mode: "factor", factor: 0.5 },
    { op: "scale", sx: 2, sy: 2, sz: 2 },
  ]);
  assert.ok(out.model.nodeCount > m.nodeCount);
  // The scale ran on the remeshed mesh: the bounding cube is now 2 units.
  let maxX = -Infinity;
  for (let i = 0; i < out.model.nodeCount; i++) {
    maxX = Math.max(maxX, out.model.coords[i * 3]);
  }
  assert.ok(Math.abs(maxX - 2) < 1e-4);
});

test("opRecordFromMessage validates remesh params from the sidebar form", () => {
  assert.deepEqual(opRecordFromMessage({ op: "remesh", mode: "factor", factor: "0.5" }), {
    op: "remesh",
    mode: "factor",
    factor: 0.5,
  });
  assert.deepEqual(
    opRecordFromMessage({
      op: "remesh",
      mode: "hsiz",
      hsiz: 0.2,
      hausd: 0.01,
      hgrad: 1.3,
      angleDetection: 30,
      nosurf: true,
      module: "mmg3d",
    }),
    {
      op: "remesh",
      mode: "hsiz",
      hsiz: 0.2,
      hausd: 0.01,
      hgrad: 1.3,
      angleDetection: 30,
      nosurf: true,
      module: "mmg3d",
    }
  );
  assert.deepEqual(opRecordFromMessage({ op: "remesh", mode: "optimize" }), {
    op: "remesh",
    mode: "optimize",
  });
  // Invalid: non-positive factor / missing hsiz.
  assert.equal(opRecordFromMessage({ op: "remesh", mode: "factor", factor: 0 }), undefined);
  assert.equal(opRecordFromMessage({ op: "remesh", mode: "hsiz" }), undefined);
});

test("opRecordFromMessage validates levelset params", () => {
  assert.deepEqual(opRecordFromMessage({ op: "levelset", variable: "DISTANCE" }), {
    op: "levelset",
    variable: "DISTANCE",
  });
  assert.deepEqual(
    opRecordFromMessage({ op: "levelset", variable: "D", isovalue: 0.5, isosurf: true }),
    { op: "levelset", variable: "D", isovalue: 0.5, isosurf: true }
  );
  assert.equal(opRecordFromMessage({ op: "levelset" }), undefined);
});

test("MMG ops round-trip through JSON recipes with validation", () => {
  const ops: OpRecord[] = [
    { op: "remesh", mode: "factor", factor: 0.5, hausd: 0.01 },
    { op: "levelset", variable: "DISTANCE", isovalue: 0.25 },
  ];
  const { operations, warnings } = parseOpsJson(serializeOps(ops, "cube.mdpa"));
  assert.equal(warnings.length, 0);
  assert.deepEqual(operations, ops);

  // Malformed MMG records are skipped with a warning.
  const bad = parseOpsJson(
    JSON.stringify({
      version: 1,
      operations: [
        { op: "remesh", mode: "factor" }, // missing factor
        { op: "remesh", mode: "hsiz", hsiz: 0.2, hgrad: -1 }, // bad tuning
        { op: "levelset" }, // missing variable
        { op: "remesh", mode: "optimize" },
      ],
    })
  );
  assert.deepEqual(bad.operations, [{ op: "remesh", mode: "optimize" }]);
  assert.equal(bad.warnings.length, 3);
});
