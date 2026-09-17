/**
 * Pure unit tests for the shared meshio++ integration/dispatch layer
 * (meshioAdapter.ts). No wasm: these exercise the guards, the flattener and
 * the field-attach postambles in isolation, over hand-built MdpaModels — the
 * real-wasm exercise of the same helpers lives in oracleOps.test.ts (via the
 * ten oracle modules that now call through this layer) and in
 * meshioFidelityRoundTrip.test.ts.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { parseMdpa } from "../parser/mdpaParser";
import {
  meshioCorrespondence,
  flattenMeshioData,
  entityIdsInBlockOrder,
  nodeIdsOf,
  expectCount,
  attachNodalField,
  attachCellField,
  requireNodalSource,
} from "../parser/meshioAdapter";
import { MeshioMesh } from "../parser/meshioConvert";

// A 3x3 grid of quads, one SubModelPart, a Conditions block and a Nodal
// field — small enough to hand-check, varied enough to exercise both id
// spaces (Elements and Conditions).
const MDPA_GRID = `Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 2.0 0.0 0.0
4 0.0 1.0 0.0
5 1.0 1.0 0.0
6 2.0 1.0 0.0
End Nodes

Begin Elements Element2D4N
1 0 1 2 5 4
2 0 2 3 6 5
End Elements

Begin Conditions LineCondition2D2N
1 0 1 4
End Conditions

Begin NodalData TEMPERATURE
1 0 10.0
2 0 20.0
End NodalData

Begin SubModelPart Left
  Begin SubModelPartNodes
  1
  4
  End SubModelPartNodes
  Begin SubModelPartConditions
  1
  End SubModelPartConditions
End SubModelPart
`;

function grid() {
  return parseMdpa(MDPA_GRID);
}

// A minimal fake mesh whose `cells` array can be sized independently of the
// model's own blocks, for exercising the 1:1 correspondence guard.
function fakeMesh(cellCount: number): { cells: unknown[] } {
  return { cells: new Array(cellCount).fill(null) };
}

test("meshioCorrespondence agrees 1:1 for an ordinary two-block model", () => {
  const model = grid();
  const { blocks, cellCount } = meshioCorrespondence(model, fakeMesh(2), "testOp");
  assert.equal(blocks.length, 2); // one Elements block, one Conditions block
  assert.equal(cellCount, 3); // 2 quads + 1 line
});

test("meshioCorrespondence throws by name when the block count disagrees (the fusion case)", () => {
  const model = grid();
  // Two same-named blocks fused in modelToMeshio would leave meshio with
  // fewer cell blocks than the model has EntityBlocks — the exact scenario
  // that silently mislabelled cells in transferField.ts before this guard.
  assert.throws(
    () => meshioCorrespondence(model, fakeMesh(1), "transferField"),
    /transferField saw 1 meshio block\(s\) for 2 mesh block\(s\); the result was discarded\./
  );
});

test("flattenMeshioData converts BigInt64Array elements to numbers", () => {
  const out = flattenMeshioData([new BigInt64Array([7n, 9n]), new BigInt64Array([3n])]);
  assert.deepEqual(out, [7, 9, 3]);
});

test("flattenMeshioData handles Float64Array, Int32Array, plain arrays and undefined uniformly", () => {
  assert.deepEqual(flattenMeshioData([new Float64Array([1.5, 2.5])]), [1.5, 2.5]);
  assert.deepEqual(flattenMeshioData([new Int32Array([1, 2, 3])]), [1, 2, 3]);
  assert.deepEqual(flattenMeshioData([[1, 2], [3]]), [1, 2, 3]);
  assert.deepEqual(flattenMeshioData(undefined), []);
});

test("entityIdsInBlockOrder walks each block's own entityIds, not a global cursor", () => {
  const model = grid();
  const { blocks, cellCount } = meshioCorrespondence(model, fakeMesh(2), "x");
  const ids = entityIdsInBlockOrder(blocks, cellCount);
  // Elements block (ids [1, 2]) first, then the Conditions block (id [1]) —
  // this is the bug errorEstimate.ts had before consolidation: a running
  // cursor read past the first block's entityIds and produced id 0 for every
  // cell past it.
  assert.deepEqual(Array.from(ids), [1, 2, 1]);
});

test("nodeIdsOf returns this model's node ids in nodeIds order", () => {
  const model = grid();
  assert.deepEqual(Array.from(nodeIdsOf(model)), [1, 2, 3, 4, 5, 6]);
});

test("expectCount is a noop when the counts agree", () => {
  assert.doesNotThrow(() => expectCount("smooth", "node", 6, 6));
});

test("expectCount throws naming the op, the kind, and both counts on a mismatch", () => {
  assert.throws(
    () => expectCount("smooth", "node", 5, 6),
    /smooth returned 5 value\(s\) for 6 node\(s\); node order cannot be trusted, so the result was discarded\./
  );
  assert.throws(
    () => expectCount("estimateError", "cell", 2, 3),
    /estimateError returned 2 value\(s\) for 3 cell\(s\); cell order cannot be trusted/
  );
});

test("attachNodalField replaces its own previous output rather than stacking a duplicate", () => {
  const model = grid();
  const ids = nodeIdsOf(model);
  const first = attachNodalField(model, {
    variable: "GRAD",
    components: 1,
    ids,
    values: new Float64Array([1, 2, 3, 4, 5, 6]),
  });
  assert.equal(first.model.fields.filter((f) => f.variable === "GRAD").length, 1);

  const second = attachNodalField(first.model, {
    variable: "GRAD",
    components: 1,
    ids,
    values: new Float64Array([9, 9, 9, 9, 9, 9]),
  });
  const grads = second.model.fields.filter((f) => f.variable === "GRAD");
  assert.equal(grads.length, 1);
  assert.deepEqual(Array.from(grads[0].values), [9, 9, 9, 9, 9, 9]);
});

test("attachNodalField accepts a BigInt64Array-sourced value array via meshioDataToNumbers", () => {
  const model = grid();
  const { field } = attachNodalField(model, {
    variable: "COUNT",
    components: 1,
    ids: nodeIdsOf(model),
    values: new BigInt64Array([1n, 2n, 3n, 4n, 5n, 6n]),
  });
  assert.ok(field.values instanceof Float64Array);
  assert.deepEqual(Array.from(field.values), [1, 2, 3, 4, 5, 6]);
});

test("attachCellField replaces both its own output AND named siblings in one call", () => {
  const model = grid();
  const { blocks, cellCount } = meshioCorrespondence(model, fakeMesh(2), "estimateError");
  const ids = entityIdsInBlockOrder(blocks, cellCount);
  const first = attachCellField(model, {
    kind: "Elemental",
    variable: "ERROR_INDICATOR",
    components: 1,
    ids,
    values: [0.1, 0.2, 0.3],
    alsoReplace: ["ERROR_MARKED"],
  });
  const withMark = attachCellField(first.model, {
    kind: "Elemental",
    variable: "ERROR_MARKED",
    components: 1,
    ids,
    values: [1, 0, 1],
  });
  assert.equal(withMark.model.fields.filter((f) => f.variable === "ERROR_INDICATOR").length, 1);
  assert.equal(withMark.model.fields.filter((f) => f.variable === "ERROR_MARKED").length, 1);

  // Re-running with alsoReplace evicts BOTH the indicator and any stale
  // marking field in one pass, the way errorEstimate.ts relies on when a
  // re-run drops the marking policy back to "none".
  const rerun = attachCellField(withMark.model, {
    kind: "Elemental",
    variable: "ERROR_INDICATOR",
    components: 1,
    ids,
    values: [0.5, 0.5, 0.5],
    alsoReplace: ["ERROR_MARKED"],
  });
  assert.equal(rerun.model.fields.filter((f) => f.variable === "ERROR_MARKED").length, 0);
});

test("requireNodalSource returns the field when it exists and is Nodal", () => {
  const model = grid();
  const f = requireNodalSource(model, "TEMPERATURE", "differentiate");
  assert.equal(f.kind, "Nodal");
  assert.equal(f.variable, "TEMPERATURE");
});

test("requireNodalSource names the field's real kind and points at Average field for a non-Nodal field", () => {
  const model = grid();
  const withElemental = attachCellField(model, {
    kind: "Elemental",
    variable: "STRESS",
    components: 1,
    ids: new Int32Array([1, 2]),
    values: [1, 2],
  }).model;
  assert.throws(
    () => requireNodalSource(withElemental, "STRESS", "differentiate"),
    /"STRESS" is a Elemental field, which is piecewise constant and has no derivative\. Move it to the nodes first with the Average field operation, then differentiate\./
  );
  assert.throws(
    () => requireNodalSource(withElemental, "STRESS", "estimate"),
    /piecewise constant and has no gradient to recover.*Average field operation, then estimate\./
  );
});

test("requireNodalSource reports a genuinely missing field distinctly from a wrong-kind one", () => {
  const model = grid();
  assert.throws(
    () => requireNodalSource(model, "NOPE", "differentiate"),
    /No nodal field named "NOPE"\./
  );
});

// A trivial MeshioDataArray-shaped input is accepted by both functions that
// take one, confirming the adapter's flattener and nodal-attach helper share
// the same conversion contract meshioConvert.ts's meshioDataToNumbers uses.
test("MeshioMesh cell_data shape flattens the same way flattenMeshioData documents", () => {
  const mesh: Pick<MeshioMesh, "cell_data"> = {
    cell_data: { X: [new BigInt64Array([1n]), new BigInt64Array([2n, 3n])] },
  };
  assert.deepEqual(flattenMeshioData(mesh.cell_data!.X), [1, 2, 3]);
});
