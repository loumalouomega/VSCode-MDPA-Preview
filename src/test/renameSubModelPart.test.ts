import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { renameSubModelPart } from "../parser/renameSubModelPart";
import { findSubModelPart } from "../parser/subModelPartExtract";

// One triangle; a "Parent" SubModelPart with a nested "Child".
const SRC = `Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 1.0 1.0 0.0
End Nodes

Begin Elements Element2D3N
1 1 1 2 3
End Elements

Begin SubModelPart Parent
  Begin SubModelPartNodes
  1
  End SubModelPartNodes
  Begin SubModelPart Child
    Begin SubModelPartNodes
    2
    End SubModelPartNodes
  End SubModelPart
End SubModelPart

Begin SubModelPart Sibling
End SubModelPart
`;

test("renames a top-level part and rebases descendant paths", () => {
  const m = parseMdpa(SRC);
  const { model, renamed } = renameSubModelPart(m, "Parent", "Inlet");
  assert.equal(renamed, true);

  const part = model.subModelParts.find((p) => p.name === "Inlet")!;
  assert.ok(part, "renamed part present");
  assert.equal(part.path, "Inlet");
  // The nested child's path must be rebased under the new parent name.
  assert.equal(part.children[0].name, "Child");
  assert.equal(part.children[0].path, "Inlet/Child");
  // Old name is gone.
  assert.equal(model.subModelParts.find((p) => p.name === "Parent"), undefined);
});

test("renames a nested part by its full path", () => {
  const m = parseMdpa(SRC);
  const { model, renamed } = renameSubModelPart(m, "Parent/Child", "Wall");
  assert.equal(renamed, true);
  const child = findSubModelPart(model, "Parent/Wall")!;
  assert.ok(child);
  assert.equal(child.name, "Wall");
  assert.equal(findSubModelPart(model, "Parent/Child"), undefined);
});

test("missing path → renamed false, model unchanged", () => {
  const m = parseMdpa(SRC);
  const { model, renamed } = renameSubModelPart(m, "Nope", "X");
  assert.equal(renamed, false);
  assert.equal(model, m);
});

test("sibling name collision is refused", () => {
  const m = parseMdpa(SRC);
  const { model, renamed } = renameSubModelPart(m, "Parent", "Sibling");
  assert.equal(renamed, false);
  assert.equal(model, m);
});

test("empty or slash-bearing names are rejected", () => {
  const m = parseMdpa(SRC);
  assert.equal(renameSubModelPart(m, "Parent", "").renamed, false);
  assert.equal(renameSubModelPart(m, "Parent", "  ").renamed, false);
  assert.equal(renameSubModelPart(m, "Parent", "a/b").renamed, false);
});

test("does not mutate the input model", () => {
  const m = parseMdpa(SRC);
  renameSubModelPart(m, "Parent", "Inlet");
  assert.equal(m.subModelParts[0].name, "Parent");
  assert.equal(m.subModelParts[0].children[0].path, "Parent/Child");
});
