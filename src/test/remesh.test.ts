import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { remeshModel, levelsetModel } from "../parser/remesh";
import { linearToQuadratic } from "../parser/linearToQuadratic";
import { MdpaModel } from "../parser/types";

// A unit cube split into 6 tetrahedra around the 1–7 diagonal, with one
// SubModelPart and a signed-distance nodal field (plane x = 0.5).
const CUBE = `Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 1.0 1.0 0.0
4 0.0 1.0 0.0
5 0.0 0.0 1.0
6 1.0 0.0 1.0
7 1.0 1.0 1.0
8 0.0 1.0 1.0
End Nodes

Begin Elements Element3D4N
1 0 1 2 3 7
2 0 1 3 4 7
3 0 1 4 8 7
4 0 1 8 5 7
5 0 1 5 6 7
6 0 1 6 2 7
End Elements

Begin SubModelPart Lower
  Begin SubModelPartNodes
    1
    2
  End SubModelPartNodes
  Begin SubModelPartElements
    1
    2
  End SubModelPartElements
End SubModelPart

Begin NodalData DISTANCE
1 0 -0.5
2 0 0.5
3 0 0.5
4 0 -0.5
5 0 -0.5
6 0 0.5
7 0 0.5
8 0 -0.5
End NodalData
`;

const cube = (): MdpaModel => parseMdpa(CUBE);

// A two-triangle patch; z values pick surface (mmgs) vs planar (mmg2d).
function patch(z: [number, number, number, number]): MdpaModel {
  return parseMdpa(`Begin Nodes
1 0.0 0.0 ${z[0]}
2 1.0 0.0 ${z[1]}
3 1.0 1.0 ${z[2]}
4 0.0 1.0 ${z[3]}
End Nodes

Begin Elements Element3D3N
1 0 1 2 3
2 0 1 3 4
End Elements
`);
}

test("remesh factor < 1 refines a tet mesh and keeps block + SubModelPart", async () => {
  const m = cube();
  const r = await remeshModel(m, { mode: "factor", factor: 0.4 });
  assert.ok(!r.noop, r.message);
  assert.ok(r.model.nodeCount > m.nodeCount);
  // One tet block survives under its original name; no stray boundary blocks.
  assert.equal(r.model.blocks.length, 1);
  assert.equal(r.model.blocks[0].name, "Element3D4N");
  assert.equal(r.model.blocks[0].stride, 4);
  const tets = r.model.blocks[0].count;
  assert.ok(tets > 6);
  // Entity ids were renumbered densely from 1.
  assert.equal(r.model.blocks[0].entityIds[0], 1);
  assert.equal(r.model.blocks[0].entityIds[tets - 1], tets);
  // The SubModelPart survived via ref signatures, with rebuilt node closure.
  assert.equal(r.model.subModelParts.length, 1);
  const smp = r.model.subModelParts[0];
  assert.equal(smp.path, "Lower");
  assert.ok(smp.elementIds.length > 0);
  assert.ok(smp.nodeIds.length > 0);
  // Fields cannot follow the remesh: dropped, and the message says so.
  assert.equal(r.model.fields.length, 0);
  assert.match(r.message, /field/);
  assert.match(r.message, /mmg3d/);
});

test("remesh is deterministic (same input → same mesh)", async () => {
  const a = await remeshModel(cube(), { mode: "factor", factor: 0.5 });
  const b = await remeshModel(cube(), { mode: "factor", factor: 0.5 });
  assert.equal(a.model.nodeCount, b.model.nodeCount);
  assert.deepEqual([...a.model.coords], [...b.model.coords]);
});

test("remesh hsiz + optimize modes produce valid meshes", async () => {
  const uniform = await remeshModel(cube(), { mode: "hsiz", hsiz: 0.25 });
  assert.ok(!uniform.noop);
  assert.ok(uniform.model.nodeCount > 8);

  const opt = await remeshModel(cube(), { mode: "optimize" });
  assert.ok(!opt.noop);
  assert.ok(opt.model.blocks[0].count >= 6);
});

test("remesh respects hmin/hmax bounds", async () => {
  // A generous hmin forbids refinement below it → far fewer nodes than 0.1 alone.
  const fine = await remeshModel(cube(), { mode: "hsiz", hsiz: 0.1 });
  const clamped = await remeshModel(cube(), { mode: "hsiz", hsiz: 0.1, hmin: 0.4, hmax: 0.6 });
  assert.ok(clamped.model.nodeCount < fine.model.nodeCount);
});

test("auto-detect: non-planar triangles → mmgs, planar → mmg2d", async () => {
  const surf = await remeshModel(patch([0, 0.2, 0, 0.3]), { mode: "hsiz", hsiz: 0.2 });
  assert.ok(!surf.noop, surf.message);
  assert.match(surf.message, /mmgs/);

  const flat = await remeshModel(patch([0, 0, 0, 0]), { mode: "hsiz", hsiz: 0.2 });
  assert.ok(!flat.noop, flat.message);
  assert.match(flat.message, /mmg2d/);
  // mmg2d output stays in its source plane.
  for (let i = 0; i < flat.model.nodeCount; i++) {
    assert.equal(flat.model.coords[i * 3 + 2], 0);
  }
});

test("module override is validated against the mesh", async () => {
  const forced = await remeshModel(cube(), { mode: "factor", factor: 0.5, module: "mmgs" });
  assert.equal(forced.noop, true);
  assert.match(forced.message, /tetrahedra/i);
});

test("unsupported meshes are rejected with a message", async () => {
  const hex = parseMdpa(`Begin Nodes
1 0 0 0
2 1 0 0
3 1 1 0
4 0 1 0
5 0 0 1
6 1 0 1
7 1 1 1
8 0 1 1
End Nodes

Begin Elements Element3D8N
1 0 1 2 3 4 5 6 7 8
End Elements
`);
  const r = await remeshModel(hex, { mode: "factor", factor: 0.5 });
  assert.equal(r.noop, true);
  assert.match(r.message, /not remeshable/);

  // Quadratic meshes (after Linear → Quadratic) cannot be remeshed either.
  const quad = linearToQuadratic(cube()).model;
  const rq = await remeshModel(quad, { mode: "factor", factor: 0.5 });
  assert.equal(rq.noop, true);
});

test("levelset splits the domain and creates interface blocks", async () => {
  const r = await levelsetModel(cube(), { variable: "DISTANCE" });
  assert.ok(!r.noop, r.message);
  const names = r.model.blocks.map((b) => b.name);
  assert.ok(names.includes("MMG_Domain_Inside"), names.join(","));
  assert.ok(names.includes("MMG_Domain_Outside"), names.join(","));
  assert.ok(names.includes("MMG_Interface"), names.join(","));
  const iface = r.model.blocks.find((b) => b.name === "MMG_Interface");
  assert.equal(iface?.kind, "Conditions");
  assert.equal(iface?.stride, 3);
  // Interface vertices sit on the φ = 0 plane x = 0.5.
  for (const nodeId of iface!.connectivity) {
    const i = [...r.model.nodeIds].indexOf(nodeId);
    assert.ok(Math.abs(r.model.coords[i * 3] - 0.5) < 1e-4);
  }
  // Every created region is also exposed as a SubModelPart (with node closure)
  // so it can be exported/deleted and survives a save to .mdpa.
  const partPaths = r.model.subModelParts.map((p) => p.path);
  assert.ok(partPaths.includes("MMG_Domain_Inside"), partPaths.join(","));
  assert.ok(partPaths.includes("MMG_Domain_Outside"), partPaths.join(","));
  assert.ok(partPaths.includes("MMG_Interface"), partPaths.join(","));
  const inside = r.model.subModelParts.find((p) => p.path === "MMG_Domain_Inside")!;
  const insideBlock = r.model.blocks.find((b) => b.name === "MMG_Domain_Inside")!;
  assert.equal(inside.elementIds.length, insideBlock.count);
  assert.ok(inside.nodeIds.length > 0);
  const ifacePart = r.model.subModelParts.find((p) => p.path === "MMG_Interface")!;
  assert.equal(ifacePart.conditionIds.length, iface!.count);

  // A second level-set on the result must not collide with the surviving
  // MMG part paths (fields are gone, so re-attach a distance field first).
  const again = r.model;
  again.fields = [
    {
      kind: "Nodal",
      variable: "D2",
      components: 1,
      ids: Int32Array.from(again.nodeIds),
      values: Float64Array.from([...again.nodeIds].map((_, i) => again.coords[i * 3 + 1] - 0.5)),
    },
  ];
  const r2 = await levelsetModel(again, { variable: "D2" });
  assert.ok(!r2.noop, r2.message);
  const paths2 = r2.model.subModelParts.map((p) => p.path);
  assert.equal(new Set(paths2).size, paths2.length, `duplicate paths: ${paths2.join(",")}`);
});

test("level-set on a large-coordinate mesh stays bounded (relative hausd default)", async () => {
  // MMG's own hausd default is absolute (0.01): on a 100-unit domain it would
  // demand a huge interface refinement. The relative default must keep this
  // as cheap as the unit-cube case.
  const m = cube();
  for (let i = 0; i < m.coords.length; i++) m.coords[i] *= 100;
  m.bounds = { min: [0, 0, 0], max: [100, 100, 100] };
  const f = m.fields[0];
  for (let i = 0; i < f.values.length; i++) f.values[i] *= 100;
  const r = await levelsetModel(m, { variable: "DISTANCE" });
  assert.ok(!r.noop, r.message);
  assert.ok(
    r.model.nodeCount < 4000,
    `interface refinement exploded: ${r.model.nodeCount} nodes`
  );
});

test("remesh reports progress: stage messages + MMG phase lines", async () => {
  const lines: string[] = [];
  const r = await remeshModel(cube(), { mode: "hsiz", hsiz: 0.3 }, (m) => lines.push(m));
  assert.ok(!r.noop);
  assert.ok(lines.some((l) => l.includes("Preparing")), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("Running mmg3d")), lines.join("\n"));
  assert.ok(lines.some((l) => /PHASE 1/.test(l)), lines.join("\n"));
  // Banner decoration is filtered out.
  assert.ok(!lines.some((l) => l.startsWith("&")));
});

test("levelset validates the field", async () => {
  const missing = await levelsetModel(cube(), { variable: "NOPE" });
  assert.equal(missing.noop, true);
  assert.match(missing.message, /No nodal field/);

  const partial = cube();
  partial.fields = [
    {
      kind: "Nodal",
      variable: "PART",
      components: 1,
      ids: Int32Array.from([1, 2]),
      values: Float64Array.from([-1, 1]),
    },
  ];
  const r = await levelsetModel(partial, { variable: "PART" });
  assert.equal(r.noop, true);
  assert.match(r.message, /coverage/);
});
