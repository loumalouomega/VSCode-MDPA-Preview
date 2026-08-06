/**
 * mergeMesh.ts — appends one or more meshes with id offsetting, optional welding.
 * Pure, no wasm.
 *
 * The `mergeModels` tests below are deliberately unchanged from before the
 * N-ary rewrite: they are the back-compat guarantee that the binary entry point
 * still behaves exactly as it did. The `mergeManyModels` block that follows
 * covers the N-ary path and the fidelity gaps.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { mergeManyModels, mergeModels } from "../parser/mergeMesh";
import { parseMdpa } from "../parser/mdpaParser";
import { findSubModelPart } from "../parser/subModelPartExtract";
import { MdpaModel, SubModelPart } from "../parser/types";

const TRI_A = `Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
End Nodes

Begin Elements Element2D3N
1 0 1 2 3
End Elements

Begin NodalData T
1 10.0
2 20.0
3 30.0
End NodalData
`;

const TRI_B = `Begin Properties 0
End Properties

Begin Nodes
1 5.0 5.0 0.0
2 6.0 5.0 0.0
3 5.0 6.0 0.0
End Nodes

Begin Elements Element2D3N
1 0 1 2 3
End Elements

Begin NodalData T
1 100.0
2 200.0
3 300.0
End NodalData
`;

test("merge offsets the second mesh's ids past the first's", () => {
  const a = parseMdpa(TRI_A);
  const b = parseMdpa(TRI_B);
  const r = mergeModels(a, b);
  assert.equal(r.model.nodeCount, 6);
  assert.deepEqual(Array.from(r.model.nodeIds), [1, 2, 3, 4, 5, 6]);
  assert.equal(r.model.blocks.reduce((n, blk) => n + blk.count, 0), 2);
  assert.deepEqual(Array.from(r.model.blocks[1].entityIds), [2]);
  assert.deepEqual(Array.from(r.model.blocks[1].connectivity), [4, 5, 6]);
});

test("merge preserves both meshes' geometry exactly (no welding by default)", () => {
  const a = parseMdpa(TRI_A);
  const b = parseMdpa(TRI_B);
  const r = mergeModels(a, b);
  assert.equal(r.welded, 0);
  assert.equal(r.addedNodes, 3);
  // B's first node (5,5,0) must be present under its offset id (4).
  assert.deepEqual(
    [r.model.coords[3 * 3], r.model.coords[3 * 3 + 1], r.model.coords[3 * 3 + 2]],
    [5, 5, 0]
  );
});

test("merge adds a SubModelPart wrapping the merged-in geometry", () => {
  const a = parseMdpa(TRI_A);
  const b = parseMdpa(TRI_B);
  const r = mergeModels(a, b, { name: "Imported" });
  const part = r.model.subModelParts.find((p) => p.path === "Imported")!;
  assert.ok(part);
  assert.deepEqual(Array.from(part.nodeIds), [4, 5, 6]);
  assert.deepEqual(Array.from(part.elementIds), [2]);
});

test("same-named Nodal fields on both sides concatenate", () => {
  const a = parseMdpa(TRI_A);
  const b = parseMdpa(TRI_B);
  const r = mergeModels(a, b);
  const t = r.model.fields.find((f) => f.variable === "T")!;
  assert.equal(t.ids.length, 6);
  assert.deepEqual(Array.from(t.values), [10, 20, 30, 100, 200, 300]);
});

test("weld: true fuses coincident nodes across the seam", () => {
  const a = parseMdpa(TRI_A);
  // B shares node (1,0,0) with A's node 2 — same triangle corner, offset mesh.
  const bSrc = TRI_A.replace("0.0 0.0 0.0", "9.0 9.0 9.0"); // move B's node1 away
  const b = parseMdpa(bSrc);
  // Force an exact coincidence: B's node 2 (1,0,0) matches A's node 2 (1,0,0).
  const r = mergeModels(a, b, { weld: true, tolerance: 1e-6 });
  assert.ok(r.welded >= 1, "at least the coincident corner should weld");
  assert.equal(r.model.nodeCount, 6 - r.welded);
});

test("merging into an empty base just adopts the second mesh", () => {
  const empty = parseMdpa(`Begin Properties 0
End Properties

Begin Nodes
End Nodes
`);
  const b = parseMdpa(TRI_B);
  const r = mergeModels(empty, b);
  assert.equal(r.model.nodeCount, 3);
  assert.deepEqual(Array.from(r.model.nodeIds), [1, 2, 3]);
});

test("merging an empty mesh in is a noop", () => {
  const a = parseMdpa(TRI_A);
  const empty = parseMdpa(`Begin Properties 0
End Properties

Begin Nodes
End Nodes
`);
  const r = mergeModels(a, empty);
  assert.equal(r.model, a);
  assert.equal(r.addedNodes, 0);
});

test("never mutates either input model", () => {
  const a = parseMdpa(TRI_A);
  const b = parseMdpa(TRI_B);
  const snapA = a.nodeIds.slice();
  const snapB = b.nodeIds.slice();
  mergeModels(a, b);
  assert.deepEqual(a.nodeIds, snapA);
  assert.deepEqual(b.nodeIds, snapB);
});

// --- N-ary merge ------------------------------------------------------------

/** A triangle whose coordinates are shifted by `dx`, so sources stay disjoint. */
function triAt(dx: number): MdpaModel {
  return parseMdpa(`Begin Properties 0
End Properties

Begin Nodes
1 ${dx}.0 0.0 0.0
2 ${dx + 1}.0 0.0 0.0
3 ${dx}.0 1.0 0.0
End Nodes

Begin Elements Element2D3N
1 0 1 2 3
End Elements
`);
}

const src = (model: MdpaModel, name: string) => ({ model, name });

test("three sources merge in one call with cumulative id offsetting", () => {
  const r = mergeManyModels(parseMdpa(TRI_A), [
    src(triAt(10), "beam"),
    src(triAt(20), "column"),
    src(triAt(30), "slab"),
  ]);
  assert.equal(r.model.nodeCount, 12);
  assert.deepEqual(Array.from(r.model.nodeIds), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual(r.wrapperPaths, ["beam", "column", "slab"]);
  assert.equal(r.addedNodes, 9);
  assert.equal(r.addedCells, 3);
  // Each source is its own top-level part, framable and exportable on its own.
  assert.deepEqual(Array.from(findSubModelPart(r.model, "slab")!.nodeIds), [10, 11, 12]);
  assert.deepEqual(Array.from(findSubModelPart(r.model, "slab")!.elementIds), [4]);
});

test("a shared `name` groups the sources as children of one parent", () => {
  const r = mergeManyModels(
    parseMdpa(TRI_A),
    [src(triAt(10), "beam"), src(triAt(20), "column")],
    { name: "Imported" }
  );
  const group = findSubModelPart(r.model, "Imported")!;
  assert.ok(group, "the parent exists");
  assert.deepEqual(
    group.children.map((c) => c.path),
    ["Imported/beam", "Imported/column"]
  );
  // Kratos requires a child's entities to be a subset of its parent's.
  assert.deepEqual(Array.from(group.nodeIds), [4, 5, 6, 7, 8, 9]);
  assert.deepEqual(Array.from(group.elementIds), [2, 3]);
  assert.equal(r.wrapperPaths.length, 2);
});

test("entity ids are offset per kind, not past one shared maximum", () => {
  const withBoth = `Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
End Nodes

Begin Elements Element2D3N
1 0 1 2 3
2 0 1 2 3
End Elements

Begin Conditions LineCondition2D2N
1 0 1 2
End Conditions
`;
  const r = mergeManyModels(parseMdpa(withBoth), [src(parseMdpa(withBoth), "other")]);
  const elems = r.model.blocks.filter((b) => b.kind === "Elements");
  const conds = r.model.blocks.filter((b) => b.kind === "Conditions");
  // Base has elements 1-2 and condition 1; the incoming condition continues the
  // CONDITION run (2), not the global maximum (3).
  assert.deepEqual(Array.from(elems[1].entityIds), [3, 4]);
  assert.deepEqual(Array.from(conds[1].entityIds), [2]);
});

test("welding runs once across every seam, not once per source", () => {
  // Three copies of the same triangle: 9 nodes collapse to 3.
  const r = mergeManyModels(
    parseMdpa(TRI_A),
    [src(parseMdpa(TRI_A), "a"), src(parseMdpa(TRI_A), "b"), src(parseMdpa(TRI_A), "c")],
    { weld: true, tolerance: 1e-6 }
  );
  assert.equal(r.model.nodeCount, 3);
  assert.equal(r.welded, 9);
  assert.equal(r.addedNodes, 0, "every merged-in node was a duplicate");
});

test("merged-in child parts are addressable under their wrapper", () => {
  const nested = `Begin Properties 0
End Properties

Begin Nodes
1 5.0 0.0 0.0
2 6.0 0.0 0.0
3 5.0 1.0 0.0
End Nodes

Begin Elements Element2D3N
1 0 1 2 3
End Elements

Begin SubModelPart Inlet
  Begin SubModelPartNodes
  1
  2
  End SubModelPartNodes
End SubModelPart
`;
  const r = mergeManyModels(parseMdpa(TRI_A), [src(parseMdpa(nested), "wing")]);
  const child = findSubModelPart(r.model, "wing/Inlet");
  assert.ok(child, "the child resolves under its new parent");
  assert.deepEqual(Array.from(child!.nodeIds), [4, 5]);
  assert.equal(
    findSubModelPart(r.model, "Inlet"),
    undefined,
    "and no longer claims its old top-level path"
  );
});

test("constraint ids are offset by the base's own constraint maximum", () => {
  const withConstraints = (ids: number[]) => `Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
End Nodes

Begin Elements Element2D3N
1 0 1 2 3
End Elements

Begin SubModelPart Tied
  Begin SubModelPartConstraints
${ids.map((i) => `  ${i}`).join("\n")}
  End SubModelPartConstraints
End SubModelPart
`;
  const base = parseMdpa(withConstraints([1, 2, 5]));
  const r = mergeManyModels(base, [src(parseMdpa(withConstraints([1, 2])), "other")]);
  const merged = findSubModelPart(r.model, "other/Tied")!;
  // Offset by 5 (the base's own constraint max) — NOT by the entity offset.
  assert.deepEqual(Array.from(merged.constraintIds), [6, 7]);
  assert.deepEqual(
    Array.from(findSubModelPart(r.model, "Tied")!.constraintIds),
    [1, 2, 5],
    "the base's own constraints are untouched"
  );
});

test("a fixity array survives a same-variable concatenation at full length", () => {
  const fixedSide = `Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
End Nodes

Begin NodalData DISPLACEMENT_X
1 1 0.5
2 0 1.5
3 0 2.5
End NodalData
`;
  const plainSide = fixedSide.replace(/^(\d) [01] /gm, "$1 ");
  const r = mergeManyModels(parseMdpa(fixedSide), [src(parseMdpa(plainSide), "other")]);
  const f = r.model.fields.find((v) => v.variable === "DISPLACEMENT_X")!;
  assert.equal(f.ids.length, 6);
  assert.ok(f.fixed, "the base's fixity flags survive");
  assert.equal(f.fixed!.length, f.ids.length, "and are not left short of the concatenated ids");
  assert.deepEqual(Array.from(f.fixed!), [1, 0, 0, 0, 0, 0]);
});

test("a component-count collision is reported and leaves exactly one field", () => {
  const scalar = `Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
End Nodes

Begin NodalData VELOCITY
1 1.0
End NodalData
`;
  const vector = `Begin Properties 0
End Properties

Begin Nodes
1 5.0 0.0 0.0
End Nodes

Begin NodalData VELOCITY
1 [3] (1.0, 2.0, 3.0)
End NodalData
`;
  const r = mergeManyModels(parseMdpa(scalar), [src(parseMdpa(vector), "vec")]);
  const matches = r.model.fields.filter((f) => f.kind === "Nodal" && f.variable === "VELOCITY");
  assert.equal(matches.length, 1, "not two entries under one key");
  assert.equal(matches[0].components, 1, "the base's shape wins");
  assert.ok(
    r.diagnostics.some((d) => /inconsistent component counts/i.test(d.message)),
    "and the skip is reported rather than silent"
  );
});

test("a wrapper name colliding with an existing part is suffixed", () => {
  const baseWithPart = `Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
End Nodes

Begin SubModelPart beam
  Begin SubModelPartNodes
  1
  End SubModelPartNodes
End SubModelPart
`;
  const r = mergeManyModels(parseMdpa(baseWithPart), [
    src(triAt(10), "beam"),
    src(triAt(20), "beam"),
  ]);
  assert.deepEqual(r.wrapperPaths, ["beam_2", "beam_3"]);
  assert.ok(findSubModelPart(r.model, "beam"), "the original part is still there");
});

test("both meshes' diagnostics survive, the incoming ones name their source", () => {
  // An unterminated block — the parser is tolerant, so it reports rather than throws.
  const bad = `Begin Nodes
1 7.0 0.0 0.0
`;
  const other = parseMdpa(bad);
  assert.ok(other.diagnostics.length > 0, "fixture actually produces a diagnostic");
  const r = mergeManyModels(parseMdpa(TRI_A), [src(triAt(10), "ok"), src(other, "broken")]);
  assert.ok(
    r.diagnostics.some((d) => d.message.startsWith("[broken] ")),
    "an incoming diagnostic is prefixed with its source"
  );
});

test("dropped Properties and dangling property ids are reported", () => {
  const withProps = `Begin Properties 7
DENSITY 1.0
End Properties

Begin Nodes
1 5.0 0.0 0.0
2 6.0 0.0 0.0
3 5.0 1.0 0.0
End Nodes

Begin Elements Element2D3N
1 7 1 2 3
End Elements
`;
  const r = mergeManyModels(parseMdpa(TRI_A), [src(parseMdpa(withProps), "wing")]);
  assert.ok(
    r.diagnostics.some((d) => /were not merged/i.test(d.message)),
    "the Properties loss is named"
  );
  assert.ok(
    r.diagnostics.some((d) => /property id\(s\) 7/.test(d.message)),
    "and so is the id it leaves dangling"
  );
});

test("an empty source is skipped; all-empty is a noop on the base", () => {
  const empty = parseMdpa(`Begin Nodes
End Nodes
`);
  const a = parseMdpa(TRI_A);
  const partial = mergeManyModels(a, [src(empty, "nothing"), src(triAt(10), "beam")]);
  assert.equal(partial.skipped, 1);
  assert.deepEqual(partial.wrapperPaths, ["beam"]);

  const none = mergeManyModels(a, [src(empty, "nothing")]);
  assert.equal(none.model, a, "same reference — nothing was rebuilt");
  assert.equal(none.skipped, 1);
  assert.equal(none.addedNodes, 0);
});

test("N-ary merge never mutates any input", () => {
  const a = parseMdpa(TRI_A);
  const b = triAt(10);
  const snapA = a.nodeIds.slice();
  const snapB = b.nodeIds.slice();
  const partsA = a.subModelParts.length;
  mergeManyModels(a, [src(b, "beam")], { weld: true });
  assert.deepEqual(a.nodeIds, snapA);
  assert.deepEqual(b.nodeIds, snapB);
  assert.equal(a.subModelParts.length, partsA, "the base's part list is not appended to in place");
});

test("a merged model still exposes its parts through the tree walk", () => {
  const r = mergeManyModels(parseMdpa(TRI_A), [src(triAt(10), "beam")]);
  const paths: string[] = [];
  const walk = (ps: SubModelPart[]): void => {
    for (const p of ps) {
      paths.push(p.path);
      walk(p.children);
    }
  };
  walk(r.model.subModelParts);
  assert.ok(paths.includes("beam"));
});
