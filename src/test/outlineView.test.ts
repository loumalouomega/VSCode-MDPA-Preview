/**
 * Outline presentation (parser/outlineView.ts): the flat SubModelPart list and
 * the tolerant sidecar settings read.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_OUTLINE_VIEW, flattenPartNodes, validateOutlineView } from "../parser/outlineView";

interface N {
  label: string;
  exportPath?: string;
  layerId?: string;
  visible?: boolean;
  counts?: number;
  children?: N[];
}

const tree = (): N[] => [
  {
    label: "Outer",
    exportPath: "Outer",
    layerId: "smp:Outer",
    visible: true,
    counts: 3,
    children: [
      { label: "Inlet", exportPath: "Outer/Inlet", layerId: "smp:Outer/Inlet", counts: 1 },
      {
        label: "Mid",
        exportPath: "Outer/Mid",
        layerId: "smp:Outer/Mid",
        children: [{ label: "Inlet", exportPath: "Outer/Mid/Inlet", layerId: "smp:Outer/Mid/Inlet" }],
      },
    ],
  },
  { label: "Wall", exportPath: "Wall", layerId: "smp:Wall" },
];

test("flatten lists every part depth-first with full paths for nested parts", () => {
  const flat = flattenPartNodes(tree());
  assert.deepEqual(
    flat.map((n) => n.label),
    ["Outer", "Outer/Inlet", "Outer/Mid", "Outer/Mid/Inlet", "Wall"]
  );
  assert.ok(flat.every((n) => n.children === undefined), "no nesting remains");
});

test("flatten keeps every row's layer, path and counts so actions still address the same part", () => {
  const flat = flattenPartNodes(tree());
  assert.deepEqual(
    flat.map((n) => n.layerId),
    ["smp:Outer", "smp:Outer/Inlet", "smp:Outer/Mid", "smp:Outer/Mid/Inlet", "smp:Wall"]
  );
  assert.deepEqual(
    flat.map((n) => n.exportPath),
    ["Outer", "Outer/Inlet", "Outer/Mid", "Outer/Mid/Inlet", "Wall"]
  );
  assert.equal(flat[0].counts, 3);
  assert.equal(flat[0].visible, true);
});

test("two same-named children under different parents stay distinguishable", () => {
  const labels = flattenPartNodes(tree()).map((n) => n.label);
  assert.equal(new Set(labels).size, labels.length);
});

test("flatten never mutates its input and tolerates empty or path-less rows", () => {
  const input = tree();
  const snapshot = JSON.stringify(input);
  flattenPartNodes(input);
  assert.equal(JSON.stringify(input), snapshot);
  assert.deepEqual(flattenPartNodes([]), []);
  const noPath = flattenPartNodes<N>([{ label: "A", children: [{ label: "B" }] }]);
  assert.deepEqual(noPath.map((n) => n.label), ["A", "B"]);
});

test("outline settings: absent is silent, malformed degrades with a warning", () => {
  assert.deepEqual(validateOutlineView(undefined), { settings: DEFAULT_OUTLINE_VIEW, warnings: [] });
  assert.equal(validateOutlineView({ flattenSubModelParts: true }).settings.flattenSubModelParts, true);
  assert.deepEqual(validateOutlineView({}).warnings, []);
  for (const bad of [null, 3, "x", [true]]) {
    const r = validateOutlineView(bad);
    assert.equal(r.settings.flattenSubModelParts, false);
    assert.equal(r.warnings.length, 1);
  }
  const r = validateOutlineView({ flattenSubModelParts: "yes" });
  assert.equal(r.settings.flattenSubModelParts, false);
  assert.equal(r.warnings.length, 1);
});
