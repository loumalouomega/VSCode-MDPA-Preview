import { test } from "node:test";
import assert from "node:assert";
import {
  nearestPointLocal,
  resolveEntity,
  resolveNode,
  resolvePick,
  PickMaps,
} from "../parser/pickResolve";

function coordsTable(points: [number, number, number][]) {
  return (localId: number): [number, number, number] | undefined => points[localId];
}

test("nearestPointLocal: picks the closest candidate by squared distance", () => {
  const coordsOf = coordsTable([[0, 0, 0], [10, 0, 0], [4, 0, 0]]);
  const best = nearestPointLocal([0, 1, 2], coordsOf, [5, 0, 0]);
  assert.strictEqual(best, 2); // (4,0,0) is closer to (5,0,0) than (0,0,0) or (10,0,0)
});

test("nearestPointLocal: skips candidates with no coordinates", () => {
  const coordsOf = (localId: number): [number, number, number] | undefined =>
    localId === 1 ? undefined : [localId, 0, 0];
  const best = nearestPointLocal([1, 2], coordsOf, [2, 0, 0]);
  assert.strictEqual(best, 2);
});

test("nearestPointLocal: undefined for an empty or fully-missing candidate list", () => {
  assert.strictEqual(nearestPointLocal([], coordsTable([]), [0, 0, 0]), undefined);
  const coordsOf = () => undefined;
  assert.strictEqual(nearestPointLocal([0, 1], coordsOf, [0, 0, 0]), undefined);
});

test("resolveEntity: maps a cell id to its owning entity, -1 and out-of-range → undefined", () => {
  const maps: PickMaps = {
    pointGlobalIds: Int32Array.from([]),
    cellEntityIds: Int32Array.from([10, -1, 30]),
  };
  assert.strictEqual(resolveEntity(maps, 0), 10);
  assert.strictEqual(resolveEntity(maps, 1), undefined);
  assert.strictEqual(resolveEntity(maps, 2), 30);
  assert.strictEqual(resolveEntity(maps, 3), undefined);
  assert.strictEqual(resolveEntity(maps, -1), undefined);
});

test("resolveNode: maps a local point index to its global node id", () => {
  const maps: PickMaps = {
    pointGlobalIds: Int32Array.from([101, 102, 103]),
    cellEntityIds: Int32Array.from([]),
  };
  assert.strictEqual(resolveNode(maps, 1), 102);
  assert.strictEqual(resolveNode(maps, 5), undefined);
  assert.strictEqual(resolveNode(maps, -1), undefined);
});

test("resolvePick: end-to-end — entity id + nearest corner's global node id", () => {
  const maps: PickMaps = {
    pointGlobalIds: Int32Array.from([1, 2, 3, 4]), // local 0..3 -> global node ids
    cellEntityIds: Int32Array.from([50]), // one cell (a quad), entity id 50
  };
  // Quad corners at local ids 0..3, forming a unit square.
  const coordsOf = coordsTable([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]]);
  const result = resolvePick(maps, 0, [0, 1, 2, 3], coordsOf, [0.9, 0.9, 0]);
  assert.strictEqual(result.entityId, 50);
  assert.strictEqual(result.nodeId, 3); // local 2 (1,1,0) -> global node id 3
});

test("resolvePick: entity-less cell (-1) still resolves the nearest node", () => {
  const maps: PickMaps = {
    pointGlobalIds: Int32Array.from([7, 8]),
    cellEntityIds: Int32Array.from([-1]),
  };
  const coordsOf = coordsTable([[0, 0, 0], [1, 0, 0]]);
  const result = resolvePick(maps, 0, [0, 1], coordsOf, [0.9, 0, 0]);
  assert.strictEqual(result.entityId, undefined);
  assert.strictEqual(result.nodeId, 8);
});
