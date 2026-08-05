/**
 * The meshio++-backed "oracle" operations: smooth, reorder, partition.
 *
 * Runs the real WASM. The header these tests exist for is FIDELITY: each of
 * these ops asks meshio++ for an answer and applies it to our own model, rather
 * than adopting the mesh meshio++ returns — because that round-trip would
 * destroy every SubModelPart, collapse Conditions into Elements, drop
 * `propertyIds` and renumber every id. The `preserves everything` tests below
 * are the guard on that design; if someone "simplifies" one of these modules
 * into a plain round-trip, they fail.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseMdpa } from "../parser/mdpaParser";
import { applyOpAsync, isAsyncOp, applyOp } from "../parser/operations";
import { smoothModel } from "../parser/smoothMesh";
import { reorderModel } from "../parser/reorderMesh";
import { partitionModel, PARTITION_VARIABLE } from "../parser/partitionMesh";
import { MdpaModel } from "../parser/types";

/**
 * A 3x3 grid of quads (16 nodes) with an interior node pulled off-position, a
 * SubModelPart, a Conditions block and non-default property ids — i.e. every
 * piece of state the round-trip would have eaten.
 */
function gridSrc(): string {
  const lines: string[] = ["Begin Properties 7", "End Properties", "", "Begin Nodes"];
  // Node lines are emitted in a SCRAMBLED order (ids are still 1..16, but their
  // storage positions are not). Bandwidth is measured on position, so a
  // row-major grid is already near-optimal and RCM would have nothing to do —
  // this makes the improvement measurable. `scramble` is a fixed permutation.
  const scramble = (k: number): number => (k * 7) % 16;
  const node = (id: number): string => {
    const i = (id - 1) % 4;
    const j = Math.floor((id - 1) / 4);
    // Node 6 (i=1,j=1) is displaced; smoothing should pull it back.
    const off = id === 6 ? 0.35 : 0;
    return `${id} ${i + off} ${j + off} 0.0`;
  };
  for (let k = 0; k < 16; k++) lines.push(node(scramble(k) + 1));
  lines.push("End Nodes", "", "Begin Elements Element2D4N");
  let e = 1;
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 3; i++) {
      const n = j * 4 + i + 1;
      lines.push(`${e++} 7 ${n} ${n + 1} ${n + 5} ${n + 4}`);
    }
  }
  lines.push("End Elements", "");
  // A point condition, so the Conditions kind is present and must survive.
  lines.push("Begin Conditions PointCondition2D1N", "100 7 1", "End Conditions", "");
  lines.push(
    "Begin SubModelPart Inlet",
    "  Begin SubModelPartNodes",
    "  1",
    "  2",
    "  End SubModelPartNodes",
    "  Begin SubModelPartElements",
    "  1",
    "  End SubModelPartElements",
    "End SubModelPart"
  );
  return lines.join("\n") + "\n";
}

const grid = (): MdpaModel => parseMdpa(gridSrc());

/** The state an oracle op must leave exactly as it found it. */
function fidelity(m: MdpaModel): unknown {
  return {
    parts: m.subModelParts.map((p) => ({
      path: p.path,
      nodes: Array.from(p.nodeIds),
      elements: Array.from(p.elementIds),
    })),
    blocks: m.blocks.map((b) => ({
      kind: b.kind,
      name: b.name,
      ids: Array.from(b.entityIds),
      props: b.propertyIds ? Array.from(b.propertyIds) : undefined,
      conn: Array.from(b.connectivity),
    })),
    nodeIds: Array.from(m.nodeIds),
  };
}

// --- smooth ---------------------------------------------------------------

test("smooth moves nodes and leaves everything else identical", async () => {
  const before = grid();
  const snapshot = fidelity(before);
  const r = await smoothModel(before, { iterations: 5 });

  assert.ok(r.numNodesMoved > 0, "the displaced interior node should move");
  assert.equal(r.model.nodeCount, before.nodeCount);
  // The design invariant: only coordinates changed.
  assert.deepEqual(fidelity(r.model), snapshot);
  assert.notDeepEqual(Array.from(r.model.coords), Array.from(before.coords));
  assert.notEqual(r.model.coords, before.coords, "input never mutated");
});

test("smooth pulls a displaced interior node back toward its neighbours", async () => {
  const before = grid();
  // Node ids are scrambled across storage positions, so look the index up.
  const idx = Array.from(before.nodeIds).indexOf(6); // the displaced node
  assert.ok(idx >= 0);
  const r = await smoothModel(before, { iterations: 20 });
  const dBefore = Math.hypot(before.coords[idx * 3] - 1, before.coords[idx * 3 + 1] - 1);
  const dAfter = Math.hypot(r.model.coords[idx * 3] - 1, r.model.coords[idx * 3 + 1] - 1);
  assert.ok(dAfter < dBefore, `expected the node to move toward (1,1): ${dBefore} -> ${dAfter}`);
});

test("smooth with fixBoundary pins the outer ring", async () => {
  const before = grid();
  const r = await smoothModel(before, { iterations: 20, fixBoundary: true });
  // Node id 1 is a corner; it must not have moved at all.
  const c = Array.from(before.nodeIds).indexOf(1);
  for (let k = 0; k < 3; k++) {
    assert.equal(r.model.coords[c * 3 + k], before.coords[c * 3 + k], `corner moved on axis ${k}`);
  }
});

test("smooth rejects an out-of-band lambda/mu pair loudly", async () => {
  // meshio++ enforces mu < -lambda < 0 for taubin; surface its error rather
  // than silently producing a shrunken mesh.
  await assert.rejects(smoothModel(grid(), { method: "taubin", lambda: 0.5, mu: 0.5 }));
});

// --- reorder ---------------------------------------------------------------

test("reorder is a pure permutation: same ids, same coords, new order", async () => {
  const before = grid();
  const r = await reorderModel(before, "rcm");
  assert.equal(r.model.nodeCount, before.nodeCount);

  // Same set of node ids, and each id keeps its own coordinates.
  const coordOf = (m: MdpaModel, id: number): number[] => {
    const i = Array.from(m.nodeIds).indexOf(id);
    return [m.coords[i * 3], m.coords[i * 3 + 1], m.coords[i * 3 + 2]];
  };
  assert.deepEqual(
    Array.from(r.model.nodeIds).sort((a, b) => a - b),
    Array.from(before.nodeIds).sort((a, b) => a - b)
  );
  for (const id of before.nodeIds) assert.deepEqual(coordOf(r.model, id), coordOf(before, id));
});

test("reorder leaves connectivity, parts and properties untouched", async () => {
  // Connectivity is by node ID, so a storage-order change must not touch it —
  // this is what makes the permutation safe to apply to our own model.
  const before = grid();
  const snapshot = fidelity(before);
  const r = await reorderModel(before, "rcm");
  const after = fidelity(r.model) as { nodeIds: number[] };
  assert.deepEqual(
    { ...(snapshot as object), nodeIds: undefined },
    { ...(after as object), nodeIds: undefined }
  );
});

test("reorder reports the bandwidth it achieved", async () => {
  const r = await reorderModel(grid(), "rcm");
  assert.ok(r.bandwidthBefore > 0);
  assert.ok(r.bandwidthAfter > 0);
  assert.ok(
    r.bandwidthAfter < r.bandwidthBefore,
    `RCM should improve a badly-numbered mesh: ${r.bandwidthBefore} -> ${r.bandwidthAfter}`
  );
});

test("every reorder method runs", async () => {
  for (const method of ["rcm", "morton", "hilbert"] as const) {
    const r = await reorderModel(grid(), method);
    assert.equal(r.model.nodeCount, 16, `${method} changed the node count`);
  }
});

// --- partition -------------------------------------------------------------

test("partition labels every cell exactly once, balanced", async () => {
  const before = grid();
  const r = await partitionModel(before, { nparts: 3 });
  assert.equal(r.assigned, 10); // 9 elements + 1 condition
  assert.equal(r.sizes.length, 3);
  assert.equal(
    r.sizes.reduce((a, b) => a + b, 0),
    10
  );
  // SFC balances by cell count to within one.
  assert.ok(Math.max(...r.sizes) - Math.min(...r.sizes) <= 1, `unbalanced: ${r.sizes}`);

  const f = r.model.fields.find((x) => x.variable === PARTITION_VARIABLE);
  assert.ok(f, "PARTITION_INDEX field attached");
  assert.equal(f.kind, "Elemental");
  assert.equal(f.ids.length, 10);
  assert.ok(Array.from(f.values).every((v) => v >= 0 && v < 3));
});

test("partition preserves the mesh itself", async () => {
  const before = grid();
  const snapshot = fidelity(before);
  const r = await partitionModel(before, { nparts: 2 });
  assert.deepEqual(fidelity(r.model), snapshot, "partition must only ADD a field");
  assert.deepEqual(Array.from(r.model.coords), Array.from(before.coords));
});

test("partition can also create one SubModelPart per part", async () => {
  const r = await partitionModel(grid(), { nparts: 2, createParts: true });
  const paths = r.model.subModelParts.map((p) => p.path);
  assert.ok(paths.includes("Inlet"), "the original part survives");
  assert.ok(paths.includes("Partition_0") && paths.includes("Partition_1"));
  const total = r.model.subModelParts
    .filter((p) => p.path.startsWith("Partition_"))
    .reduce((n, p) => n + p.elementIds.length, 0);
  assert.equal(total, 10);
});

test("partition surfaces the missing KaHIP backend instead of downgrading", async () => {
  // The WASM build has no KaHIP; a user asking for quality partitioning should
  // be told, not silently given a space-filling curve.
  await assert.rejects(partitionModel(grid(), { nparts: 2, method: "kahip" }), /kahip/i);
});

test("applying partition twice replaces rather than duplicates the field", async () => {
  const once = (await partitionModel(grid(), { nparts: 2 })).model;
  const twice = (await partitionModel(once, { nparts: 3 })).model;
  assert.equal(twice.fields.filter((f) => f.variable === PARTITION_VARIABLE).length, 1);
});

// --- op plumbing -----------------------------------------------------------

test("the oracle ops are async-only and reachable through applyOpAsync", async () => {
  for (const op of ["smooth", "reorder", "partition"] as const) {
    assert.equal(isAsyncOp(op), true, `${op} must be gated as async`);
  }
  assert.throws(() => applyOp(grid(), { op: "smooth" }), /applyOpAsync/);
  assert.throws(() => applyOp(grid(), { op: "reorder", method: "rcm" }), /applyOpAsync/);
  assert.throws(() => applyOp(grid(), { op: "partition", nparts: 2 }), /applyOpAsync/);

  const r = await applyOpAsync(grid(), { op: "partition", nparts: 2 });
  assert.equal(r.noop, undefined);
  assert.match(r.message ?? "", /Partitioned 10 cell\(s\) into 2 part\(s\)/);
});

// --- gradient (meshio++ >= 9.10.0) ----------------------------------------
//
// The fourth oracle, and the one whose losslessness is easiest to state: asked
// for `location: "point"`, the operation returns one tuple per EXISTING node in
// the input's own order, so the answer drops onto our own nodes directly.

/** Two tets sharing a face, carrying T = x + 2y + 3z — a linear field. */
function linearFieldModel(): MdpaModel {
  return parseMdpa(
    [
      "Begin Properties 3",
      "End Properties",
      "",
      "Begin Nodes",
      " 1 0.0 0.0 0.0",
      " 2 1.0 0.0 0.0",
      " 3 0.0 1.0 0.0",
      " 4 0.0 0.0 1.0",
      " 5 1.0 1.0 1.0",
      "End Nodes",
      "",
      "Begin Elements Element3D4N",
      " 1 3 1 2 3 4",
      " 2 3 2 3 4 5",
      "End Elements",
      "",
      "Begin Conditions SurfaceCondition3D3N",
      " 100 3 1 2 3",
      "End Conditions",
      "",
      "Begin NodalData TEMP",
      " 1 0 0.0",
      " 2 0 1.0",
      " 3 0 2.0",
      " 4 0 3.0",
      " 5 0 6.0",
      "End NodalData",
      "",
      "Begin SubModelPart Hot",
      "  Begin SubModelPartNodes",
      "  1",
      "  5",
      "  End SubModelPartNodes",
      "  Begin SubModelPartElements",
      "  2",
      "  End SubModelPartElements",
      "End SubModelPart",
      "",
    ].join("\n")
  );
}

test("gradient of a linear field is exact, and everything else is untouched", async () => {
  // Green-Gauss is documented exact for a linear field on ANY cell, so this is
  // a real correctness check rather than a smoke test: grad(x + 2y + 3z) is
  // (1,2,3) everywhere, at every node.
  const before = linearFieldModel();
  const snapshot = fidelity(before);
  const r = await applyOpAsync(before, { op: "fieldGradient", variable: "TEMP" });

  const g = r.model.fields.find((f) => f.variable === "TEMP_GRADIENT");
  assert.ok(g, `expected TEMP_GRADIENT, got ${r.model.fields.map((f) => f.variable)}`);
  assert.equal(g.kind, "Nodal");
  assert.equal(g.components, 3, "a scalar's gradient has three components");
  assert.equal(g.values.length, 3 * before.nodeCount, "one tuple per node");
  for (let i = 0; i < before.nodeCount; i++) {
    assert.ok(Math.abs(g.values[i * 3] - 1) < 1e-6, `dT/dx at node ${i}`);
    assert.ok(Math.abs(g.values[i * 3 + 1] - 2) < 1e-6, `dT/dy at node ${i}`);
    assert.ok(Math.abs(g.values[i * 3 + 2] - 3) < 1e-6, `dT/dz at node ${i}`);
  }
  assert.deepEqual(g.ids ? Array.from(g.ids) : [], Array.from(before.nodeIds), "our own node ids");

  assert.deepEqual(fidelity(r.model), snapshot, "parts/blocks/kinds/props/ids preserved");
  assert.ok(
    r.model.fields.some((f) => f.variable === "TEMP"),
    "the source field is still there"
  );
});

test("gradient honours the output name and replaces its own field on re-run", async () => {
  const m = linearFieldModel();
  const once = await applyOpAsync(m, {
    op: "fieldGradient",
    variable: "TEMP",
    output: "GRAD_T",
  });
  assert.ok(once.model.fields.some((f) => f.variable === "GRAD_T"));
  const twice = await applyOpAsync(once.model, {
    op: "fieldGradient",
    variable: "TEMP",
    output: "GRAD_T",
  });
  assert.equal(
    twice.model.fields.filter((f) => f.variable === "GRAD_T").length,
    1,
    "re-running replaces rather than stacking a second field"
  );
});

test("least-squares agrees with green-gauss on a linear field", async () => {
  // The two methods are exact for a linear field by different routes, so they
  // must land on the same answer; a rank-deficient neighbourhood falls back and
  // is counted rather than silently approximated.
  const m = linearFieldModel();
  const gg = await applyOpAsync(m, { op: "fieldGradient", variable: "TEMP" });
  const ls = await applyOpAsync(m, {
    op: "fieldGradient",
    variable: "TEMP",
    method: "least-squares",
  });
  const a = gg.model.fields.find((f) => f.variable === "TEMP_GRADIENT")!;
  const b = ls.model.fields.find((f) => f.variable === "TEMP_GRADIENT")!;
  for (let i = 0; i < a.values.length; i++) {
    assert.ok(Math.abs(a.values[i] - b.values[i]) < 1e-6, `component ${i}`);
  }
});

test("divergence and curl need a vector field, and say so by name", async () => {
  const m = linearFieldModel();
  for (const operator of ["divergence", "curl"] as const) {
    await assert.rejects(
      () => applyOpAsync(m, { op: "fieldGradient", variable: "TEMP", operator }),
      /2- or 3-component/,
      `${operator} rejects a scalar`
    );
  }
});

test("an Elemental source points at the averaging op rather than just failing", async () => {
  // A piecewise-constant field has no derivative at all, which is a different
  // problem from "no such field" — and the extension already owns the fix.
  const m = parseMdpa(
    [
      "Begin Nodes",
      " 1 0.0 0.0 0.0",
      " 2 1.0 0.0 0.0",
      " 3 0.0 1.0 0.0",
      " 4 0.0 0.0 1.0",
      "End Nodes",
      "Begin Elements Element3D4N",
      " 1 0 1 2 3 4",
      "End Elements",
      "Begin ElementalData RHO",
      " 1 2.5",
      "End ElementalData",
      "",
    ].join("\n")
  );
  await assert.rejects(
    () => applyOpAsync(m, { op: "fieldGradient", variable: "RHO" }),
    /Average field/,
    "names the op that would fix it"
  );
  await assert.rejects(
    () => applyOpAsync(m, { op: "fieldGradient", variable: "NOPE" }),
    /No nodal field named "NOPE"/
  );
});

test("fieldGradient is async-only, like the other oracles", () => {
  assert.equal(isAsyncOp("fieldGradient"), true);
  assert.throws(
    () => applyOp(linearFieldModel(), { op: "fieldGradient", variable: "TEMP" }),
    /applyOpAsync/
  );
});
