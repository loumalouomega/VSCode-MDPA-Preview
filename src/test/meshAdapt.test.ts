import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { writeMdpa } from "../parser/writers/mdpaWriter";
import { adaptMeshNames } from "../problemtype/meshAdapt";
import { resolveMeshNaming } from "../problemtype/api";
import { structural } from "../problemtype/builtins/structural";
import { fluid } from "../problemtype/builtins/fluid";

// A 3D mesh whose blocks are named for a fluid run, plus a point condition.
const SRC = `Begin Properties 7
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
4 0.0 0.0 1.0
End Nodes

Begin Elements Element3D4N
1 7 1 2 3 4
End Elements

Begin Conditions WallCondition3D3N
1 7 1 2 3
End Conditions

Begin Conditions PointLoadCondition3D1N
2 7 4
End Conditions
`;

test("adaptMeshNames renames elements + surface conditions, skips point conditions", () => {
  const model = parseMdpa(SRC);
  const out = adaptMeshNames(
    model,
    { elements: "SmallDisplacementElement", conditions: "SurfaceLoadCondition" },
    3
  );
  assert.deepEqual(
    out.renames,
    [
      { kind: "Elements", from: "Element3D4N", to: "SmallDisplacementElement3D4N" },
      { kind: "Conditions", from: "WallCondition3D3N", to: "SurfaceLoadCondition3D3N" },
    ]
  );
  assert.ok(out.warnings.some((w) => w.includes("PointLoadCondition3D1N")));
  const names = out.model.blocks.map((b) => b.name);
  assert.deepEqual(names, [
    "SmallDisplacementElement3D4N",
    "SurfaceLoadCondition3D3N",
    "PointLoadCondition3D1N",
  ]);
  // Geometry untouched: same stride/vtkCellType/connectivity references.
  assert.equal(out.model.blocks[0].stride, 4);
  assert.equal(out.model.blocks[0].vtkCellType, model.blocks[0].vtkCellType);
  assert.equal(out.model.blocks[0].connectivity, model.blocks[0].connectivity);
  // Input model not mutated.
  assert.equal(model.blocks[0].name, "Element3D4N");
});

test("adaptMeshNames is a noop when names already match", () => {
  const model = parseMdpa(SRC);
  const out = adaptMeshNames(model, { elements: "Element", conditions: "WallCondition" }, 3);
  assert.equal(out.renames.length, 0);
  assert.equal(out.model, model); // same reference — no copy
});

test("adaptMeshNames without bases leaves everything alone", () => {
  const model = parseMdpa(SRC);
  const out = adaptMeshNames(model, {}, 3);
  assert.equal(out.model, model);
  assert.deepEqual(out.renames, []);
  assert.deepEqual(out.warnings, []);
});

test("adapted model round-trips through the mdpa writer with Properties preserved", () => {
  const model = parseMdpa(SRC);
  const out = adaptMeshNames(
    model,
    { elements: "SmallDisplacementElement", conditions: "SurfaceLoadCondition" },
    3
  );
  const text = writeMdpa(out.model, { sourceText: SRC });
  assert.match(text, /Begin Properties 7/);
  assert.match(text, /Begin Elements SmallDisplacementElement3D4N/);
  assert.match(text, /Begin Conditions SurfaceLoadCondition3D3N/);
  const round = parseMdpa(text);
  const block = round.blocks.find((b) => b.name === "SmallDisplacementElement3D4N");
  assert.ok(block);
  assert.equal(block.stride, 4);
  assert.equal(round.nodeCount, model.nodeCount);
});

test("resolveMeshNaming resolves $field and per-dimension bases", () => {
  const values = { elementBase: "TotalLagrangianElement" };
  const bases3 = resolveMeshNaming(structural.decl, values, 3);
  assert.deepEqual(bases3, {
    elements: "TotalLagrangianElement",
    conditions: "SurfaceLoadCondition",
  });
  const bases2 = resolveMeshNaming(structural.decl, values, 2);
  assert.equal(bases2.conditions, "LineLoadCondition");
  // Plain-string spec applies to both sizes.
  assert.deepEqual(resolveMeshNaming(fluid.decl, {}, 2), {
    elements: "Element",
    conditions: "WallCondition",
  });
});
