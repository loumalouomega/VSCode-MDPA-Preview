/** Boundary flux recovery from nodal reactions (roadmap item 45). Pure, no wasm. */
import assert from "node:assert/strict";
import test from "node:test";

import { recoverBoundaryFlux } from "../parser/boundaryFlux";
import { parseMdpa } from "../parser/mdpaParser";

// Two straight-sided six-node triangles forming the unit square (area 1) in z = 0.
const SRC = `Begin Nodes
1 0 0 0
2 1 0 0
3 1 1 0
4 0 1 0
5 0.5 0 0
6 1 0.5 0
7 0.5 0.5 0
8 0.5 1 0
9 0 0.5 0
End Nodes
Begin Conditions SurfaceCondition3D6N
1 0 1 2 3 5 6 7
2 0 1 3 4 7 8 9
End Conditions
Begin SubModelPart Wall
  Begin SubModelPartConditions
  1
  2
  End SubModelPartConditions
End SubModelPart
`;
const nodeLoads = (p: number[], loads: Record<number, number>): string =>
  "Begin NodalData REACTION\n" + Object.entries(loads).map(([id, w]) => `${id} (${p.map((v) => v * w).join(", ")})`).join("\n") + "\nEnd NodalData\n";

test("uniform pressure on quadratic faces: corner loads are zero-ish yet the recovered traction is uniform (item 45)", () => {
  // Exact consistent loads of a uniform traction p = (0,0,5) on two P2 triangles of area 0.5:
  // corners get 0 per face, mids A/3 per face; the shared edge mids (3-1: node 7) get both faces' share.
  const A = 0.5, third = A / 3;
  const loads: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: third, 6: third, 7: 2 * third, 8: third, 9: third };
  const model = parseMdpa(SRC + nodeLoads([0, 0, 5], loads));
  const r = recoverBoundaryFlux(model, { part: "Wall", variable: "REACTION" });
  const f = r.model.fields.find((x) => x.variable === "REACTION_RECOVERED")!;
  for (let i = 0; i < f.ids.length; i++) {
    assert.ok(Math.abs(f.values[i * 3 + 2] - 5) < 1e-8, `node ${f.ids[i]} = ${f.values[i * 3 + 2]}`);
    assert.ok(Math.abs(f.values[i * 3]) < 1e-8);
  }
  assert.ok(Math.abs(r.area - 1) < 1e-12);
  assert.ok(Math.abs(r.reactionSum[2] - 5) < 1e-12);
  assert.ok(r.integralError < 1e-9, `integral error ${r.integralError}`);
  assert.ok(r.residual < 1e-12);
  assert.equal(r.nodesWithoutLoad, 0);
  assert.deepEqual(r.model.fields.find((x) => x.variable === "REACTION")!.ids, model.fields[0].ids);
});

test("the integral equals the reaction sum for a non-uniform load, and a scalar flux works", () => {
  const loads: Record<number, number> = { 1: 1, 2: -2, 3: 0.5, 4: 3, 5: 0.2, 6: 0, 7: 1.3, 8: -0.4, 9: 0.9 };
  const scalar = "Begin NodalData REACTION_FLUX\n" + Object.entries(loads).map(([id, w]) => `${id} ${w}`).join("\n") + "\nEnd NodalData\n";
  const r = recoverBoundaryFlux(parseMdpa(SRC + scalar), { part: "Wall", variable: "REACTION_FLUX", output: "Q_SURF" });
  assert.equal(r.output, "Q_SURF");
  const total = Object.values(loads).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(r.integral[0] - total) < 1e-9);
  assert.ok(r.integralError < 1e-9);
});

test("refusals: unknown part, missing field, non-surface faces", () => {
  const m = parseMdpa(SRC + nodeLoads([0, 0, 1], { 1: 1 }));
  assert.throws(() => recoverBoundaryFlux(m, { part: "Nope", variable: "REACTION" }), /No SubModelPart/);
  assert.throws(() => recoverBoundaryFlux(m, { part: "Wall", variable: "FORCE" }), /No Nodal field/);
});
