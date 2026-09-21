import { test } from "node:test";
import assert from "node:assert";

import {
  describeEngineState,
  formatCoord,
  formatFrame,
  formatModelCounts,
  formatPick,
  groupDigits,
  initialEngineState,
  isEngineState,
  reduceEngineState,
  unsavedEditCount,
  unsavedEditsLabel,
} from "../statusStats";

test("digits are grouped with a fixed en-US locale", () => {
  assert.strictEqual(groupDigits(12345), "12,345");
  assert.strictEqual(groupDigits(1234567), "1,234,567");
  assert.strictEqual(groupDigits(0), "0");
});

test("model counts read as facts and drop what is absent", () => {
  assert.strictEqual(
    formatModelCounts({ nodes: 12345, elements: 6789, conditions: 42 }),
    "12,345 nodes · 6,789 elements · 42 conditions"
  );
  // Singulars, and no "0 conditions" clause.
  assert.strictEqual(formatModelCounts({ nodes: 1, elements: 1, conditions: 0 }), "1 node · 1 element");
  assert.strictEqual(
    formatModelCounts({ nodes: 8, elements: 0, conditions: 0, geometries: 3 }),
    "8 nodes · 3 geometries"
  );
  // An empty model collapses the cell.
  assert.strictEqual(formatModelCounts({ nodes: 0, elements: 0, conditions: 0 }), "");
  assert.strictEqual(formatModelCounts({ nodes: NaN, elements: 5, conditions: 0 }), "5 elements");
});

test("the frame cell exists only for a real timeline", () => {
  assert.strictEqual(formatFrame(2, 12, "0.25"), "frame 3 / 12 · step 0.25");
  assert.strictEqual(formatFrame(0, 12, ""), "frame 1 / 12");
  assert.strictEqual(formatFrame(0, 12, "   "), "frame 1 / 12");
  assert.strictEqual(formatFrame(0, 1, "0"), "");
  assert.strictEqual(formatFrame(0, 0), "");
  assert.strictEqual(formatFrame(NaN, 5), "");
  // Out-of-range indices clamp instead of reading "frame 13 / 12".
  assert.strictEqual(formatFrame(99, 12), "frame 12 / 12");
  assert.strictEqual(formatFrame(-3, 12), "frame 1 / 12");
  assert.strictEqual(formatFrame(1199, 1200, "5"), "frame 1,200 / 1,200 · step 5");
});

test("coordinates are short, paste-friendly and never signed zero", () => {
  assert.strictEqual(formatCoord(0), "0");
  assert.strictEqual(formatCoord(-0), "0");
  assert.strictEqual(formatCoord(1), "1");
  assert.strictEqual(formatCoord(0.123456789), "0.12346");
  assert.strictEqual(formatCoord(-142.06789), "-142.07");
  assert.strictEqual(formatCoord(1234567), "1234600");
  assert.strictEqual(formatCoord(Infinity), "0");
});

test("the pick cell names the entity, its block and the nearest node", () => {
  assert.strictEqual(formatPick(undefined), "");
  assert.strictEqual(formatPick({}), "");
  assert.strictEqual(
    formatPick({
      entity: { kind: "Element", id: 45, blockName: "Triangle2D3" },
      node: { id: 123, coords: [0.5, 1, -2] },
    }),
    "element 45 · Triangle2D3 · node 123 (0.5, 1, -2)"
  );
  assert.strictEqual(formatPick({ node: { id: 1234, coords: [0, 0, 0] } }), "node 1234 (0, 0, 0)");
  assert.strictEqual(formatPick({ entity: { kind: "Condition", id: 7 } }), "condition 7");
});

test("the unsaved-edits label is a count, empty when there is none", () => {
  assert.strictEqual(unsavedEditsLabel(0), "");
  assert.strictEqual(unsavedEditsLabel(-2), "");
  assert.strictEqual(unsavedEditsLabel(NaN), "");
  assert.strictEqual(unsavedEditsLabel(1), "1 unsaved edit");
  assert.strictEqual(unsavedEditsLabel(3), "3 unsaved edits");
  assert.strictEqual(unsavedEditsLabel(2.9), "2 unsaved edits");
});

test("unsaved edits are the ops past the common prefix, by identity", () => {
  const a = { op: "a" };
  const b = { op: "b" };
  const c = { op: "c" };
  assert.strictEqual(unsavedEditCount([], []), 0);
  // Nothing saved yet: every applied op is unsaved (a restored recipe, fresh edits).
  assert.strictEqual(unsavedEditCount([a, b], []), 2);
  // Saved at [a, b]: clean while the stack matches...
  assert.strictEqual(unsavedEditCount([a, b], [a, b]), 0);
  // ...one more op is one unsaved edit...
  assert.strictEqual(unsavedEditCount([a, b, c], [a, b]), 1);
  // ...undo back to the save point is clean again...
  assert.strictEqual(unsavedEditCount([a, b], [a, b]), 0);
  // ...undo past it: the file holds an op the view no longer shows.
  assert.strictEqual(unsavedEditCount([a], [a, b]), 1);
  assert.strictEqual(unsavedEditCount([], [a, b]), 2);
  // A different op after an undo: one removed + one added, and an equal-looking
  // record with another identity is NOT the saved one.
  assert.strictEqual(unsavedEditCount([a, { op: "b" }], [a, b]), 2);
});

test("engine state starts idle and describes itself as such", () => {
  const s = initialEngineState();
  assert.deepStrictEqual(describeEngineState(s), { text: "Engines idle", tone: "idle" });
});

test("a start loads an idle engine, a success readies it, a failure cools a loading one", () => {
  let s = initialEngineState();
  s = reduceEngineState(s, { type: "start", engine: "mmg" });
  assert.strictEqual(s.mmg, "loading");
  assert.deepStrictEqual(describeEngineState(s), { text: "MMG loading…", tone: "loading" });
  s = reduceEngineState(s, { type: "success", engine: "mmg" });
  assert.strictEqual(s.mmg, "ready");
  assert.deepStrictEqual(describeEngineState(s), { text: "MMG ready", tone: "ready" });

  const failed = reduceEngineState(reduceEngineState(initialEngineState(), { type: "start", engine: "meshio" }), {
    type: "failure",
    engine: "meshio",
  });
  assert.strictEqual(failed.meshio, "idle");
});

test("a warm engine is never demoted, and a late failure does not undo a success", () => {
  let s = reduceEngineState(initialEngineState(), { type: "success", engine: "meshio" });
  const afterStart = reduceEngineState(s, { type: "start", engine: "meshio" });
  assert.strictEqual(afterStart, s, "start on a ready engine returns the same object");
  const afterFail = reduceEngineState(s, { type: "failure", engine: "meshio" });
  assert.strictEqual(afterFail.meshio, "ready");
  s = afterFail;
  assert.strictEqual(reduceEngineState(s, { type: "success", engine: "meshio" }), s);
});

test("the description lists only non-idle engines in display order", () => {
  let s = initialEngineState();
  s = reduceEngineState(s, { type: "start", engine: "pyodide" });
  s = reduceEngineState(s, { type: "success", engine: "meshio" });
  s = reduceEngineState(s, { type: "start", engine: "mmg" });
  assert.deepStrictEqual(describeEngineState(s), {
    text: "meshio++ ready · MMG loading… · Pyodide loading…",
    tone: "loading",
  });
  s = reduceEngineState(reduceEngineState(s, { type: "success", engine: "mmg" }), {
    type: "success",
    engine: "pyodide",
  });
  assert.strictEqual(describeEngineState(s).tone, "ready");
});

test("isEngineState accepts the wire shape and nothing else", () => {
  assert.ok(isEngineState(initialEngineState()));
  assert.ok(!isEngineState(undefined));
  assert.ok(!isEngineState({ meshio: "idle", mmg: "idle" }));
  assert.ok(!isEngineState({ meshio: "idle", mmg: "idle", pyodide: "busy" }));
});
