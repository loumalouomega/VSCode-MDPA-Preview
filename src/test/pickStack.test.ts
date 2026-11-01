import { test } from "node:test";
import assert from "node:assert/strict";
import { cycleIndex, withinPickRadius, pickStackLabel, stepDirection } from "../parser/pickStack";

test("cycleIndex wraps both ways and tolerates empty stacks", () => {
  assert.equal(cycleIndex(0, 3, 1), 1);
  assert.equal(cycleIndex(2, 3, 1), 0);
  assert.equal(cycleIndex(0, 3, -1), 2);
  assert.equal(cycleIndex(0, 0, 1), 0);
});
test("withinPickRadius", () => {
  assert.ok(withinPickRadius(10, 10, 12, 12));
  assert.ok(!withinPickRadius(10, 10, 20, 10));
});
test("label and keys", () => {
  assert.equal(pickStackLabel(1, 3), "2 of 3 under the cursor");
  assert.equal(stepDirection("ArrowDown"), 1);
  assert.equal(stepDirection("ArrowUp"), -1);
  assert.equal(stepDirection("a"), undefined);
});
