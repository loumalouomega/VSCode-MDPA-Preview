import { test } from "node:test";
import * as assert from "node:assert";
import { prepareNodes } from "../parser/render/displayGeometry";
import type { EntityBlock, MdpaModel } from "../parser/types";
import { blockCentroids, decodeRegionCells } from "../parser/render/hardwareSelection";

// 4 x 2 buffers, written pixel by pixel.
function buffers(width: number, height: number) {
  const n = width * height * 4;
  return { width, height, actor: new Uint8Array(n), low24: new Uint8Array(n), high24: undefined as Uint8Array | undefined };
}
const put = (pass: Uint8Array, w: number, x: number, y: number, v: number, alpha = 255) => {
  const o = (y * w + x) * 4;
  pass[o] = v % 256;
  pass[o + 1] = Math.floor(v / 256) % 256;
  pass[o + 2] = Math.floor(v / 65536) % 256;
  pass[o + 3] = alpha;
};

test("decodes prop and cell per pixel, deduplicating cells", () => {
  const b = buffers(4, 2);
  put(b.actor, 4, 0, 0, 1);
  put(b.low24, 4, 0, 0, 7);
  put(b.actor, 4, 1, 0, 1);
  put(b.low24, 4, 1, 0, 7); // same cell again
  put(b.actor, 4, 2, 1, 2);
  put(b.low24, 4, 2, 1, 300); // needs the second byte
  const r = decodeRegionCells(b, 2);
  assert.deepStrictEqual([...r.get(0)!], [7]);
  assert.deepStrictEqual([...r.get(1)!], [300]);
  assert.strictEqual(r.size, 2);
});

test("empty pixels, unknown props and untagged cells are skipped", () => {
  const b = buffers(3, 1);
  put(b.actor, 3, 0, 0, 0); // no prop
  put(b.actor, 3, 1, 0, 5); // prop 4 of 2
  put(b.low24, 3, 1, 0, 1);
  put(b.actor, 3, 2, 0, 1);
  put(b.low24, 3, 2, 0, 0, 0); // prop covers it but no cell id was written
  assert.strictEqual(decodeRegionCells(b, 2).size, 0);
});

test("the region predicate selects pixels (lower-left origin)", () => {
  const b = buffers(4, 2);
  for (let x = 0; x < 4; x++) {
    put(b.actor, 4, x, 1, 1);
    put(b.low24, 4, x, 1, x);
  }
  const r = decodeRegionCells(b, 1, (x, y) => x >= 2 && y === 1);
  assert.deepStrictEqual([...r.get(0)!].sort(), [2, 3]);
});

test("the high pass extends ids past 24 bits", () => {
  const b = buffers(1, 1);
  b.high24 = new Uint8Array(4);
  put(b.actor, 1, 0, 0, 1);
  put(b.low24, 1, 0, 0, 5);
  put(b.high24, 1, 0, 0, 2);
  assert.deepStrictEqual([...decodeRegionCells(b, 1).get(0)!], [5 + 2 * 16777216]);
});

test("blockCentroids averages a block's own corners; an unknown node gives NaN", () => {
  const model = {
    nodeCount: 4,
    nodeIds: new Int32Array([10, 20, 30, 40]),
    coords: new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0, 4, 4, 4]),
  } as unknown as MdpaModel;
  const block = {
    kind: "Elements",
    name: "b",
    count: 2,
    stride: 3,
    entityIds: new Int32Array([1, 2]),
    connectivity: new Int32Array([10, 20, 30, 10, 20, 99]),
  } as EntityBlock;
  const c = blockCentroids(block, prepareNodes(model));
  assert.ok(Math.abs(c[0] - 2 / 3) < 1e-6 && Math.abs(c[1] - 2 / 3) < 1e-6 && c[2] === 0);
  assert.ok(Number.isNaN(c[3]) && Number.isNaN(c[4]) && Number.isNaN(c[5]));
});
