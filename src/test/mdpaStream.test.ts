import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { parseMdpaFile } from "../parser/mdpaParser";

// Resolves from out/test/ -> ../../example/bunny_test_mesh.mdpa
const FIXTURE = path.resolve(__dirname, "../../example/bunny_test_mesh.mdpa");

test("parseMdpaFile: streams local bunny fixture and produces correct node/element counts", async () => {
  const progressCalls: Array<{ bytesRead: number; totalBytes: number }> = [];

  const model = await parseMdpaFile(FIXTURE, (_phase, bytesRead, totalBytes) => {
    progressCalls.push({ bytesRead, totalBytes });
  });

  assert.equal(model.nodeCount, 13707, "nodeCount");
  assert.ok(model.blocks.length > 0, "has blocks");
  const totalEntities = model.blocks.reduce((s, b) => s + b.count, 0);
  assert.ok(totalEntities > 1000, "has entities");
  const unclosed = model.diagnostics.filter((d) => /not closed|Stray/.test(d.message));
  assert.deepEqual(unclosed, [], "no unbalanced blocks");

  // The final onProgress call always fires with bytesRead === totalBytes
  assert.ok(progressCalls.length >= 1, "progress reported at least once");
  const last = progressCalls[progressCalls.length - 1];
  assert.equal(last.bytesRead, last.totalBytes, "final progress reaches 100%");
});

test("parseMdpaFile: works without progress callback", async () => {
  const model = await parseMdpaFile(FIXTURE);
  assert.equal(model.nodeCount, 13707, "nodeCount without callback");
  assert.ok(model.blocks.length > 0, "has blocks without callback");
});

test("parseMdpaFile: rejects on non-existent file", async () => {
  await assert.rejects(
    () => parseMdpaFile("/nonexistent/path/does_not_exist.mdpa"),
    /ENOENT/,
    "should reject with ENOENT"
  );
});
