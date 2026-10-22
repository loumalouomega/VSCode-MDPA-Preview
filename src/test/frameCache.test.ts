import { test } from "node:test";
import assert from "node:assert/strict";
import { FrameCache, frameKey, modelBytes } from "../parser/frameCache";
import { finalizeModel } from "../parser/modelBuilder";
import type { MdpaModel } from "../parser/types";

/** A model whose typed-array volume is `nodes * 16` bytes (coords 12 + ids 4). */
function model(nodes: number, withField = false): MdpaModel {
  return finalizeModel({
    nodeCount: nodes,
    coords: new Float32Array(nodes * 3),
    blocks: [],
    fields: withField ? [{ kind: "Nodal", variable: "T", components: 1, ids: new Int32Array(nodes), values: new Float64Array(nodes) }] : [],
    diagnostics: [],
  });
}

test("modelBytes counts coordinates, ids, connectivity, fields and parts", () => {
  assert.equal(modelBytes(model(10)), 10 * 16);
  assert.equal(modelBytes(model(10, true)), 10 * 16 + 10 * 12);
});

test("a hit needs the same key and the same source stamp; a stale entry is dropped", () => {
  const c = new FrameCache(1_000_000);
  const m = model(10);
  c.set("a", "s1", m);
  assert.equal(c.get("a", "s1"), m);
  assert.equal(c.get("a", "s2"), undefined);
  assert.equal(c.size, 0);
  assert.equal(c.bytes, 0);
  assert.equal(c.get("b", "s1"), undefined);
});

test("the least recently used frame is evicted first, by bytes", () => {
  const c = new FrameCache(modelBytes(model(10)) * 2); // room for two
  c.set("a", "s", model(10));
  c.set("b", "s", model(10));
  assert.ok(c.get("a", "s")); // a is now more recent than b
  c.set("c", "s", model(10));
  assert.equal(c.get("b", "s"), undefined);
  assert.ok(c.get("a", "s"));
  assert.ok(c.get("c", "s"));
  assert.ok(c.bytes <= modelBytes(model(10)) * 2);
});

test("a frame larger than the whole budget is never kept, and replacing a key does not double count", () => {
  const c = new FrameCache(500);
  c.set("big", "s", model(1000));
  assert.equal(c.size, 0);
  c.set("a", "s", model(10));
  const once = c.bytes;
  c.set("a", "s", model(10));
  assert.equal(c.bytes, once);
});

test("a zero budget disables the cache and shrinking evicts", () => {
  const c = new FrameCache(0);
  assert.equal(c.enabled, false);
  c.set("a", "s", model(10));
  assert.equal(c.size, 0);
  c.setBudget(10_000);
  assert.equal(c.enabled, true);
  c.set("a", "s", model(10));
  c.set("b", "s", model(10));
  c.setBudget(modelBytes(model(10)));
  assert.equal(c.size, 1);
  c.setBudget(0);
  assert.equal(c.size, 0);
  c.set("a", "s", model(10));
  c.clear();
  assert.equal(c.bytes, 0);
});

test("keys separate files and step selectors", () => {
  assert.notEqual(frameKey("/a.vtu", 1), frameKey("/a.vtu", 2));
  assert.notEqual(frameKey("/a.vtu", 1), frameKey("/b.vtu", 1));
  assert.notEqual(frameKey("/a", "1x"), frameKey("/a1", "x"));
});
