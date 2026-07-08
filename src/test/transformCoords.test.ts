import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { scaleCoords, translateCoords, rotateCoords } from "../parser/transformCoords";

const SRC = `Begin Nodes
1 0.0 0.0 0.0
2 2.0 0.0 0.0
3 2.0 4.0 0.0
End Nodes

Begin Elements Element2D3N
1 1 1 2 3
End Elements
`;

const coordOf = (m: ReturnType<typeof parseMdpa>, id: number): [number, number, number] => {
  const i = [...m.nodeIds].indexOf(id);
  return [m.coords[i * 3], m.coords[i * 3 + 1], m.coords[i * 3 + 2]];
};

test("scaleCoords scales per axis and recomputes bounds", () => {
  const m = parseMdpa(SRC);
  const out = scaleCoords(m, 0.5, 2, 1);
  assert.deepEqual(coordOf(out, 3), [1, 8, 0]); // (2,4,0) → (1,8,0)
  assert.deepEqual(out.bounds.min, [0, 0, 0]);
  assert.deepEqual(out.bounds.max, [1, 8, 0]);
});

test("translateCoords shifts every node", () => {
  const m = parseMdpa(SRC);
  const out = translateCoords(m, 1, 2, 3);
  assert.deepEqual(coordOf(out, 1), [1, 2, 3]);
  assert.deepEqual(coordOf(out, 2), [3, 2, 3]);
  assert.deepEqual(out.bounds.max, [3, 6, 3]);
});

test("rotateCoords rotates about the Z axis (90°)", () => {
  const m = parseMdpa(SRC);
  const out = rotateCoords(m, "z", 90);
  // node 2 (2,0,0) → (0,2,0)
  const [x, y, z] = coordOf(out, 2);
  assert.ok(Math.abs(x) < 1e-6 && Math.abs(y - 2) < 1e-6 && Math.abs(z) < 1e-6);
});

test("rotateCoords about X and Y axes", () => {
  const m = parseMdpa(`Begin Nodes
1 1.0 0.0 0.0
2 0.0 1.0 0.0
3 0.0 0.0 1.0
End Nodes
`);
  const rx = rotateCoords(m, "x", 90); // (0,1,0) → (0,0,1)
  const p = coordOf(rx, 2);
  assert.ok(Math.abs(p[0]) < 1e-6 && Math.abs(p[1]) < 1e-6 && Math.abs(p[2] - 1) < 1e-6);

  const ry = rotateCoords(m, "y", 90); // (0,0,1) → (1,0,0)
  const q = coordOf(ry, 3);
  assert.ok(Math.abs(q[0] - 1) < 1e-6 && Math.abs(q[1]) < 1e-6 && Math.abs(q[2]) < 1e-6);
});

test("transforms do not mutate the input model", () => {
  const m = parseMdpa(SRC);
  const before = [...m.coords];
  scaleCoords(m, 10, 10, 10);
  translateCoords(m, 5, 5, 5);
  rotateCoords(m, "z", 45);
  assert.deepEqual([...m.coords], before);
});
