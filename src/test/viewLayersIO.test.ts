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

test("outline settings persist and a layers-only save keeps them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "viewlayers-"));
  try {
    const mesh = path.join(dir, "case.mdpa");
    fs.writeFileSync(mesh, "Begin Nodes\nEnd Nodes\n");
    assert.equal(loadViewLayers(mesh).outline, undefined);
    saveViewLayers(mesh, [], { flattenSubModelParts: true });
    assert.deepEqual(loadViewLayers(mesh).outline, { flattenSubModelParts: true });
    // A caller that supplies no outline must not erase the stored one.
    saveViewLayers(mesh, []);
    assert.deepEqual(loadViewLayers(mesh).outline, { flattenSubModelParts: true });
    // An explicit value replaces it, and a malformed one is sanitised.
    saveViewLayers(mesh, [], { flattenSubModelParts: false });
    assert.deepEqual(loadViewLayers(mesh).outline, { flattenSubModelParts: false });
    const bad = saveViewLayers(mesh, [], { flattenSubModelParts: "x" });
    assert.ok(bad.warnings.length > 0);
    assert.deepEqual(loadViewLayers(mesh).outline, { flattenSubModelParts: false });
    assert.equal(fs.readFileSync(mesh, "utf8"), "Begin Nodes\nEnd Nodes\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("view state persists, is preserved by partial saves and never touches the mesh", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "viewlayers-"));
  try {
    const mesh = path.join(dir, "case.mdpa");
    fs.writeFileSync(mesh, "Begin Nodes\nEnd Nodes\n");
    assert.equal(loadViewLayers(mesh).view, undefined);
    const cam = { position: [0, 0, 5], focalPoint: [0, 0, 0], viewUp: [0, 1, 0], parallelScale: 2 };
    saveViewLayers(mesh, [], { flattenSubModelParts: true }, {
      bookmarks: [{ name: "front", state: cam }],
      paneLayout: "1x2",
      panes: [{ field: { selectedKey: "Nodal:TEMP", modes: ["contour", "iso"] }, clip: { active: true, axis: 1, t: 0.25 }, camera: cam }],
      layerVisibility: { "block:Elements:Tri": false },
      layerOpacity: { "block:Elements:Tri": 0.4 },
    });
    const back = loadViewLayers(mesh).view!;
    assert.equal(back.paneLayout, "1x2");
    assert.equal(back.bookmarks[0].name, "front");
    assert.equal(back.panes[0].field.selectedKey, "Nodal:TEMP");
    assert.deepEqual(back.panes[0].field.modes, ["contour", "iso"]);
    assert.equal(back.panes[0].clip.axis, 1);
    assert.equal(back.layerVisibility["block:Elements:Tri"], false);
    assert.equal(back.layerOpacity["block:Elements:Tri"], 0.4);
    // Saves that carry only one key keep the others.
    saveViewLayers(mesh, []);
    saveViewLayers(mesh, undefined, { flattenSubModelParts: false });
    const after = loadViewLayers(mesh);
    assert.equal(after.view!.paneLayout, "1x2");
    assert.deepEqual(after.outline, { flattenSubModelParts: false });
    // A view-only save keeps the layers already on disk.
    const layer = { id: "a", name: "a", color: [1, 0, 0], visible: true, locked: false, blocks: [], parts: ["Domain"], ids: { Elements: [], Conditions: [], Geometries: [] } };
    saveViewLayers(mesh, [layer]);
    saveViewLayers(mesh, undefined, undefined, { paneLayout: "2x2" });
    const kept = loadViewLayers(mesh);
    assert.equal(kept.layers.length, 1);
    assert.equal(kept.view!.paneLayout, "2x2");
    assert.equal(fs.readFileSync(mesh, "utf8"), "Begin Nodes\nEnd Nodes\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a sidecar written by a newer version is never overwritten", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "viewlayers-"));
  try {
    const mesh = path.join(dir, "case.mdpa");
    fs.writeFileSync(mesh, "Begin Nodes\nEnd Nodes\n");
    const future = JSON.stringify({ version: 9, layers: [], futureKey: { keep: "me" } });
    fs.writeFileSync(viewFilePath(mesh), future);
    const res = saveViewLayers(mesh, [], undefined, { paneLayout: "1x2" });
    assert.equal(res.saved, 0);
    assert.ok(res.warnings.some((w) => /newer version/.test(w)));
    assert.equal(fs.readFileSync(viewFilePath(mesh), "utf8"), future);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
