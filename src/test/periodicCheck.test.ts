/** Periodic pairs checked against the mesh: the translation runs from the master to the slave, a mismatch says so, and Generate refuses it. */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { periodicPairProblems, ransPeriodicIdProblems } from "../problemtype/periodicCheck";
import { generateCase } from "../problemtype/generate";
import { defaultCaseState } from "../problemtype/api";
import { fluid } from "../problemtype/builtins/fluid";
import { rans } from "../problemtype/builtins/rans";
import type { Assignment } from "../problemtype/types";

/** A 1 x 1 x 1 box of one tetrahedron plus a Bottom and a Top face of nodes, 1 m apart in y. */
const MDPA = `Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 0.0 1.0
4 1.0 0.0 1.0
5 0.0 1.0 0.0
6 1.0 1.0 0.0
7 0.0 1.0 1.0
8 1.0 1.0 1.0
End Nodes

Begin Elements Element3D4N
1 0 1 2 3 5
End Elements

Begin SubModelPart Parts
  Begin SubModelPartNodes
  1
  2
  3
  5
  End SubModelPartNodes
  Begin SubModelPartElements
  1
  End SubModelPartElements
End SubModelPart

Begin SubModelPart Bottom
  Begin SubModelPartNodes
  1
  2
  3
  4
  End SubModelPartNodes
End SubModelPart

Begin SubModelPart Top
  Begin SubModelPartNodes
  5
  6
  7
  8
  End SubModelPartNodes
End SubModelPart

Begin SubModelPart Short
  Begin SubModelPartNodes
  5
  6
  End SubModelPartNodes
End SubModelPart
`;

const model = parseMdpa(MDPA);
const periodic = (smpPath: string, values: Record<string, unknown>): Assignment => ({ conditionId: "periodic", smpPath, values: values as Assignment["values"] });

test("a pair whose master moved by the translation lands on the slave passes", () => {
  // The slave (Bottom, y = 0) is the master (Top, y = 1) moved by -1 in y: the translation runs from the master to the slave.
  assert.deepEqual(periodicPairProblems(model, [periodic("Bottom", { master: "Top", translation: [0, -1, 0], magnitude: 1 })]), []);
  // Direction is normalized; the magnitude carries the distance.
  assert.deepEqual(periodicPairProblems(model, [periodic("Bottom", { master: "Top", translation: [0, -5, 0], magnitude: 1 })]), []);
});

test("the reversed direction is refused, and the message says reversing it fixes it", () => {
  const out = periodicPairProblems(model, [periodic("Bottom", { master: "Top", translation: [0, 1, 0], magnitude: 1 })]);
  assert.equal(out.length, 1);
  assert.match(out[0], /"Bottom"/);
  assert.match(out[0], /4 of 4 slave node\(s\) have no master node at that distance/);
  assert.match(out[0], /silently apply no pairing/);
  assert.match(out[0], /match when the direction is reversed/);
});

test("a wrong distance is refused without the reversal hint", () => {
  const out = periodicPairProblems(model, [periodic("Bottom", { master: "Top", translation: [0, -1, 0], magnitude: 2 })]);
  assert.equal(out.length, 1);
  assert.ok(!/reversed/.test(out[0]), out[0]);
});

test("the pairing must be one node to one node", () => {
  // Short's two nodes map onto Top's, but Top has four: the slave is matched, the master is not.
  const more = periodicPairProblems(model, [periodic("Short", { master: "Top", translation: [1, 0, 0], magnitude: 0 })]);
  assert.equal(more.length, 1);
  assert.match(more[0], /the master has 4; the pairing must be one node to one node/);
  // The other way round, two of the four slave nodes have no master.
  const fewer = periodicPairProblems(model, [periodic("Top", { master: "Short", translation: [1, 0, 0], magnitude: 0 })]);
  assert.equal(fewer.length, 1);
  assert.match(fewer[0], /2 of 4 slave node\(s\) have no master node/);
});

test("a zero direction is named; parts the mesh lacks, no master and no assignment are left to other checks", () => {
  assert.match(periodicPairProblems(model, [periodic("Bottom", { master: "Top", translation: [0, 0, 0], magnitude: 1 })])[0], /zero translation direction/);
  assert.deepEqual(periodicPairProblems(model, [periodic("Missing", { master: "Top", translation: [0, -1, 0] })]), []);
  assert.deepEqual(periodicPairProblems(model, [periodic("Bottom", { master: "Nowhere", translation: [0, -1, 0] })]), []);
  assert.deepEqual(periodicPairProblems(model, [periodic("Bottom", { translation: [0, -1, 0] })]), []);
  assert.deepEqual(periodicPairProblems(model, [periodic("Bottom", { master: "Bottom", translation: [0, -1, 0] })]), []);
  assert.deepEqual(periodicPairProblems(model, []), []);
});

test("a pair is matched at the precision the model stores", () => {
  // Coordinates are single precision: a master a hair off the exact translation still matches.
  const fuzzy = parseMdpa(MDPA.replace("5 0.0 1.0 0.0", "5 0.0 1.0000001 0.0").replace("1 0.0 0.0 0.0", "1 0.0 0.0000001 0.0"));
  assert.deepEqual(periodicPairProblems(fuzzy, [periodic("Bottom", { master: "Top", translation: [0, -1, 0], magnitude: 1 })]), []);
});

test("Generate refuses an unmatched pair for the Fluid and the RANS problemtypes, and accepts the matched one", async () => {
  for (const [name, decl, lawId] of [["fluid", fluid.decl, "newtonian_3d"], ["rans", rans.decl, "rans_newtonian_3d"]] as const) {
    const build = async (translation: number[]): Promise<unknown> => {
      const s = defaultCaseState(decl);
      Object.assign(s.values.problem, { considerPeriodic: true });
      s.assignments = [
        { conditionId: "parts", smpPath: "Parts", values: {} },
        ...(name === "rans" ? [{ conditionId: "ransWall", smpPath: "Short", values: {} } as Assignment] : []),
        periodic("Bottom", { master: "Top", translation, magnitude: 1 }),
      ];
      s.materials = [{ smpPath: "Parts", lawId, values: {} }, ...(name === "rans" ? [{ smpPath: "Short", lawId: "rans_wall", values: {} }] : [])];
      return generateCase(name === "rans" ? rans : fluid, model, s, "case");
    };
    await assert.rejects(build([0, 1, 0]), /periodic boundary "Bottom"[\s\S]*reversed/, name);
    await assert.doesNotReject(build([0, -1, 0]), name);
  }
});

/**
 * The mesh above with surface conditions: a Wall part of four facets (the solver's skin, k = 4) and one facet on each of
 * Bottom and Top (the pair), whose ids the caller chooses. m = 3 slave nodes (the Bottom facet's), so the formulation numbers 5..7.
 */
function withConditions(pairIds: [number, number]): ReturnType<typeof parseMdpa> {
  const conditions = [
    "1 0 1 2 3", "2 0 1 2 5", "3 0 2 3 5", "4 0 1 3 5",
    `${pairIds[0]} 0 1 2 4`, `${pairIds[1]} 0 5 6 7`,
  ].join("\n");
  const parts = (name: string, ids: number[]): string =>
    `Begin SubModelPart ${name}\n  Begin SubModelPartConditions\n${ids.map((i) => `  ${i}`).join("\n")}\n  End SubModelPartConditions\nEnd SubModelPart\n`;
  const body = MDPA.replace(/Begin SubModelPart Bottom[\s\S]*$/, "");
  return parseMdpa(
    `${body}Begin Conditions SurfaceCondition3D3N\n${conditions}\nEnd Conditions\n` +
      parts("Wall", [1, 2, 3, 4]) + parts("Bottom", [pairIds[0]]) + parts("Top", [pairIds[1]])
  );
}

test("RANS periodic: condition ids in the range the formulation reuses are named, a numbering with room passes", () => {
  const assign = [periodic("Bottom", { master: "Top", translation: [0, -1, 0], magnitude: 1 })];
  // Contiguous ids 1..6: the formulation's 5..7 meet the pair's own facets 5 and 6.
  const contiguous = ransPeriodicIdProblems(withConditions([5, 6]), assign, ["Wall"]);
  assert.equal(contiguous.length, 1);
  assert.match(contiguous[0], /numbers the 3 periodic condition\(s\) it creates 5–7/);
  assert.match(contiguous[0], /the 4 condition\(s\) of the skin parts/);
  assert.match(contiguous[0], /already has condition id\(s\) 5, 6 there/);
  assert.match(contiguous[0], /a condition with the same Id already exists/);
  // The pair's facets far above the skin leave 5..7 free and the largest id past them: this is what ran.
  assert.deepEqual(ransPeriodicIdProblems(withConditions([1001, 1002]), assign, ["Wall"]), []);
  // Nothing in the range, but the largest id is too small: the process's own conditions get 5..8 (m = 4 here) too.
  const low = ransPeriodicIdProblems(parseMdpa(MDPA.replace(/Begin SubModelPart Bottom[\s\S]*$/, "") +
    "Begin Conditions SurfaceCondition3D3N\n1 0 1 2 3\n2 0 1 2 5\n3 0 2 3 5\n4 0 1 3 5\nEnd Conditions\n" +
    "Begin SubModelPart Wall\n  Begin SubModelPartConditions\n  1\n  2\n  3\n  4\n  End SubModelPartConditions\nEnd SubModelPart\n" +
    "Begin SubModelPart Bottom\n  Begin SubModelPartNodes\n  1\n  2\n  3\n  4\n  End SubModelPartNodes\nEnd SubModelPart\n"), assign, ["Wall"]);
  assert.equal(low.length, 1);
  assert.match(low[0], /largest condition id is only 4/);
  // No periodic assignment, no check.
  assert.deepEqual(ransPeriodicIdProblems(withConditions([5, 6]), [], ["Wall"]), []);
});
