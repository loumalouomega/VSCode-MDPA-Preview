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
import { parseMdpa } from "../parser/mdpaParser";
import { refreshSelection } from "../parser/selectionCore";
import { validateViewState } from "../parser/viewState";
import { loadViewLayers, saveViewLayers } from "../viewLayersIO";

/** A small three-element mesh with a nodal TEMP field, for refresh-by-definition. */
const SRC = [
  "Begin Nodes",
  " 1 0.0 0.0 0.0",
  " 2 1.0 0.0 0.0",
  " 3 1.0 1.0 0.0",
  " 4 0.0 1.0 0.0",
  " 5 2.0 0.0 0.0",
  "End Nodes",
  "",
  "Begin NodalData TEMP",
  " 1 0 100",
  " 2 0 150",
  " 3 0 200",
  " 4 0 50",
  " 5 0 80",
  "End NodalData",
  "",
  "Begin Elements Element2D3N",
  " 1 0 1 2 3",
  " 2 0 1 3 4",
  " 3 0 2 3 5",
  "End Elements",
  "",
].join("\n");

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

test("selection sets survive the sidecar and re-resolve against the mesh that opens", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "viewlayers-"));
  try {
    const mesh = path.join(dir, "case.mdpa");
    fs.writeFileSync(mesh, "Begin Nodes\nEnd Nodes\n");
    // What the webview posts: the live view, serialized by the pure module.
    const view = {
      paneLayout: "1x1" as const,
      panes: [],
      layerVisibility: {},
      layerOpacity: {},
      layerPaneHidden: {},
      selections: [
        { name: "picked", seed: { kind: "explicit" as const }, kinds: { Elements: [3, 1, 99], Conditions: [], Geometries: [] } },
        { name: "hot", seed: { kind: "field" as const, variable: "TEMP", blockKind: "Nodal" as const, lo: 40, hi: 250 }, kinds: { Elements: [99], Conditions: [], Geometries: [] } },
      ],
    };
    saveViewLayers(mesh, undefined, undefined, view);
    // The host half of the `viewLayers` reply.
    const loaded = loadViewLayers(mesh).view!;
    // The webview validates what the host sent, as `viewLayers` does.
    const { view: received, warnings } = validateViewState(loaded, "Rainbow");
    assert.deepEqual(warnings, []);
    assert.deepEqual(received.selections.map((s) => s.name), ["picked", "hot"]);
    assert.deepEqual(received.selections[0].kinds.Elements, [1, 3, 99], "the explicit snapshot comes back intact");
    // ...then refresh-by-definition prunes what this mesh no longer has.
    const model = parseMdpa(SRC);
    const refreshed = refreshSelection(model, received.selections);
    assert.deepEqual(refreshed.sets[0].kinds.Elements, [1, 3]);
    assert.deepEqual(refreshed.reports.map((r) => r.pruned.Elements), [[99]]);
    assert.equal(refreshed.sets[1].kinds.Elements.length, 3, "the field seed re-resolved");
    // A later save writes the pruned state, so the stale id does not come back.
    saveViewLayers(mesh, undefined, undefined, { ...received, selections: refreshed.sets });
    assert.deepEqual(loadViewLayers(mesh).view!.selections[0].kinds.Elements, [1, 3]);
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
