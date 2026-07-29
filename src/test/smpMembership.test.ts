import { test } from "node:test";
import assert from "node:assert";
import { buildMembershipIndex } from "../parser/smpMembership";
import { SubModelPart } from "../parser/types";

function part(overrides: Partial<SubModelPart>): SubModelPart {
  return {
    name: overrides.name ?? "Part",
    nodeIds: Int32Array.from([]),
    elementIds: Int32Array.from([]),
    conditionIds: Int32Array.from([]),
    geometryIds: Int32Array.from([]),
    constraintIds: Int32Array.from([]),
    path: overrides.path ?? overrides.name ?? "Part",
    children: [],
    ...overrides,
  };
}

test("buildMembershipIndex: a top-level part's entities map to its path", () => {
  const parts = [
    part({ name: "Fixed", path: "Fixed", nodeIds: Int32Array.from([1, 2]), elementIds: Int32Array.from([10]) }),
  ];
  const idx = buildMembershipIndex(parts);
  assert.deepStrictEqual(idx.nodes.get(1), ["Fixed"]);
  assert.deepStrictEqual(idx.nodes.get(2), ["Fixed"]);
  assert.deepStrictEqual(idx.elements.get(10), ["Fixed"]);
  assert.strictEqual(idx.conditions.get(10), undefined);
});

test("buildMembershipIndex: nested children contribute their own (deeper) path", () => {
  const child = part({ name: "Inner", path: "Outer/Inner", nodeIds: Int32Array.from([5]) });
  const outer = part({ name: "Outer", path: "Outer", nodeIds: Int32Array.from([5]), children: [child] });
  const idx = buildMembershipIndex([outer]);
  // Node 5 belongs to both the parent and the child part.
  assert.deepStrictEqual(idx.nodes.get(5), ["Outer", "Outer/Inner"]);
});

test("buildMembershipIndex: an id shared by two sibling parts lists both paths", () => {
  const a = part({ name: "A", path: "A", elementIds: Int32Array.from([7]) });
  const b = part({ name: "B", path: "B", elementIds: Int32Array.from([7]) });
  const idx = buildMembershipIndex([a, b]);
  assert.deepStrictEqual(idx.elements.get(7), ["A", "B"]);
});

test("buildMembershipIndex: empty model yields empty maps", () => {
  const idx = buildMembershipIndex([]);
  assert.strictEqual(idx.nodes.size, 0);
  assert.strictEqual(idx.elements.size, 0);
  assert.strictEqual(idx.conditions.size, 0);
  assert.strictEqual(idx.geometries.size, 0);
});

test("buildMembershipIndex: geometries and conditions tracked independently", () => {
  const parts = [
    part({ name: "G", path: "G", geometryIds: Int32Array.from([3]) }),
    part({ name: "C", path: "C", conditionIds: Int32Array.from([3]) }),
  ];
  const idx = buildMembershipIndex(parts);
  assert.deepStrictEqual(idx.geometries.get(3), ["G"]);
  assert.deepStrictEqual(idx.conditions.get(3), ["C"]);
});
