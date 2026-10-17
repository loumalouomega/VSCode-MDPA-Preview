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
    { elements: { base: "SmallDisplacementElement" }, conditions: { base: "SurfaceLoadCondition" } },
    3
  );
  assert.deepEqual(
    out.renames,
    [
      { kind: "Elements", from: "Element3D4N", to: "SmallDisplacementElement3D4N" },
      { kind: "Conditions", from: "WallCondition3D3N", to: "SurfaceLoadCondition3D3N" },
    ]
  );
  assert.deepEqual(out.problems, []);
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
  const out = adaptMeshNames(model, { elements: { base: "Element" }, conditions: { base: "WallCondition" } }, 3);
  assert.equal(out.renames.length, 0);
  assert.equal(out.model, model); // same reference — no copy
});

test("adaptMeshNames without bases leaves everything alone", () => {
  const model = parseMdpa(SRC);
  const out = adaptMeshNames(model, {}, 3);
  assert.equal(out.model, model);
  assert.deepEqual(out.renames, []);
  assert.deepEqual(out.warnings, []);
  assert.deepEqual(out.problems, []);
});

test("adapted model round-trips through the mdpa writer with Properties preserved", () => {
  const model = parseMdpa(SRC);
  const out = adaptMeshNames(
    model,
    { elements: { base: "SmallDisplacementElement" }, conditions: { base: "SurfaceLoadCondition" } },
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
  assert.equal(bases3.elements?.base, "TotalLagrangianElement");
  assert.equal(bases3.conditions?.base, "SurfaceLoadCondition");
  const bases2 = resolveMeshNaming(structural.decl, values, 2);
  assert.equal(bases2.conditions?.base, "LineLoadCondition");
  // Plain-string spec applies to both sizes.
  const fluidNaming = resolveMeshNaming(fluid.decl, {}, 2);
  assert.equal(fluidNaming.elements?.base, "Element");
  assert.equal(fluidNaming.conditions?.base, "WallCondition");
});

test("adaptMeshNames skips one-node PARTICLE element blocks", () => {
  // An Exodus SPHERE (or a Kratos DEM sphere) arrives as a one-node Elements
  // block. Renaming it to `${base}3D1N` would invent a name no solver has; the
  // guard used to cover Conditions only.
  const model = parseMdpa(`Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
End Nodes

Begin Elements SphericParticle3D
1 0 1
2 0 2
End Elements
`);
  const out = adaptMeshNames(model, { elements: { base: "SmallDisplacementElement" } }, 3);
  assert.equal(out.model.blocks[0].name, "SphericParticle3D");
  assert.deepEqual(out.renames, []);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /Particle element block/);
});

// A declaration whose element names come from a per-formulation table: shells
// (a shape table), spring-dampers (a template) and cables (one verbatim name).
const TABLE_DECL = {
  ...structural.decl,
  meshNaming: {
    elements: {
      field: "elementBase",
      names: {
        ShellThinElementCorotational: {
          3: { 3: "ShellThinElementCorotational3D3N", 4: "ShellThinElementCorotational3D4N" },
        },
        SpringDamperElement: "SpringDamperElement{dim}",
        CableElement: "CableElement3D2N",
      },
    },
  },
};

test("resolveMeshNaming tables a formulation's names (shapes, template, verbatim)", () => {
  const shell = resolveMeshNaming(TABLE_DECL, { elementBase: "ShellThinElementCorotational" }, 3).elements;
  assert.deepEqual(shell?.shapes, {
    "3D3N": "ShellThinElementCorotational3D3N",
    "3D4N": "ShellThinElementCorotational3D4N",
  });
  assert.equal(shell?.source, "ShellThinElementCorotational");
  // The template is carried as written; the renamer substitutes per shape.
  const spring = resolveMeshNaming(TABLE_DECL, { elementBase: "SpringDamperElement" }, 2).elements;
  assert.equal(spring?.template, "SpringDamperElement{dim}");
  const cable = resolveMeshNaming(TABLE_DECL, { elementBase: "CableElement" }, 3).elements;
  assert.equal(cable?.template, "CableElement3D2N");
  // A value with no entry keeps the legacy meaning: the value is a base.
  const solid = resolveMeshNaming(TABLE_DECL, { elementBase: "TotalLagrangianElement" }, 3).elements;
  assert.equal(solid?.base, "TotalLagrangianElement");
  // Nothing selected → the kind is omitted, so its blocks stay untouched.
  assert.equal(resolveMeshNaming(TABLE_DECL, {}, 3).elements, undefined);
});

test("adaptMeshNames renames through a shape table, substituting templates", () => {
  const model = parseMdpa(`Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
4 0.0 0.0 1.0
End Nodes

Begin Elements Element3D2N
1 0 1 2
End Elements
`);
  const spring = adaptMeshNames(model, resolveMeshNaming(TABLE_DECL, { elementBase: "SpringDamperElement" }, 3), 3);
  assert.deepEqual(spring.renames, [{ kind: "Elements", from: "Element3D2N", to: "SpringDamperElement3D" }]);
  const cable = adaptMeshNames(model, resolveMeshNaming(TABLE_DECL, { elementBase: "CableElement" }, 3), 3);
  assert.deepEqual(cable.renames, [{ kind: "Elements", from: "Element3D2N", to: "CableElement3D2N" }]);
});

test("a shape missing from the table is a problem, not an invented name", () => {
  const model = parseMdpa(`Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
4 0.0 0.0 1.0
End Nodes

Begin Elements Element3D3N
1 0 1 2 3
End Elements

Begin Elements Element3D8N
2 0 1 2 3 4 1 2 3
End Elements
`);
  const out = adaptMeshNames(model, resolveMeshNaming(TABLE_DECL, { elementBase: "ShellThinElementCorotational" }, 3), 3);
  assert.deepEqual(out.renames, [
    { kind: "Elements", from: "Element3D3N", to: "ShellThinElementCorotational3D3N" },
  ]);
  assert.equal(out.problems.length, 1);
  assert.equal(out.problems[0].kind, "Elements");
  assert.equal(out.problems[0].block, "Element3D8N");
  assert.equal(out.problems[0].shape, "3D8N");
  assert.match(out.problems[0].message, /has no "ShellThinElementCorotational" variant/);
  assert.match(out.problems[0].message, /names 3D3N, 3D4N/);
  // The unnameable block keeps its name; nothing is invented.
  assert.equal(out.model.blocks[1].name, "Element3D8N");
});

test("a shape table naming one-node elements lifts the particle guard", () => {
  const decl = {
    ...structural.decl,
    meshNaming: {
      elements: {
        field: "elementBase",
        names: {
          NodalConcentratedElement: {
            2: { 1: "NodalConcentratedElement2D1N" },
            3: { 1: "NodalConcentratedElement3D1N" },
          },
        },
      },
    },
  };
  const model = parseMdpa(`Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
End Nodes

Begin Elements PointMass
1 0 1
2 0 2
End Elements
`);
  const out = adaptMeshNames(model, resolveMeshNaming(decl, { elementBase: "NodalConcentratedElement" }, 3), 3);
  assert.deepEqual(out.renames, [{ kind: "Elements", from: "PointMass", to: "NodalConcentratedElement3D1N" }]);
  assert.deepEqual(out.warnings, []);
});
