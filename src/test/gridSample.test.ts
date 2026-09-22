/**
 * Grids, voxelization and sampled signed-distance volumes, over the real WASM
 * and against simple solids: spacing, bounds, inside/outside conventions and the
 * memory limit are checked, not assumed.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { sampleGrid, estimateGrid, describeGridEstimate, triangleSurfaceOf, GRID_MAX_CELLS } from "../parser/gridSample";
import { deriveMesh } from "../parser/deriveMesh";
import { writeRawMeshioBytes } from "../parser/meshio";
import { parseVtkXml } from "../parser/vtkXmlParser";
import { parseMdpa } from "../parser/mdpaParser";
import { MdpaModel } from "../parser/types";
import { icosphere, tetBar } from "./fixtures/shapes";

const model = (t: string): MdpaModel => {
  const r = parseMdpa(t) as unknown as { model?: MdpaModel };
  return (r.model ?? (r as unknown as MdpaModel)) as MdpaModel;
};

/** The unit cube [0,1]^3 as 12 outward-wound triangles. */
function cube(): MdpaModel {
  const n = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
  const t = [[1,3,2],[1,4,3],[5,6,7],[5,7,8],[1,2,6],[1,6,5],[3,4,8],[3,8,7],[1,5,8],[1,8,4],[2,3,7],[2,7,6]];
  return model(
    "Begin Nodes\n" + n.map((p, i) => `${i + 1} ${p.join(" ")}`).join("\n") + "\nEnd Nodes\nBegin Conditions SurfaceCondition3D3N\n" +
      t.map((c, i) => `${i + 1} 0 ${c.join(" ")}`).join("\n") + "\nEnd Conditions\n"
  );
}
const field = (m: MdpaModel, name: string) => m.fields.find((f) => f.variable === name);

test("a regular grid has the requested cells, spacing and bounds, and needs no input mesh", async () => {
  const r = await sampleGrid(parseMdpa(""), { kind: "grid", dims: [4, 3, 2], origin: [1, 2, 3], spacing: [0.5, 1, 2] });
  assert.equal(r.model.blocks[0].count, 24);
  assert.equal(r.model.nodeCount, 5 * 4 * 3);
  assert.deepEqual(r.model.bounds.min.map((v) => +v.toFixed(6)), [1, 2, 3]);
  assert.deepEqual(r.model.bounds.max.map((v) => +v.toFixed(6)), [3, 5, 7]);
  assert.equal(r.denseLattice, true);
  assert.match(r.summary, /4 × 3 × 2 = 24 cells, 60 points/);
  await assert.rejects(sampleGrid(parseMdpa(""), { kind: "grid", dims: [0, 1, 1] }), /three positive integers/);
  await assert.rejects(sampleGrid(parseMdpa(""), { kind: "grid", dims: [1, 1, 1], spacing: [1, -1, 1] }), /positive/);
  await assert.rejects(sampleGrid(parseMdpa(""), { kind: "grid", dims: [1000, 1000, 1000] }), /over 20,000,000/);
});

test("voxelizing a unit cube on an aligned lattice occupies exactly the 4x4x4 cells whose centres are inside", async () => {
  const r = await sampleGrid(cube(), { kind: "voxelize", cellSize: 0.25, bounds: [-0.5, -0.5, -0.5, 1.5, 1.5, 1.5], fill: "inside" });
  assert.equal(r.model.blocks[0].count, 64);
  const occ = field(r.model, "VOXEL_OCCUPANCY")!;
  assert.equal(occ.ids.length, 64);
  assert.ok([...occ.values].every((v) => v === 1));
  assert.equal(r.denseLattice, false, "a partial lattice cannot be .vti");
  // Every occupied cell sits inside the cube.
  const b = r.model.bounds;
  assert.ok(b.min.every((v) => v >= -1e-6) && b.max.every((v) => v <= 1 + 1e-6));
  assert.match(r.summary, /64 of 512 cells written.*cannot be written as \.vti/);
  // "all" keeps the whole box and IS a dense lattice; "surface" is a thin shell.
  const all = await sampleGrid(cube(), { kind: "voxelize", cellSize: 0.25, bounds: [-0.5, -0.5, -0.5, 1.5, 1.5, 1.5], fill: "all" });
  assert.equal(all.model.blocks[0].count, 512);
  assert.equal(all.denseLattice, true);
  const shell = await sampleGrid(cube(), { kind: "voxelize", cellSize: 0.25, bounds: [-0.5, -0.5, -0.5, 1.5, 1.5, 1.5], fill: "surface" });
  assert.ok(shell.model.blocks[0].count > 0 && shell.model.blocks[0].count < 512);
});

test("a signed-distance volume of a sphere is negative inside and tracks |x| − R", async () => {
  const R = 1;
  const r = await sampleGrid(icosphere(R, 3), { kind: "sdfVolume", cellSize: 0.25 });
  const sdf = field(r.model, "SDF_DISTANCE")!;
  assert.equal(sdf.ids.length, r.model.nodeCount, "one value per lattice node");
  const idx = new Map<number, number>();
  for (let i = 0; i < r.model.nodeCount; i++) idx.set(r.model.nodeIds[i], i);
  let inside = 0;
  for (let i = 0; i < sdf.ids.length; i++) {
    const o = idx.get(sdf.ids[i])! * 3;
    const rad = Math.hypot(r.model.coords[o], r.model.coords[o + 1], r.model.coords[o + 2]);
    // Exact for the polyhedron it measures against, so within its chord sag (~0.03) of the sphere.
    assert.ok(Math.abs(sdf.values[i] - (rad - R)) < 0.05, `sdf ${sdf.values[i]} vs ${rad - R}`);
    if (rad < 0.9) {
      assert.ok(sdf.values[i] < 0, "inside is negative");
      inside++;
    }
    if (rad > 1.1) assert.ok(sdf.values[i] > 0, "outside is positive");
  }
  assert.ok(inside > 50);
  assert.equal(r.denseLattice, true);
  assert.match(r.summary, /Negative is inside/);
  assert.match(r.summary, /keeps the sdf:\* header/);
});

test("the estimate matches the lattice the wasm actually builds, before anything is allocated", async () => {
  const sphere = icosphere(1, 2);
  const { surface } = triangleSurfaceOf(sphere);
  const est = estimateGrid(surface.bounds, { cellSize: 0.25 }, 0.1);
  const r = await sampleGrid(sphere, { kind: "sdfVolume", cellSize: 0.25 });
  assert.deepEqual(est.dims, r.estimate.dims);
  assert.match(describeGridEstimate(est), /cells, .* points \(about/);
  // A request far over the limit is refused by name, without running anything.
  await assert.rejects(sampleGrid(sphere, { kind: "voxelize", cellSize: 0.001 }), /lattice would have .* cells \(over 20,000,000\)/);
  assert.ok(estimateGrid(surface.bounds, { cellSize: 0.001 }).cells > GRID_MAX_CELLS);
});

test("an octree is sized by depth, not by cell size, and is never a dense lattice", async () => {
  const r = await sampleGrid(icosphere(1, 2), { kind: "sdfVolume", structure: "octree", rootResolution: 4, maxDepth: 2 });
  assert.equal(r.denseLattice, false);
  assert.match(r.summary, /octree.*hanging nodes.*cannot be written as \.vti/);
  await assert.rejects(sampleGrid(icosphere(1, 2), { kind: "sdfVolume", structure: "octree", cellSize: 0.25 }), /rootResolution and maxDepth/);
});

test("a solid is sampled by its boundary skin, an open surface warns that the sign is unreliable, and lines have no inside", async () => {
  const solid = await sampleGrid(tetBar(2), { kind: "voxelize", cellSize: 0.5, paddingRelative: 0.1 });
  assert.match(solid.summary, /boundary skin/);
  const open = icosphere(1, 2, false, (p) => p[2] >= 0);
  const r = await sampleGrid(open, { kind: "sdfVolume", cellSize: 0.4 });
  assert.match(r.summary, /surface is not closed.*SIGN is unreliable/);
  const lines = model("Begin Nodes\n1 0 0 0\n2 1 0 0\nEnd Nodes\nBegin Elements Element2D2N\n1 0 1 2\nEnd Elements\n");
  await assert.rejects(sampleGrid(lines, { kind: "voxelize", cellSize: 0.5 }), /no surface faces/);
});

test("the size options are validated: exactly one of resolution / cellSize, positive, and bounds ordered", async () => {
  const c = cube();
  await assert.rejects(sampleGrid(c, { kind: "voxelize" }), /exactly one of cellSize or resolution/);
  await assert.rejects(sampleGrid(c, { kind: "voxelize", cellSize: 0.5, resolution: [4, 4, 4] }), /exactly one/);
  await assert.rejects(sampleGrid(c, { kind: "voxelize", cellSize: -1 }), /positive/);
  await assert.rejects(sampleGrid(c, { kind: "voxelize", resolution: [0, 1, 1] }), /positive integers/);
  await assert.rejects(sampleGrid(c, { kind: "voxelize", cellSize: 0.5, bounds: [1, 1, 1, 0, 0, 0] }), /max above min/);
  await assert.rejects(sampleGrid(c, { kind: "voxelize", cellSize: 5, bounds: [-0.5, -0.5, -0.5, 1.5, 1.5, 1.5] }), /No voxel is occupied/);
});

test("a dense lattice is written as .vti straight from meshio++ and reads back with the same spacing; the derive dispatcher carries it", async () => {
  const d = await deriveMesh(parseMdpa(""), { kind: "grid", dims: [4, 3, 2], spacing: [0.5, 0.5, 0.5] });
  assert.ok(d.raw && d.denseLattice);
  const out = await writeRawMeshioBytes(d.raw!, ".vti", "vti", { stem: "g" });
  assert.match(Buffer.from(out.data).toString("utf8", 0, 200), /type="ImageData"/);
  const back = parseVtkXml(Buffer.from(out.data));
  assert.equal(back.nodeCount, 5 * 4 * 3);
  assert.equal(back.blocks.reduce((s, b) => s + b.count, 0), 24);
  assert.deepEqual(back.bounds.max.map((v) => +v.toFixed(6)), [2, 1.5, 1]);
  // A partial lattice is flagged so the callers (menu + MCP) refuse .vti by name.
  const partial = await sampleGrid(cube(), { kind: "voxelize", cellSize: 0.25, bounds: [-0.5, -0.5, -0.5, 1.5, 1.5, 1.5] });
  assert.equal(partial.denseLattice, false);
  // The dense sdf lattice keeps its sdf:* header in the file.
  const sdf = await sampleGrid(icosphere(1, 2), { kind: "sdfVolume", cellSize: 0.5 });
  const sdfOut = await writeRawMeshioBytes(sdf.raw, ".vti", "vti");
  assert.match(Buffer.from(sdfOut.data).toString("utf8"), /sdf:/);
});
