import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { writeMdpa } from "../parser/writers/mdpaWriter";
import { addHangingNodeConstraints, findHangingNodes, HANGING_PART } from "../parser/hangingNodes";
import { countConstraints, definedConstraintIds } from "../parser/constraintsParser";
import { removeOrphanNodes } from "../parser/removeOrphanNodes";
import { renumberModel } from "../parser/renumberMesh";
import { cropModel } from "../parser/cropMesh";
import { mergeModels } from "../parser/mergeMesh";
import { buildConstraintLinks } from "../parser/constraintLinks";
import { OperationHistory } from "../parser/opHistoryCore";
import { undefinedConstraintIds } from "../parser/constraintsParser";

/** One coarse cube [0,2]^3 beside a fine 2x2x2 block on [2,4]x[0,2]x[0,2]. */
function twoLevel(): string {
  const ids = new Map<string, number>();
  const lines: string[] = [];
  const node = (x: number, y: number, z: number): number => {
    const k = `${x},${y},${z}`;
    let id = ids.get(k);
    if (!id) { id = ids.size + 1; ids.set(k, id); lines.push(`${id} ${x} ${y} ${z}`); }
    return id;
  };
  const hex = (x: number, y: number, z: number, h: number): number[] => [
    node(x, y, z), node(x + h, y, z), node(x + h, y + h, z), node(x, y + h, z),
    node(x, y, z + h), node(x + h, y, z + h), node(x + h, y + h, z + h), node(x, y + h, z + h),
  ];
  const cells = [hex(0, 0, 0, 2)];
  for (const x of [2, 3]) for (const y of [0, 1]) for (const z of [0, 1]) cells.push(hex(x, y, z, 1));
  return `Begin Nodes\n${lines.join("\n")}\nEnd Nodes\nBegin Elements Element3D8N\n${cells.map((c, i) => `${i + 1} 0 ${c.join(" ")}`).join("\n")}\nEnd Elements\n`;
}

test("finds the edge and face hanging nodes of a one-level jump", () => {
  const model = parseMdpa(twoLevel());
  const r = findHangingNodes(model);
  // On the shared x = 2 face of the coarse cube: 4 edge midpoints and 1 face centre.
  assert.equal(r.nodes.length, 5);
  assert.equal(r.nodes.filter((h) => h.on === "edge").length, 4);
  assert.equal(r.nodes.filter((h) => h.on === "face").length, 1);
  for (const h of r.nodes) {
    assert.ok(Math.abs(h.weights.reduce((a, b) => a + b, 0) - 1) < 1e-12);
    assert.equal(h.masters.length, h.on === "edge" ? 2 : 4);
  }
});

test("a linear field is reproduced exactly at every hanging node", () => {
  const model = parseMdpa(twoLevel());
  const idx = new Map<number, number>();
  for (let i = 0; i < model.nodeCount; i++) idx.set(model.nodeIds[i], i);
  const f = (i: number) => 3 * model.coords[i * 3] - 2 * model.coords[i * 3 + 1] + 0.5 * model.coords[i * 3 + 2] + 7;
  for (const h of findHangingNodes(model).nodes) {
    const tied = h.masters.reduce((s, m, j) => s + h.weights[j] * f(idx.get(m)!), 0);
    assert.ok(Math.abs(tied - f(idx.get(h.node)!)) < 1e-9);
  }
});

test("addHangingNodeConstraints writes one row per hanging node and variable, and replaces itself", () => {
  const model = parseMdpa(twoLevel());
  const a = addHangingNodeConstraints(model, { variables: ["DISPLACEMENT_X", "DISPLACEMENT_Y"] });
  assert.equal(a.hanging, 5);
  assert.equal(a.constraints, 10);
  const part = a.model.subModelParts.find((p) => p.name === HANGING_PART)!;
  assert.deepEqual([...part.constraintIds].sort((x, y) => x - y), definedConstraintIds(a.model.constraints).sort((x, y) => x - y));
  const b = addHangingNodeConstraints(a.model, { variables: ["TEMPERATURE"] });
  assert.equal(b.replaced, 10);
  assert.equal(countConstraints(b.model.constraints).linear, 5);
  assert.equal(b.model.subModelParts.filter((p) => p.name === HANGING_PART).length, 1);
});

test("the constraints survive a write/re-parse and node-changing ops", () => {
  const { model } = addHangingNodeConstraints(parseMdpa(twoLevel()), { variables: ["DISPLACEMENT_X"] });
  const text = writeMdpa(model);
  assert.match(text, /Begin Constraints LinearMasterSlaveConstraint DISPLACEMENT_X/);
  const again = parseMdpa(text);
  assert.equal(countConstraints(again.constraints).linear, 5);
  assert.equal(countConstraints(again.constraints).raw, 0);
  assert.equal(removeOrphanNodes(again).removed, 0);
  const renum = renumberModel(again, { target: "all", start: 100 });
  assert.equal(countConstraints(renum.model.constraints).linear, 5);
});

test("a chain of hanging nodes resolves to end masters", () => {
  // Coarse quad C, a medium quad M against its right side, and a small quad that
  // puts nodes at (4,2) and (4,3): (4,3) hangs on M's left edge whose end (4,2)
  // itself hangs on C's — so (4,3) must resolve to C's corners (4,0),(4,4).
  const src = `Begin Nodes
1 0 0 0
2 4 0 0
3 4 4 0
4 0 4 0
5 6 2 0
6 6 4 0
7 4 2 0
8 4 3 0
9 5 2 0
10 5 3 0
End Nodes
Begin Elements Element2D4N
1 0 1 2 3 4
2 0 7 5 6 3
3 0 7 9 10 8
End Elements
`;
  const model = parseMdpa(src);
  const r = findHangingNodes(model);
  assert.ok(r.chained >= 1);
  const h = r.nodes.find((n) => n.node === 8)!;
  assert.deepEqual(h.masters, [2, 3]);
  assert.ok(Math.abs(h.weights[0] - 0.25) < 1e-9 && Math.abs(h.weights[1] - 0.75) < 1e-9);
});

test("a conforming mesh has none", () => {
  const src = `Begin Nodes\n1 0 0 0\n2 1 0 0\n3 1 1 0\n4 0 1 0\n5 0 0 1\n6 1 0 1\n7 1 1 1\n8 0 1 1\nEnd Nodes\nBegin Elements Element3D8N\n1 0 1 2 3 4 5 6 7 8\nEnd Elements\n`;
  assert.equal(findHangingNodes(parseMdpa(src)).nodes.length, 0);
  const r = addHangingNodeConstraints(parseMdpa(src));
  assert.equal(r.constraints, 0);
});

const idsOf = (m: ReturnType<typeof parseMdpa>) => definedConstraintIds(m.constraints);

test("crop drops a constraint whose node leaves and keeps the part list consistent", () => {
  const { model } = addHangingNodeConstraints(parseMdpa(twoLevel()), { variables: ["DISPLACEMENT_X"] });
  assert.equal(idsOf(model).length, 5);
  // Keep y <= 1: the coarse cube (nodes at y = 2) goes, the fine cells stay, and the
  // constraints whose masters sit at y = 2 must go with it rather than dangle.
  const r = cropModel(model, { kind: "bbox", lo: [-1, -1, -1], hi: [5, 1, 5], mode: "all" });
  assert.ok(r.droppedConstraints > 0);
  assert.ok(idsOf(r.model).length < 5);
  assert.deepEqual(undefinedConstraintIds(r.model.constraints, r.model.subModelParts), []);
});

test("merging a second mesh offsets its constraints past the first and keeps both sets", () => {
  const a = addHangingNodeConstraints(parseMdpa(twoLevel()), { variables: ["DISPLACEMENT_X"] }).model;
  const b = addHangingNodeConstraints(parseMdpa(twoLevel()), { variables: ["DISPLACEMENT_X"] }).model;
  const merged = mergeModels(a, b, { name: "Other" }).model;
  const ids = idsOf(merged);
  assert.equal(ids.length, 10);
  assert.equal(new Set(ids).size, 10, "no id collides");
  assert.deepEqual(undefinedConstraintIds(merged.constraints, merged.subModelParts), []);
});

test("undo and redo remove and restore the generated constraints", async () => {
  const h = new OperationHistory();
  h.setBase(parseMdpa(twoLevel()));
  await h.applyNew({ op: "addHangingNodeConstraints", variables: ["DISPLACEMENT_X"] });
  assert.equal(idsOf((await h.current()).model).length, 5);
  h.undo();
  assert.equal(idsOf((await h.current()).model).length, 0);
  h.redo();
  assert.equal(idsOf((await h.current()).model).length, 5);
});

test("buildConstraintLinks gives one segment per slave-master pair", () => {
  const { model } = addHangingNodeConstraints(parseMdpa(twoLevel()), { variables: ["DISPLACEMENT_X"] });
  const links = buildConstraintLinks(model);
  const expected = (model.constraints ?? []).flatMap((b) => b.rows).reduce((n, r) => n + (r.kind === "linear" ? r.slaveIds.length * r.masterIds.length : 0), 0);
  assert.equal(links.segments, expected);
  assert.equal(links.lines.length, expected * 3);
  assert.equal(links.missing, 0);
  assert.equal(buildConstraintLinks(model, { variable: "TEMPERATURE" }).segments, 0);
});
