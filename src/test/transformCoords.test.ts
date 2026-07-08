import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { transformCoords } from "../parser/transformCoords";

const SRC = `Begin Nodes
1 0.0 0.0 0.0
2 2.0 0.0 0.0
3 2.0 4.0 0.0
End Nodes

Begin Elements Element2D3N
1 1 1 2 3
End Elements
`;

test("scales and translates every node and recomputes bounds", () => {
  const m = parseMdpa(SRC);
  const out = transformCoords(m, { scale: 0.5, dx: 1, dy: 2, dz: 3 });
  // node 2 (2,0,0) → (2*0.5+1, 0+2, 0+3) = (2,2,3)
  const i2 = [...out.nodeIds].indexOf(2);
  assert.deepEqual(
    [out.coords[i2 * 3], out.coords[i2 * 3 + 1], out.coords[i2 * 3 + 2]],
    [2, 2, 3]
  );
  // node 3 (2,4,0) → (2,4,3); node 1 (0,0,0) → (1,2,3)
  assert.deepEqual(out.bounds.min, [1, 2, 3]);
  assert.deepEqual(out.bounds.max, [2, 4, 3]);
});

test("identity transform leaves coordinates unchanged", () => {
  const m = parseMdpa(SRC);
  const out = transformCoords(m, { scale: 1, dx: 0, dy: 0, dz: 0 });
  assert.deepEqual([...out.coords], [...m.coords]);
});

test("does not mutate the input model", () => {
  const m = parseMdpa(SRC);
  const before = [...m.coords];
  transformCoords(m, { scale: 10, dx: 1, dy: 1, dz: 1 });
  assert.deepEqual([...m.coords], before);
});
