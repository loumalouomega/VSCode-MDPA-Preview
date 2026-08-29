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
import { hessianFieldModel } from "../parser/hessianField";
import { estimateErrorModel, ERROR_MARKED_VARIABLE } from "../parser/errorEstimate";
import { sdfFieldModel } from "../parser/sdfField";
import { transferFieldModel } from "../parser/transferField";
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

/**
 * An octahedron's 8 faces fanned to ONE interior vertex, which is displaced off
 * the centre. Tet-only, because that is what ODT accepts — and the octahedron
 * is chosen because its ODT-optimal interior position is exactly the origin, so
 * the test can assert a NUMBER rather than "it moved a bit".
 */
function tetFanSrc(displaced: [number, number, number]): string {
  const outer = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ];
  const faces = [
    [1, 3, 5], [3, 2, 5], [2, 4, 5], [4, 1, 5],
    [3, 1, 6], [2, 3, 6], [4, 2, 6], [1, 4, 6],
  ];
  const lines: string[] = ["Begin Nodes"];
  outer.forEach((p, i) => lines.push(` ${i + 1} ${p[0]} ${p[1]} ${p[2]}`));
  lines.push(` 7 ${displaced[0]} ${displaced[1]} ${displaced[2]}`, "End Nodes", "");
  lines.push("Begin Elements Element3D4N");
  faces.forEach((f, i) => lines.push(` ${i + 1} 0 ${f[0]} ${f[1]} ${f[2]} 7`));
  lines.push("End Elements", "");
  return lines.join("\n");
}

/** The interior vertex's coordinates — node 7 is the 7th, so index 6. */
function node7(m: MdpaModel): [number, number, number] {
  return [m.coords[18], m.coords[19], m.coords[20]];
}

test("odt smoothing pulls an interior tet vertex to its optimal position", async () => {
  // meshio++ >= 10.13.0. ODT moves each free interior vertex to the
  // volume-weighted average of its incident tets' circumcenters, which for this
  // octahedral fan is exactly the origin — so this asserts the actual value
  // rather than merely that something moved.
  const before = parseMdpa(tetFanSrc([0.3, 0.2, 0.1]));
  const r = await smoothModel(before, { method: "odt", iterations: 20 });

  assert.equal(r.numNodesMoved, 1, "only the interior vertex is free to move");
  for (const c of node7(r.model)) assert.ok(Math.abs(c) < 1e-6, `landed on the origin, got ${c}`);
  // The six boundary vertices are pinned by fixBoundary's default, so the
  // largest displacement is the interior one's, |(0.3, 0.2, 0.1)|.
  assert.ok(Math.abs(r.maxDisplacement - Math.hypot(0.3, 0.2, 0.1)) < 1e-5);
  // The oracle contract: coordinates moved and nothing else did.
  assert.deepEqual(fidelity(r.model), fidelity(before));
});

test("odt names the tet-only restriction instead of quietly doing nothing", async () => {
  // The failure mode worth guarding: a silent noop is indistinguishable from
  // "smoothing had no useful effect", so upstream's own error must reach the
  // user rather than being swallowed into a noop outcome.
  const quads = grid();
  await assert.rejects(
    () => smoothModel(quads, { method: "odt", iterations: 5 }),
    /tet-only|tet only/i,
    "the error says WHY, naming the cell type it refused"
  );
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

// --- hessian / estimateError (meshio++ >= 10.9.0 / 10.10.0) ------------------
//
// Both are Group A oracles for the same reason the four before them are: the
// answer is one tuple per EXISTING node (hessian) or one value per EXISTING
// cell (estimateError), so it lands on our own model and nothing else crosses
// back. The fidelity assertions below are the guard on that.

/**
 * A 2x1x1 bar of tets carrying a field that is exactly LINEAR in space. Linear
 * is the load-bearing choice: a linear field has an exactly zero Hessian and an
 * exactly zero ZZ error on ANY mesh, so both ops can be checked against a known
 * value instead of "it produced some numbers".
 */
function tetBarSrc(quadratic = false): string {
  const lines: string[] = ["Begin Nodes"];
  const idx = new Map<string, number>();
  let id = 1;
  for (let k = 0; k < 2; k++) {
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 3; i++) {
        idx.set(`${i},${j},${k}`, id);
        lines.push(` ${id++} ${i} ${j} ${k}`);
      }
    }
  }
  lines.push("End Nodes", "", "Begin Elements Element3D4N");
  const HEX = [
    [0, 1, 3, 4], [1, 2, 3, 4], [2, 3, 4, 7], [1, 2, 4, 5], [2, 4, 5, 6], [2, 4, 6, 7],
  ];
  let e = 1;
  for (let c = 0; c < 2; c++) {
    const corners = [
      [c, 0, 0], [c + 1, 0, 0], [c + 1, 1, 0], [c, 1, 0],
      [c, 0, 1], [c + 1, 0, 1], [c + 1, 1, 1], [c, 1, 1],
    ].map(([i, j, k]) => idx.get(`${i},${j},${k}`)!);
    for (const t of HEX) lines.push(` ${e++} 0 ${t.map((n) => corners[n]).join(" ")}`);
  }
  lines.push("End Elements", "");
  lines.push("Begin NodalData TEMP");
  for (const [key, n] of idx) {
    const [i, j, k] = key.split(",").map(Number);
    // Linear by default; x^2 when a curved field is wanted.
    lines.push(` ${n} 0 ${quadratic ? i * i : i + 2 * j + 3 * k}`);
  }
  lines.push("End NodalData", "");
  return lines.join("\n");
}

const tetBar = (quadratic = false): MdpaModel => parseMdpa(tetBarSrc(quadratic));

test("the Hessian of a linear field is zero, and it lands as a 9-wide nodal field", async () => {
  // The one mesh-shape-independent guarantee upstream states, so it is the
  // right thing to pin: anything else would be asserting our own arithmetic.
  const before = tetBar();
  const r = await hessianFieldModel(before, { variable: "TEMP" });

  assert.equal(r.output, "TEMP_HESSIAN");
  assert.equal(r.components, 9, "the flattened row-major 3x3");
  const f = r.model.fields.find((x) => x.kind === "Nodal" && x.variable === "TEMP_HESSIAN")!;
  assert.ok(f, "the field is attached");
  assert.equal(f.values.length, 9 * before.nodeCount, "one tuple per existing node");
  assert.deepEqual(Array.from(f.ids), Array.from(before.nodeIds), "keyed by our own node ids");
  for (const v of f.values) assert.ok(Math.abs(v) < 1e-6, `linear field ⇒ zero Hessian, got ${v}`);
  // The oracle contract.
  assert.deepEqual(fidelity(r.model), fidelity(before));
});

test("the Hessian refuses a vector field and says how to proceed", async () => {
  // Upstream raises on this too, but on array width. Ours names the way out.
  const m = tetBar();
  const nodal = m.fields.find((f) => f.variable === "TEMP")!;
  const vec: MdpaModel = {
    ...m,
    fields: [{ ...nodal, variable: "VEL", components: 3,
      values: new Float64Array(3 * m.nodeCount) }],
  };
  await assert.rejects(
    () => hessianFieldModel(vec, { variable: "VEL" }),
    /scalar field/i
  );
});

test("the Hessian refuses an Elemental source, pointing at the averaging op", async () => {
  const m = tetBar();
  const elemental: MdpaModel = {
    ...m,
    fields: [{ kind: "Elemental", variable: "RHO", components: 1,
      ids: Int32Array.from(m.blocks[0].entityIds),
      values: new Float64Array(m.blocks[0].count) }],
  };
  await assert.rejects(
    () => hessianFieldModel(elemental, { variable: "RHO" }),
    /Average field/
  );
});

test("estimateError reports zero for a field the mesh represents exactly", async () => {
  // ZZ recovers the gradient and compares it with the raw one; for a linear
  // field those agree exactly, so a near-zero global error is the estimator
  // working, not failing.
  const before = tetBar();
  const r = await estimateErrorModel(before, { variable: "TEMP" });

  assert.equal(r.output, "ERROR_INDICATOR");
  assert.equal(r.marked, "", 'marking defaults to "none", so no second field');
  assert.ok(Math.abs(r.globalError) < 1e-9, `linear ⇒ ~0 error, got ${r.globalError}`);
  assert.equal(r.numSkipped, 0);

  const f = r.model.fields.find(
    (x) => x.kind === "Elemental" && x.variable === "ERROR_INDICATOR"
  )!;
  const cells = before.blocks.reduce((n, b) => n + b.count, 0);
  assert.equal(f.values.length, cells, "one value per existing cell");
  assert.deepEqual(
    Array.from(f.ids),
    Array.from(before.blocks[0].entityIds),
    "keyed by our own element ids"
  );
  assert.deepEqual(fidelity(r.model), fidelity(before));
});

test("estimateError finds real error in a curved field and can mark cells", async () => {
  // x^2 is NOT representable on a linear tet mesh, so the indicator must be
  // non-zero — the complement of the test above, which is what stops "always
  // returns zero" from passing both.
  const before = tetBar(true);
  const r = await estimateErrorModel(before, {
    variable: "TEMP",
    marking: "fraction",
    markingValue: 0.5,
  });

  assert.ok(r.globalError > 0, `a curved field has real error, got ${r.globalError}`);
  const cells = before.blocks.reduce((n, b) => n + b.count, 0);
  assert.equal(r.marked, ERROR_MARKED_VARIABLE);
  assert.equal(r.numMarked, Math.round(cells * 0.5), "half the cells, worst first");

  const marks = r.model.fields.find(
    (x) => x.kind === "Elemental" && x.variable === ERROR_MARKED_VARIABLE
  )!;
  assert.equal(marks.values.length, cells);
  for (const v of marks.values) {
    assert.ok(v === 0 || v === 1, `the marking array is 0/1, never NaN — got ${v}`);
  }
  assert.equal(
    Array.from(marks.values).filter((v) => v === 1).length,
    r.numMarked,
    "the reported count and the field agree"
  );
});

test("estimateError rejects an out-of-range fraction by name", async () => {
  await assert.rejects(
    () => estimateErrorModel(tetBar(), { variable: "TEMP", marking: "fraction", markingValue: 0 }),
    /fraction in \(0, 1\]/
  );
});

test("re-running either op replaces its own field rather than duplicating it", async () => {
  let m = tetBar(true);
  const count = (mm: MdpaModel, v: string): number =>
    mm.fields.filter((f) => f.variable === v).length;
  m = (await hessianFieldModel(m, { variable: "TEMP" })).model;
  m = (await hessianFieldModel(m, { variable: "TEMP" })).model;
  assert.equal(count(m, "TEMP_HESSIAN"), 1);
  m = (await estimateErrorModel(m, { variable: "TEMP", marking: "dorfler", markingValue: 0.5 })).model;
  m = (await estimateErrorModel(m, { variable: "TEMP", marking: "dorfler", markingValue: 0.5 })).model;
  assert.equal(count(m, "ERROR_INDICATOR"), 1);
  assert.equal(count(m, ERROR_MARKED_VARIABLE), 1);
});

test("both new ops are async-only, like the other oracles", () => {
  for (const op of ["fieldHessian", "estimateError"] as const) {
    assert.ok(isAsyncOp(op), `${op} is in ASYNC_OPS`);
    assert.throws(() => applyOp(tetBar(), { op, variable: "TEMP" }), /applyOpAsync/);
  }
});

// --- sdfDistance / transferField (meshio++ >= 10.4.0 / 10.7.0) --------------
//
// The two-mesh oracles. Both take an already-parsed second model, so these
// tests never touch the filesystem — path handling lives in operations.ts, the
// same split mergeMesh.ts uses.

/** A closed triangulated box surface, centred at the origin, half-extent `h`. */
function boxSurfaceSrc(h: number): string {
  const c = [
    [-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h],
    [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h],
  ];
  const tris = [
    [1, 3, 2], [1, 4, 3], [5, 6, 7], [5, 7, 8],
    [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6],
    [3, 4, 8], [3, 8, 7], [4, 1, 5], [4, 5, 8],
  ];
  const lines = ["Begin Nodes"];
  c.forEach((p, i) => lines.push(` ${i + 1} ${p[0]} ${p[1]} ${p[2]}`));
  lines.push("End Nodes", "", "Begin Elements Element3D3N");
  tris.forEach((t, i) => lines.push(` ${i + 1} 0 ${t.join(" ")}`));
  lines.push("End Elements", "");
  return lines.join("\n");
}

test("sdfDistance signs nodes by the surface, negative inside", async () => {
  // The tet bar spans x in [0,2], y,z in [0,1]; a box of half-extent 0.75 about
  // the origin therefore contains some of its nodes and not others, which is
  // what makes the sign meaningful to assert.
  const before = tetBar();
  const surface = parseMdpa(boxSurfaceSrc(0.75));
  const r = await sdfFieldModel(before, surface);

  assert.equal(r.output, "SDF_DISTANCE");
  const f = r.model.fields.find((x) => x.kind === "Nodal" && x.variable === "SDF_DISTANCE")!;
  assert.equal(f.components, 1);
  assert.equal(f.values.length, before.nodeCount, "one value per node");
  assert.deepEqual(Array.from(f.ids), Array.from(before.nodeIds), "keyed by our node ids");

  // Check the sign against the geometry itself rather than trusting the count.
  let inside = 0;
  for (let i = 0; i < before.nodeCount; i++) {
    const [x, y, z] = [before.coords[i * 3], before.coords[i * 3 + 1], before.coords[i * 3 + 2]];
    const within = Math.abs(x) < 0.75 && Math.abs(y) < 0.75 && Math.abs(z) < 0.75;
    assert.equal(f.values[i] < 0, within, `node at ${x},${y},${z} sign`);
    if (within) inside++;
  }
  assert.equal(r.numInside, inside);
  assert.ok(inside > 0 && inside < before.nodeCount, "the fixture straddles the surface");
  // Our mesh never crossed the wasm boundary, so nothing else can have changed.
  assert.deepEqual(fidelity(r.model), fidelity(before));
});

test("sdfDistance refuses a surface with no cells", async () => {
  const empty = parseMdpa(["Begin Nodes", " 1 0 0 0", "End Nodes", ""].join("\n"));
  await assert.rejects(() => sdfFieldModel(tetBar(), empty), /no cells/);
});

test("transferField carries a CONSTANT nodal field across exactly", async () => {
  // Constant is the load-bearing choice. conservativeInterpolate remaps
  // cell_data directly but routes point_data through a point->cell->clip->point
  // composition, so even between two IDENTICAL meshes a varying nodal field
  // comes back SMOOTHED, not resampled. A constant is the case where the
  // averaging is provably the identity — so this tests the plumbing without
  // asserting something the algorithm does not promise.
  const target = tetBar();
  const source = tetBar();
  const src = source.fields.find((x) => x.variable === "TEMP")!;
  const constant: MdpaModel = {
    ...source,
    fields: [{ ...src, values: new Float64Array(src.values.length).fill(4.25) }],
  };
  const bare: MdpaModel = { ...target, fields: [] };

  const r = await transferFieldModel(bare, constant, {});
  assert.deepEqual(r.dropped, [], "identical meshes lose nothing");
  assert.ok(r.transferred.includes("TEMP"), `got ${r.transferred.join(",")}`);

  const f = r.model.fields.find((x) => x.variable === "TEMP")!;
  assert.equal(f.kind, "Nodal");
  assert.equal(f.values.length, bare.nodeCount, "one value per node");
  assert.deepEqual(Array.from(f.ids), Array.from(bare.nodeIds), "keyed by our node ids");
  for (const v of f.values) assert.ok(Math.abs(v - 4.25) < 1e-9, `constant survives, got ${v}`);
  assert.deepEqual(fidelity(r.model), fidelity(bare));
});

test("a varying nodal field is smoothed, and stays inside the source's range", async () => {
  // The complement of the test above, pinning the documented approximation so
  // nobody later "fixes" a bug that is actually upstream's stated behaviour.
  // Bounded-by-the-source-range is the honest invariant: an average of source
  // values can never leave their span.
  const source = tetBar();
  const bare: MdpaModel = { ...tetBar(), fields: [] };
  const src = source.fields.find((x) => x.variable === "TEMP")!;
  const lo = Math.min(...src.values);
  const hi = Math.max(...src.values);

  const r = await transferFieldModel(bare, source, {});
  const f = r.model.fields.find((x) => x.variable === "TEMP")!;
  for (const v of f.values) {
    assert.ok(v >= lo - 1e-9 && v <= hi + 1e-9, `${v} outside [${lo}, ${hi}]`);
  }
  // It really is smoothed rather than copied — otherwise the constant test
  // above would be the only thing standing between us and a silent no-op.
  const identical = Array.from(f.values).every(
    (v, i) => Math.abs(v - src.values[i]) < 1e-9
  );
  assert.ok(!identical, "nodal transfer averages; it does not resample");
});

test("transferField names a source array that does not exist", async () => {
  await assert.rejects(
    () => transferFieldModel(tetBar(), tetBar(), { arrays: ["NOPE"] }),
    /no field named "NOPE"/
  );
});

test("transferField re-run replaces rather than duplicating", async () => {
  let m: MdpaModel = { ...tetBar(), fields: [] };
  const source = tetBar();
  m = (await transferFieldModel(m, source, {})).model;
  m = (await transferFieldModel(m, source, {})).model;
  assert.equal(m.fields.filter((f) => f.variable === "TEMP").length, 1);
});

test("both two-mesh ops are async-only", () => {
  for (const op of ["sdfDistance", "transferField"] as const) {
    assert.ok(isAsyncOp(op));
    assert.throws(() => applyOp(tetBar(), { op, path: "/x.mdpa" }), /applyOpAsync/);
  }
});
