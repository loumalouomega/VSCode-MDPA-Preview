import test from "node:test";
import assert from "node:assert/strict";
import { assembleResult, chunkResult, pathKey } from "../plotChunks";

function roundTrip(result: unknown, size: number) {
  const c = chunkResult(result, size);
  const received = new Map<string, unknown[][]>();
  for (const k of c.chunks) { assert.ok(k.items.length <= size); const key = pathKey(k.path); received.set(key, [...(received.get(key) ?? []), structuredClone(k.items)]); }
  return { c, out: assembleResult(structuredClone(c.head), c.arrays, received) };
}

test("large series arrays are split into bounded chunks and reassembled in order", () => {
  const points = Array.from({ length: 25 }, (_, i) => ({ x: i, y: i * 2 }));
  const result = { id: "r", series: [{ id: "s", points, original: points, extra: 1 }, { id: "t", points: [{ x: 0, y: 0 }], original: [{ x: 0, y: 0 }] }] };
  const { c, out } = roundTrip(result, 10);
  assert.equal(c.chunks.length, 3, "one array, three chunks; the aliased original adds none");
  assert.deepEqual(out.series[0].points, points);
  assert.equal(out.series[0].original, out.series[0].points, "an aliased original stays aliased");
  assert.equal(out.series[0].extra, 1);
  assert.deepEqual(out.series[1], result.series[1], "small arrays travel in the head");
  assert.equal(result.series[0].points.length, 25, "the input is not modified");
});

test("distinct original and tables are chunked independently", () => {
  const rows = Array.from({ length: 12 }, (_, i) => [i, `r${i}`]);
  const origins = rows.map((_, i) => ({ source: "t", rowIndex: i }));
  const { out } = roundTrip({ columns: [], rows, origins, diagnostics: ["d"] }, 5);
  assert.deepEqual(out.rows, rows);
  assert.deepEqual(out.origins, origins);
  assert.deepEqual(out.diagnostics, ["d"]);
  const series = [{ points: rows.map((_, i) => ({ x: i })), original: rows.map((_, i) => ({ x: -i })) }];
  const r2 = roundTrip({ series }, 5).out;
  assert.deepEqual(r2.series[0].original, series[0].original);
  assert.notEqual(r2.series[0].original, r2.series[0].points);
});
