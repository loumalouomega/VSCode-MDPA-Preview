import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findIsolatedNodeIds, findIsolatedNodeIdsInScope } from "../parser/isolatedNodes";
import { MdpaModel } from "../parser/types";

function makeModel(opts: {
  nodeIds: number[];
  connectivities: number[][];
  smpNodes?: number[];
  strides?: number[];
}): MdpaModel {
  const ids = new Int32Array(opts.nodeIds);
  const coords = new Float32Array(opts.nodeIds.length * 3);
  for (let i = 0; i < opts.nodeIds.length; i++) {
    coords[i * 3] = i;
    coords[i * 3 + 1] = 0;
    coords[i * 3 + 2] = 0;
  }
  return {
    nodeCount: ids.length,
    nodeIds: ids,
    coords,
    blocks: opts.connectivities.map((c, i) => ({
      kind: "Elements" as const,
      name: `Block${i}`,
      count: 1,
      stride: opts.strides?.[i] ?? c.length,
      entityIds: new Int32Array([i + 1]),
      connectivity: new Int32Array(c),
    })),
    subModelParts: (opts.smpNodes ?? []).length
      ? [
          {
            name: "NodesOnly",
            nodeIds: new Int32Array(opts.smpNodes!),
            elementIds: new Int32Array(0),
            conditionIds: new Int32Array(0),
            geometryIds: new Int32Array(0),
            constraintIds: new Int32Array(0),
            path: "NodesOnly",
            children: [],
          },
        ]
      : [],
    meta: [],
    fields: [],
    diagnostics: [],
    is3D: false,
    bounds: { min: [0, 0, 0], max: [1, 0, 0] },
  };
}

describe("findIsolatedNodeIds", () => {
  it("reports nodes referenced by no connectivity", () => {
    const m = makeModel({ nodeIds: [1, 2, 3], connectivities: [[1, 2]] });
    assert.deepEqual(findIsolatedNodeIds(m), [3]);
  });

  it("treats SMP-listed-but-uncelled nodes as isolated (connectivity-only)", () => {
    const m = makeModel({ nodeIds: [1, 2, 3], connectivities: [[1, 2]], smpNodes: [3] });
    assert.deepEqual(findIsolatedNodeIds(m), [3]);
  });

  it("returns [] when every node is used", () => {
    const m = makeModel({ nodeIds: [1, 2], connectivities: [[1, 2]] });
    assert.deepEqual(findIsolatedNodeIds(m), []);
  });

  it("returns all nodes for a cell-less model", () => {
    const m = makeModel({ nodeIds: [5, 6], connectivities: [] });
    assert.deepEqual(findIsolatedNodeIds(m), [5, 6]);
  });
});

describe("findIsolatedNodeIdsInScope", () => {
  it("reports part nodes covered by no part cell even when used globally", () => {
    // Node 3 is used by the main mesh but by no cell of the part.
    const cells = [{ cellType: 5, nodeIds: [1, 2, 3] }];
    assert.deepEqual(findIsolatedNodeIdsInScope([2, 3, 4], cells), [4]);
  });

  it("returns [] when every part node is covered", () => {
    const cells = [{ cellType: 5, nodeIds: [1, 2] }];
    assert.deepEqual(findIsolatedNodeIdsInScope([1, 2], cells), []);
  });

  it("ignores point cells as coverage", () => {
    const cells = [
      { cellType: undefined, nodeIds: [7] },
      { cellType: 5, nodeIds: [1, 2, 3] },
    ];
    assert.deepEqual(findIsolatedNodeIdsInScope([7, 1], cells), [7]);
  });

  it("preserves nodeIds order", () => {
    const cells = [{ cellType: 5, nodeIds: [1] }];
    assert.deepEqual(findIsolatedNodeIdsInScope([9, 3, 1, 5], cells), [9, 3, 5]);
  });
});
