import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OpQueue,
  isStagableOp,
  labelOp,
  parseEditedOp,
  summarizeOp,
} from "../parser/opQueueCore";

test("staging labels and summarizes each step", () => {
  const q = new OpQueue();
  assert.equal(q.stage({ type: "applyOp", op: "translate", dx: 1, dy: 0, dz: 0 }), true);
  assert.equal(q.stage({ op: "removeOrphanNodes" }), true);
  assert.equal(q.stage("nope" as unknown as Record<string, unknown>), false);
  assert.equal(q.stage({ noOp: true }), false);
  assert.equal(q.length, 2);
  const rows = q.rows();
  assert.ok(rows[0].label.length > 0);
  assert.equal(rows[0].summary, "dx: 1, dy: 0, dz: 0");
  assert.equal(rows[1].summary, "");
});

test("move reorders and reports the landing index", () => {
  const q = new OpQueue();
  q.stage({ op: "a" });
  q.stage({ op: "b" });
  q.stage({ op: "c" });
  assert.equal(q.move(0, 1), 1);
  assert.deepEqual(q.messages().map((m) => m.op), ["b", "a", "c"]);
  assert.equal(q.move(2, 1), -1); // clamped: no-op
  assert.equal(q.move(0, -1), -1); // clamped: no-op
  assert.equal(q.move(9, 1), -1); // out of range: no-op
  assert.deepEqual(q.messages().map((m) => m.op), ["b", "a", "c"]);
  assert.equal(q.move(2, -1), 1);
  assert.deepEqual(q.messages().map((m) => m.op), ["b", "c", "a"]);
});

test("remove and clear drop steps", () => {
  const q = new OpQueue();
  q.stage({ op: "a" });
  q.stage({ op: "b" });
  q.remove(5);
  assert.equal(q.length, 2);
  q.remove(0);
  assert.deepEqual(q.messages().map((m) => m.op), ["b"]);
  q.clear();
  assert.equal(q.length, 0);
});

test("update replaces a step or reports the error", () => {
  const q = new OpQueue();
  q.stage({ op: "scale", sx: 1, sy: 1, sz: 1 });
  assert.deepEqual(q.update(4, "{}"), { ok: false, error: "No such step." });
  assert.deepEqual(q.update(0, "nope"), { ok: false, error: "Not valid JSON." });
  assert.deepEqual(q.update(0, "[1]"), { ok: false, error: 'Must be an object with a string "op" field.' });
  assert.deepEqual(q.update(0, '{"op":"translate","dx":2}'), { ok: true });
  assert.deepEqual(q.messages(), [{ op: "translate", dx: 2 }]);
});

test("stageAll appends only stagable records and counts them", () => {
  const q = new OpQueue();
  q.stage({ op: "a" });
  assert.equal(q.stageAll([{ op: "b" }, 42, { nope: 1 }, { op: "c" }] as unknown[]), 2);
  assert.deepEqual(q.messages().map((m) => m.op), ["a", "b", "c"]);
});

test("takeBatch folds and clears; empty is undefined", () => {
  const q = new OpQueue();
  assert.equal(q.takeBatch(), undefined);
  q.stage({ op: "a" });
  q.stage({ op: "b" });
  assert.deepEqual(q.takeBatch(), { type: "applyBatch", ops: [{ op: "a" }, { op: "b" }] });
  assert.equal(q.length, 0);
});

test("label and summary helpers degrade gracefully", () => {
  assert.equal(labelOp({}), "");
  assert.equal(labelOp({ op: "translate" }).length > 0, true);
  assert.equal(summarizeOp({ op: "x", paths: ["a", "b"], name: "ok", skip: "this string is way too long" }), "paths: 2, name: ok");
  assert.equal(isStagableOp([]), false);
  assert.equal(isStagableOp(null), false);
  assert.equal(parseEditedOp("{}").error, 'Must be an object with a string "op" field.');
});
