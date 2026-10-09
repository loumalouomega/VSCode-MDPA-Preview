/**
 * View-layers sidecar I/O (viewLayersIO.ts + caseFile.ts viewFilePath):
 * round-trips through a temp dir, leaves the mesh file untouched, and
 * tolerates a missing file.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { viewFilePath } from "../problemtype/caseFile";
import { loadViewLayers, saveViewLayers } from "../viewLayersIO";

test("view sidecar lives beside the mesh and round-trips", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "viewlayers-"));
  try {
    const mesh = path.join(dir, "case.mdpa");
    fs.writeFileSync(mesh, "Begin Nodes\nEnd Nodes\n");
    assert.equal(viewFilePath(mesh), path.join(dir, "case.kratosview.json"));
    const missing = loadViewLayers(mesh);
    assert.deepEqual(missing.layers, []);
    const layers = [
      {
        id: "walls",
        name: "walls",
        color: [1, 0, 0] as [number, number, number],
        visible: true,
        locked: false,
        blocks: ["block:Elements:Element2D3N"],
        parts: ["Domain"],
        ids: { Elements: [1, 2], Conditions: [], Geometries: [] },
      },
    ];
    const saved = saveViewLayers(mesh, layers);
    assert.equal(saved.saved, 1);
    const back = loadViewLayers(mesh);
    assert.equal(back.layers.length, 1);
    assert.equal(back.layers[0].name, "walls");
    // The mesh bytes are untouched: only the sidecar was written.
    assert.equal(fs.readFileSync(mesh, "utf8"), "Begin Nodes\nEnd Nodes\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt sidecar degrades to ordinary sections", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "viewlayers-"));
  try {
    const mesh = path.join(dir, "case.mdpa");
    fs.writeFileSync(mesh, "x");
    fs.writeFileSync(viewFilePath(mesh), "not json {");
    const back = loadViewLayers(mesh);
    assert.deepEqual(back.layers, []);
    assert.ok(back.warnings.length > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
