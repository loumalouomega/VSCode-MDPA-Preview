/**
 * In-preview comparison peer loading (parser/comparePeer.ts): peer files load
 * through the same parser every preview open uses, refusals name the reason,
 * and the sidecar identity is the `view.link` relative-path convention.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { comparePeerRel, loadCompareModel, resolveComparePeer } from "../parser/comparePeer";

const SRC = [
  "Begin Nodes",
  " 1 0.0 0.0 0.0",
  " 2 1.0 0.0 0.0",
  " 3 1.0 1.0 0.0",
  " 4 0.0 1.0 0.0",
  "End Nodes",
  "",
  "Begin Elements Element2D3N",
  " 1 0 1 2 3",
  " 2 0 1 3 4",
  "End Elements",
  "",
].join("\n");

function twoMeshes(): { dir: string; mesh: string; peer: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compare-"));
  const mesh = path.join(dir, "case.mdpa");
  const peer = path.join(dir, "other.mdpa");
  fs.writeFileSync(mesh, SRC);
  fs.writeFileSync(peer, SRC);
  return { dir, mesh, peer };
}

test("a peer file loads with its blocks", async () => {
  const { dir, mesh, peer } = twoMeshes();
  try {
    const loaded = await loadCompareModel(peer, mesh);
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    assert.equal(loaded.model.blocks.length, 1);
    assert.equal(loaded.model.blocks[0].count, 2);
    assert.deepEqual(loaded.warnings, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the open file itself and an unreadable file are refusals, not throws", async () => {
  const { dir, mesh } = twoMeshes();
  try {
    const self = await loadCompareModel(mesh, mesh);
    assert.equal(self.ok, false);
    assert.match((self as { refusal: string }).refusal, /already open here/);
    const missing = await loadCompareModel(path.join(dir, "gone.mdpa"), mesh);
    assert.equal(missing.ok, false);
    assert.match((missing as { refusal: string }).refusal, /Could not read/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the sidecar identity is a posix relative path that resolves back", () => {
  const mesh = path.resolve("/runs/one/case.mdpa");
  const rel = comparePeerRel(mesh, path.resolve("/runs/two/other.mdpa"));
  assert.equal(rel, "../two/other.mdpa");
  assert.equal(resolveComparePeer(mesh, rel), path.resolve("/runs/two/other.mdpa"));
});
