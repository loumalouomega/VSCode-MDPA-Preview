/**
 * User layers (parser/userLayers.ts + view sidecar): validation, refresh by
 * definition, resolution for rendering/promotion, and tolerant sidecar I/O.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseMdpa } from "../parser/mdpaParser";
import { MdpaModel } from "../parser/types";
import {
  VIEW_SIDECAR_VERSION,
  describeUserLayer,
  isLayerNameAvailable,
  isValidLayerName,
  layerColorToHex,
  newLayerId,
  parseLayerColor,
  parseViewSidecar,
  refreshUserLayers,
  resolveUserLayer,
  serializeViewSidecar,
  validateUserLayers,
} from "../parser/userLayers";

const SRC = [
  "Begin Nodes",
  " 1 0.0 0.0 0.0",
  " 2 1.0 0.0 0.0",
  " 3 1.0 1.0 0.0",
  " 4 0.0 1.0 0.0",
  " 5 2.0 0.0 0.0",
  "End Nodes",
  "",
  "Begin Elements Element2D3N",
  " 1 0 1 2 3",
  " 2 0 1 3 4",
  " 3 0 2 3 5",
  "End Elements",
  "",
  "Begin Conditions PointCondition2D1N",
  " 1 0 5",
  "End Conditions",
  "",
  "Begin SubModelPart Domain",
  " Begin SubModelPartElements",
  "  1",
  "  2",
  " End SubModelPartElements",
  "End SubModelPart",
].join("\n");

const base = (): MdpaModel => parseMdpa(SRC);

test("layer names are non-empty, slash-free, and unique", () => {
  assert.equal(isValidLayerName("walls"), true);
  assert.equal(isValidLayerName("  "), false);
  assert.equal(isValidLayerName("a/b"), false);
  const layers = [
    { id: "walls", name: "walls", color: [1, 0, 0] as [number, number, number], visible: true, locked: false, blocks: [], parts: [], ids: { Elements: [], Conditions: [], Geometries: [] } },
  ];
  assert.equal(isLayerNameAvailable(layers, "walls"), false);
  assert.equal(isLayerNameAvailable(layers, "walls", "walls"), true);
  assert.equal(isLayerNameAvailable(layers, "floor"), true);
  assert.equal(newLayerId("Walls!", ["walls"]), "walls_2");
});

test("color parses as #rrggbb and round-trips", () => {
  assert.deepEqual(parseLayerColor("#ff0000"), [1, 0, 0]);
  assert.equal(parseLayerColor("nope"), undefined);
  assert.equal(layerColorToHex([1, 0, 0]), "#ff0000");
});

test("sidecar round-trips and tolerates malformed input", () => {
  const layers = [
    { id: "walls", name: "walls", color: [1, 0, 0] as [number, number, number], visible: true, locked: false, blocks: ["block:Elements:Element2D3N"], parts: ["Domain"], ids: { Elements: [1], Conditions: [], Geometries: [] } },
  ];
  const text = serializeViewSidecar(layers);
  const back = parseViewSidecar(text);
  assert.equal(back.layers.length, 1);
  assert.equal(back.layers[0].name, "walls");
  assert.equal(back.version, VIEW_SIDECAR_VERSION);
  assert.deepEqual(parseViewSidecar("nope {").layers, []);
  assert.deepEqual(parseViewSidecar('{"version":99,"layers":[]}').layers, [], "newer versions leave ordinary sections");
  assert.deepEqual(parseViewSidecar('{"layers":{"nope":1}}').layers, []);
  const dup = parseViewSidecar(JSON.stringify({ version: 1, layers: [{ id: "a", name: "x", color: [0, 0, 0], visible: true, locked: false, blocks: [], parts: [], ids: { Elements: [], Conditions: [], Geometries: [] } }, { id: "a", name: "x", color: [0, 0, 0], visible: true, locked: false, blocks: [], parts: [], ids: { Elements: [], Conditions: [], Geometries: [] } }] }));
  assert.equal(dup.layers.length, 2);
  assert.notEqual(dup.layers[0].id, dup.layers[1].id);
});

test("refresh prunes vanished blocks, parts and ids with a report", () => {
  const model = base();
  const blockId = `block:Elements:${model.blocks[0].name}`;
  const layers = [
    { id: "l1", name: "l1", color: [0, 0, 1] as [number, number, number], visible: true, locked: false, blocks: [blockId, "block:Elements:Missing"], parts: ["Domain", "Missing"], ids: { Elements: [1, 2, 99], Conditions: [1, 42], Geometries: [] } },
  ];
  const { layers: out, changed, reports } = refreshUserLayers(model, layers);
  assert.equal(changed, true);
  assert.deepEqual(out[0].blocks, [blockId]);
  assert.deepEqual(out[0].parts, ["Domain"]);
  assert.deepEqual(out[0].ids.Elements, [1, 2]);
  assert.deepEqual(out[0].ids.Conditions, [1]);
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0].prunedBlocks, ["block:Elements:Missing"]);
  const stable = refreshUserLayers(model, out);
  assert.equal(stable.changed, false);
});

test("resolve unions block, part and explicit ids for promotion", () => {
  const model = base();
  const blockId = `block:Elements:${model.blocks[0].name}`;
  const resolved = resolveUserLayer(model, {
    id: "l1", name: "l1", color: [0, 1, 0] as [number, number, number], visible: true, locked: false,
    blocks: [blockId], parts: ["Domain"], ids: { Elements: [3], Conditions: [1], Geometries: [] },
  });
  assert.deepEqual(resolved.elements, [1, 2, 3]);
  assert.deepEqual(resolved.conditions, [1]);
  assert.deepEqual(resolved.blockLayerIds, [blockId]);
  assert.deepEqual(resolved.smpLayerIds, ["smp:Domain"]);
  assert.equal(describeUserLayer({ id: "x", name: "x", color: [0, 0, 0], visible: true, locked: false, blocks: [], parts: [], ids: { Elements: [], Conditions: [], Geometries: [] } }), "empty");
});

test("validate drops malformed entries instead of failing the file", () => {
  const { layers, warnings } = validateUserLayers([{ name: "", blocks: [], parts: [], ids: {} }, { name: "ok", color: [0, 0, 0], visible: true, locked: false, blocks: ["nope"], parts: [], ids: { Elements: [1.5, -2, 3], Conditions: [], Geometries: [] } }]);
  assert.equal(layers.length, 1);
  assert.deepEqual(layers[0].ids.Elements, [3]);
  assert.ok(warnings.length >= 1);
});
