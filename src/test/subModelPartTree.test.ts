/**
 * SubModelPart tree operations: create, move/reparent, merge, add/remove entities.
 *
 * The header these tests exist for is the **parent/child subset rule**: Kratos
 * requires a child's entities to be a subset of its parent's, and maintains it
 * itself rather than validating it — `ModelPart::AddNode` on a sub model part
 * calls the parent's `AddNode` first, and `RemoveNode` cascades into every
 * sub model part. These modules mirror that, so the tests below check the
 * propagation as hard as they check the tree shape: an operation that got the
 * direction wrong would produce an mdpa Kratos rejects, and nothing else in
 * this codebase would notice.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseMdpa } from "../parser/mdpaParser";
import { findSubModelPart } from "../parser/subModelPartExtract";
import { MdpaModel, SubModelPart } from "../parser/types";
import {
  addSubModelPartEntities,
  createSubModelPart,
  mergeSubModelParts,
  moveSubModelPart,
  removeSubModelPartEntities,
} from "../parser/subModelPartTree";

/**
 * Two triangles and a nested part tree:
 *   Domain            nodes 1-5, elements 1-2
 *     Inner           nodes 1-3, element 1
 *   Other             node 4, element 2
 */
const SRC = [
  "Begin Nodes",
  " 1 0.0 0.0 0.0",
  " 2 1.0 0.0 0.0",
  " 3 1.0 1.0 0.0",
  " 4 0.0 1.0 0.0",
  " 5 2.0 2.0 0.0",
  "End Nodes",
  "",
  "Begin Elements Element2D3N",
  " 1 0 1 2 3",
  " 2 0 1 3 4",
  "End Elements",
  "",
  "Begin SubModelPart Domain",
  " Begin SubModelPartNodes",
  "  1",
  "  2",
  "  3",
  "  4",
  "  5",
  " End SubModelPartNodes",
  " Begin SubModelPartElements",
  "  1",
  "  2",
  " End SubModelPartElements",
  " Begin SubModelPart Inner",
  "  Begin SubModelPartNodes",
  "   1",
  "   2",
  "   3",
  "  End SubModelPartNodes",
  "  Begin SubModelPartElements",
  "   1",
  "  End SubModelPartElements",
  " End SubModelPart",
  "End SubModelPart",
  "",
  "Begin SubModelPart Other",
  " Begin SubModelPartNodes",
  "  4",
  " End SubModelPartNodes",
  " Begin SubModelPartElements",
  "  2",
  " End SubModelPartElements",
  "End SubModelPart",
  "",
].join("\n");

const load = (): MdpaModel => parseMdpa(SRC);
const at = (m: MdpaModel, path: string): SubModelPart => {
  const p = findSubModelPart(m, path);
  assert.ok(p, `expected a SubModelPart at "${path}"`);
  return p;
};
const nodes = (m: MdpaModel, path: string): number[] => Array.from(at(m, path).nodeIds);
const elems = (m: MdpaModel, path: string): number[] => Array.from(at(m, path).elementIds);

/** Every path in the tree, for shape assertions. */
function paths(m: MdpaModel): string[] {
  const out: string[] = [];
  const walk = (parts: SubModelPart[]): void => {
    for (const p of parts) {
      out.push(p.path);
      walk(p.children);
    }
  };
  walk(m.subModelParts);
  return out.sort();
}

const ID_FIELDS = [
  "nodeIds",
  "elementIds",
  "conditionIds",
  "geometryIds",
  "constraintIds",
] as const;

/** The rule Kratos maintains: a child claims nothing its parent does not. */
function assertSubsetInvariant(m: MdpaModel): void {
  const walk = (part: SubModelPart, parent?: SubModelPart): void => {
    if (parent) {
      for (const field of ID_FIELDS) {
        const owned: Set<number> = new Set(Array.from(parent[field]));
        for (const id of Array.from(part[field])) {
          assert.ok(
            owned.has(id),
            `"${part.path}" claims ${field} ${id} that its parent "${parent.path}" does not`
          );
        }
      }
    }
    for (const c of part.children) walk(c, part);
  };
  for (const root of m.subModelParts) walk(root);
}

test("the fixture itself satisfies the subset rule", () => {
  assertSubsetInvariant(load());
});

// --- create ----------------------------------------------------------------

test("create makes an empty part at the top level and under a parent", () => {
  const m = load();
  const top = createSubModelPart(m, "", "Fresh");
  assert.equal(top.created, true);
  assert.deepEqual(nodes(top.model, "Fresh"), []);
  assert.deepEqual(elems(top.model, "Fresh"), []);

  const nested = createSubModelPart(top.model, "Domain", "Wall");
  assert.equal(nested.created, true);
  assert.equal(at(nested.model, "Domain/Wall").name, "Wall");
  assert.ok(paths(nested.model).includes("Domain/Wall"));
  assertSubsetInvariant(nested.model);
});

test("create refuses a duplicate sibling name, an invalid name and a missing parent", () => {
  const m = load();
  for (const [parent, name, why] of [
    ["", "Domain", "duplicate at top level"],
    ["Domain", "Inner", "duplicate under a parent"],
    ["", "", "empty name"],
    ["", "  ", "whitespace-only name"],
    ["", "a/b", "path separator in the name"],
    ["Nope", "X", "missing parent"],
  ] as const) {
    const r = createSubModelPart(m, parent, name);
    assert.equal(r.created, false, why);
    assert.equal(r.model, m, `${why}: the model is returned untouched`);
    assert.ok(r.message, `${why}: says why`);
  }
});

// --- move / reparent -------------------------------------------------------

test("move reparents a part and rebases every descendant path", () => {
  const m = load();
  const r = moveSubModelPart(m, "Other", "Domain");
  assert.equal(r.moved, true);
  assert.ok(paths(r.model).includes("Domain/Other"));
  assert.ok(!paths(r.model).includes("Other"), "the old path is gone");
  // The moved part keeps its own entities.
  assert.deepEqual(elems(r.model, "Domain/Other"), [2]);
});

test("move to the top level un-nests a part, rebasing its subtree", () => {
  const m = load();
  const r = moveSubModelPart(m, "Domain/Inner", "");
  assert.equal(r.moved, true);
  assert.ok(paths(r.model).includes("Inner"));
  assert.ok(!paths(r.model).includes("Domain/Inner"));
  assert.deepEqual(nodes(r.model, "Inner"), [1, 2, 3], "its ids came with it");
});

test("move carries the subtree's entities up into the new ancestors", () => {
  // "Other" claims node 4 and element 2; "Inner" has neither. Moving Other
  // under Inner must add them, or the result is a tree Kratos rejects.
  const m = load();
  const before = nodes(m, "Domain/Inner");
  assert.ok(!before.includes(4));

  const r = moveSubModelPart(m, "Other", "Domain/Inner");
  assert.equal(r.moved, true);
  assert.ok(r.propagated > 0, "something had to be added upward");
  assert.ok(nodes(r.model, "Domain/Inner").includes(4), "node 4 reached the new parent");
  assert.ok(elems(r.model, "Domain/Inner").includes(2), "element 2 reached the new parent");
  assertSubsetInvariant(r.model);
});

test("move rebases a whole subtree, not just the moved node", () => {
  const m = load();
  const moved = moveSubModelPart(m, "Domain", "Other");
  assert.equal(moved.moved, true);
  const all = paths(moved.model);
  assert.ok(all.includes("Other/Domain"));
  assert.ok(all.includes("Other/Domain/Inner"), "the grandchild path was rebased too");
  assertSubsetInvariant(moved.model);
});

test("move refuses a cycle, a self-move, a name clash and a missing path", () => {
  const m = load();
  const cases: [string, string, RegExp][] = [
    ["Domain", "Domain/Inner", /inside itself/],
    ["Domain", "Domain", /its own parent/],
    ["Nope", "", /No SubModelPart/],
    ["Domain", "Nope", /No SubModelPart/],
  ];
  for (const [path, dest, re] of cases) {
    const r = moveSubModelPart(m, path, dest);
    assert.equal(r.moved, false, `${path} -> ${dest}`);
    assert.equal(r.model, m);
    assert.match(r.message ?? "", re);
  }

  // A destination that already has a sibling of that name.
  const withClash = createSubModelPart(m, "Domain", "Other").model;
  const clash = moveSubModelPart(withClash, "Other", "Domain");
  assert.equal(clash.moved, false);
  assert.match(clash.message ?? "", /already has a SubModelPart named "Other"/);
});

test("moving a part to where it already is keeps the tree valid", () => {
  const m = load();
  const r = moveSubModelPart(m, "Domain/Inner", "Domain");
  assert.equal(r.moved, true, "a no-op move is still a legal move");
  assert.ok(paths(r.model).includes("Domain/Inner"));
  assertSubsetInvariant(r.model);
});

// --- merge -----------------------------------------------------------------

test("merge unions the entity ids and drops the source", () => {
  const m = load();
  const r = mergeSubModelParts(m, "Other", "Domain/Inner");
  assert.equal(r.merged, true);
  assert.ok(r.gained > 0);
  assert.ok(!paths(r.model).includes("Other"), "the source is gone");
  const inner = nodes(r.model, "Domain/Inner");
  assert.deepEqual(inner, [1, 2, 3, 4], "ascending, de-duplicated union");
  assert.deepEqual(elems(r.model, "Domain/Inner"), [1, 2]);
  assertSubsetInvariant(r.model);
});

test("merge re-attaches the source's children under the target", () => {
  const m = load();
  const r = mergeSubModelParts(m, "Domain", "Other");
  assert.equal(r.merged, true);
  const all = paths(r.model);
  assert.ok(!all.includes("Domain"));
  assert.ok(all.includes("Other/Inner"), "the child moved and was rebased");
  assertSubsetInvariant(r.model);
});

test("merge refuses itself, a descendant target, a child-name clash and a missing path", () => {
  const m = load();
  for (const [src, dst, re] of [
    ["Domain", "Domain", /into itself/],
    ["Domain", "Domain/Inner", /merge the other way round/],
    ["Nope", "Domain", /No SubModelPart/],
    ["Domain", "Nope", /No SubModelPart/],
  ] as const) {
    const r = mergeSubModelParts(m, src, dst);
    assert.equal(r.merged, false, `${src} -> ${dst}`);
    assert.equal(r.model, m);
    assert.match(r.message ?? "", re);
  }

  // Both parts have a child called "Inner" → duplicate siblings, refused.
  const withInner = createSubModelPart(m, "Other", "Inner").model;
  const clash = mergeSubModelParts(withInner, "Domain", "Other");
  assert.equal(clash.merged, false);
  assert.match(clash.message ?? "", /rename one first/);
});

// --- add / remove entities -------------------------------------------------

test("add puts the ids on the part AND on every ancestor", () => {
  // Kratos' ModelPart::AddNode calls the parent's AddNode first.
  const m = load();
  const r = addSubModelPartEntities(m, "Domain/Inner", "nodes", [4, 5]);
  assert.equal(r.changed, 2);
  assert.deepEqual(nodes(r.model, "Domain/Inner"), [1, 2, 3, 4, 5]);
  // Domain already had 4 and 5, so nothing had to propagate here.
  assert.equal(r.propagated, 0);
  assertSubsetInvariant(r.model);
});

test("add repairs an ancestor that lacked the entity", () => {
  const m = load();
  // Element 2 is not in Inner; and after removing it from Domain, neither is it
  // upstream — adding it back to Inner must restore it in Domain.
  const stripped = removeSubModelPartEntities(m, "Domain", "elements", [2]).model;
  assert.ok(!elems(stripped, "Domain").includes(2));

  const r = addSubModelPartEntities(stripped, "Domain/Inner", "elements", [2]);
  assert.equal(r.changed, 1);
  assert.equal(r.propagated, 1, "the ancestor was repaired");
  assert.ok(elems(r.model, "Domain").includes(2));
  assertSubsetInvariant(r.model);
});

test("add is idempotent and keeps ids ascending", () => {
  const m = load();
  const once = addSubModelPartEntities(m, "Other", "nodes", [1, 4]);
  assert.equal(once.changed, 1, "4 was already there");
  const twice = addSubModelPartEntities(once.model, "Other", "nodes", [1, 4]);
  assert.equal(twice.changed, 0);
  assert.deepEqual(nodes(twice.model, "Other"), [1, 4]);
});

test("remove strips the ids from the part AND every descendant", () => {
  // Kratos' ModelPart::RemoveNode loops over the sub model parts doing the same.
  const m = load();
  assert.ok(nodes(m, "Domain/Inner").includes(2));
  const r = removeSubModelPartEntities(m, "Domain", "nodes", [2]);
  assert.equal(r.changed, 1);
  assert.equal(r.propagated, 1, "the child lost it too");
  assert.ok(!nodes(r.model, "Domain").includes(2));
  assert.ok(!nodes(r.model, "Domain/Inner").includes(2), "a child cannot keep it");
  assertSubsetInvariant(r.model);
});

test("remove leaves the entities themselves alone — it only changes membership", () => {
  const m = load();
  const r = removeSubModelPartEntities(m, "Domain", "elements", [1]);
  assert.equal(r.model.nodeCount, m.nodeCount, "no nodes were deleted");
  assert.equal(
    r.model.blocks.reduce((n, b) => n + b.count, 0),
    m.blocks.reduce((n, b) => n + b.count, 0),
    "no cells were deleted"
  );
});

test("add and remove report a missing part and an empty id list", () => {
  const m = load();
  for (const r of [
    addSubModelPartEntities(m, "Nope", "nodes", [1]),
    removeSubModelPartEntities(m, "Nope", "nodes", [1]),
    addSubModelPartEntities(m, "Domain", "nodes", []),
    removeSubModelPartEntities(m, "Domain", "nodes", []),
  ]) {
    assert.equal(r.changed, 0);
    assert.equal(r.model, m);
    assert.ok(r.message);
  }
});

test("every operation leaves the input model untouched", () => {
  const m = load();
  const before = JSON.stringify(paths(m)) + nodes(m, "Domain/Inner").join(",");
  createSubModelPart(m, "", "X");
  moveSubModelPart(m, "Other", "Domain");
  mergeSubModelParts(m, "Other", "Domain");
  addSubModelPartEntities(m, "Domain/Inner", "nodes", [4]);
  removeSubModelPartEntities(m, "Domain", "nodes", [1]);
  assert.equal(JSON.stringify(paths(m)) + nodes(m, "Domain/Inner").join(","), before);
});

test("merge reports what it had to add to the target's ancestors", () => {
  // Domain/Inner lacks node 4 and element 2; merging Other into it must lift
  // them into Domain as well, and say so.
  const m = load();
  const r = mergeSubModelParts(m, "Other", "Domain/Inner");
  assert.equal(r.merged, true);
  assert.equal(r.propagated, 0, "Domain already had both");
  assertSubsetInvariant(r.model);

  // Now strip them from Domain first, so the merge genuinely has to repair it.
  const stripped = removeSubModelPartEntities(m, "Domain", "elements", [2]).model;
  const r2 = mergeSubModelParts(stripped, "Other", "Domain/Inner");
  assert.equal(r2.merged, true);
  assert.ok(r2.propagated > 0, "the ancestor was repaired and counted");
  assert.ok(elems(r2.model, "Domain").includes(2));
  assertSubsetInvariant(r2.model);
});
