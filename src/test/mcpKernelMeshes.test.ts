/**
 * The 17.13.0 kernel meshes through the MCP surface: mesh_derive's generate /
 * octreeMesh / octree / cadSurface kinds, segment + refinePatches chained in
 * mesh_transform, and the .step export's new freeform fit options.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { meshConvert, meshDerive, meshInfo, meshTransform, meshCapabilities } from "../mcp/tools";
import { generateMesh } from "../parser/kernelMeshes";
import { fieldCalcModel } from "../parser/fieldCalc";
import { extractSkinModel } from "../parser/extractSkin";
import { simplexifyModel } from "../parser/simplexify";
import { writeMdpa } from "../parser/writers/mdpaWriter";
import { icosphere } from "./fixtures/shapes";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "mcp-kernel-"));

async function writeCubeSkin(dir: string): Promise<string> {
  const box = await generateMesh({ kind: "generate", shape: "box", params: { dims: [2, 2, 2] } });
  const p = path.join(dir, "cube.mdpa");
  const tris = simplexifyModel(extractSkinModel(box.model).model).model;
  // The skin's block is named for its origin ("SkinQuad"); a file needs a name Kratos can decode.
  const skin = { ...tris, blocks: tris.blocks.map((b) => ({ ...b, kind: "Conditions" as const, name: "SurfaceCondition3D3N" })) };
  fs.writeFileSync(p, writeMdpa(skin));
  return p;
}

test("mesh_derive generate writes a mesh from nothing and refuses a missing shape", async () => {
  const dir = tmpDir();
  const out = path.join(dir, "rect.vtu");
  const r = (await meshDerive({ kind: "generate", shape: "rectangle", params: { dims: [5, 4] }, outputPath: out })) as { summary?: string };
  assert.ok(fs.existsSync(out));
  assert.match(r.summary ?? "", /Generated rectangle/);
  await assert.rejects(meshDerive({ kind: "generate", outputPath: out }), /needs a `shape`/);
  await assert.rejects(meshDerive({ kind: "generate", shape: "sphere", outputPath: out }), /shape must be one of/);
});

test("mesh_derive octreeMesh and octree mesh the inside of a closed surface", async () => {
  const dir = tmpDir();
  const sphere = path.join(dir, "sphere.mdpa");
  fs.writeFileSync(sphere, writeMdpa(icosphere(1, 2)));
  const tets = path.join(dir, "tets.vtu");
  const r = (await meshDerive({ path: sphere, kind: "octreeMesh", options: { output: "tet", maxSize: 0.5, minSize: 0.25 }, outputPath: tets })) as { summary?: string };
  assert.ok(fs.existsSync(tets));
  assert.match(r.summary ?? "", /Octree tet mesh/);
  const lattice = path.join(dir, "octree.vtu");
  const o = (await meshDerive({ path: sphere, kind: "octree", maxLevel: 3, outputPath: lattice })) as { summary?: string };
  assert.ok(fs.existsSync(lattice));
  assert.match(o.summary ?? "", /Octree/);
});

test("mesh_derive cadSurface triangulates the B-rep of a fitted .cad.json, one SubModelPart per face", async () => {
  const dir = tmpDir();
  const cube = await writeCubeSkin(dir);
  await meshConvert({ path: cube, outputPath: path.join(dir, "box.step") });
  const cad = path.join(dir, "box.cad.json");
  assert.ok(fs.existsSync(cad), "the fit wrote the B-rep companion");

  const out = path.join(dir, "surface.mdpa");
  const r = (await meshDerive({ path: cad, kind: "cadSurface", targetSize: 0.25, outputPath: out })) as { summary?: string };
  assert.match(r.summary ?? "", /B-rep surface mesh of 6 face/);
  const info = (await meshInfo({ path: out })) as { subModelParts?: { name: string }[] };
  assert.ok(fs.existsSync(out));
  assert.ok(JSON.stringify(info).includes("face"), "faces arrive as named groups");

  await assert.rejects(meshDerive({ path: cad, kind: "cadSurface", outputPath: out }), /needs a `targetSize`/);
  await assert.rejects(meshDerive({ path: cube, kind: "cadSurface", targetSize: 0.2, outputPath: out }), /no B-rep side channel/);
});

async function cubeCad(dir: string): Promise<string> {
  const cube = await writeCubeSkin(dir);
  await meshConvert({ path: cube, outputPath: path.join(dir, "box.step") });
  return path.join(dir, "box.cad.json");
}

type CadReply = { summary?: string; blocks: { name: string; count: number }[]; cadSurface?: { triangles: number; refinementPoints: number; smoothed: number; angleHistogram: number[]; angleDeg: { min: number }; angleBound?: { requested: number; belowBound: boolean } } };
const derive = (args: object) => meshDerive(args as Parameters<typeof meshDerive>[0]) as Promise<CadReply>;

test("mesh_derive cadSurface: minAngle refines and smoothing moves points, reported in cadSurface and the summary", async () => {
  const dir = tmpDir();
  const cad = await cubeCad(dir);
  const plain = await derive({ path: cad, kind: "cadSurface", targetSize: 0.4, outputPath: path.join(dir, "plain.vtu") });
  const refined = await derive({ path: cad, kind: "cadSurface", targetSize: 0.4, cadOptions: { minAngle: 30, smoothIterations: 2 }, outputPath: path.join(dir, "refined.vtu") });
  assert.equal(plain.cadSurface?.refinementPoints, 0);
  assert.ok((refined.cadSurface?.refinementPoints ?? 0) > 0, JSON.stringify(refined.cadSurface));
  assert.ok((refined.cadSurface?.smoothed ?? 0) > 0);
  assert.ok((refined.cadSurface?.triangles ?? 0) > (plain.cadSurface?.triangles ?? 0));
  assert.equal(refined.cadSurface?.angleHistogram.length, 18);
  assert.ok((refined.cadSurface?.angleDeg.min ?? 0) >= 30, "the bound is met on a cube");
  assert.equal(refined.cadSurface?.angleBound?.requested, 30);
  assert.match(refined.summary ?? "", /Angle bound 30°.*met/);
});

test("mesh_derive cadSurface: order 2 gives quadratic triangles and lines, order 3 is refused by name", async () => {
  const dir = tmpDir();
  const cad = await cubeCad(dir);
  const out = path.join(dir, "curved.vtu");
  const r = await derive({ path: cad, kind: "cadSurface", targetSize: 0.4, cadOptions: { order: 2 }, outputPath: out });
  assert.match(r.summary ?? "", /Quadratic output/);
  assert.deepEqual(r.blocks.map((b) => b.name).sort(), ["line3", "triangle6"], "quadratic surface and edge cells, named for their type like the linear result");
  const back = (await meshInfo({ path: out })) as { blocks?: { name: string }[] };
  assert.deepEqual((back.blocks ?? []).map((b) => b.name).sort(), ["VtkCell_21", "VtkCell_22"], "the written .vtu re-reads with VTK quadratic edge (21) and quadratic triangle (22) cells");
  await assert.rejects(derive({ path: cad, kind: "cadSurface", targetSize: 0.4, cadOptions: { order: 3 }, outputPath: out }), /triangle10 \/ line4/);
});

test("mesh_derive cadSurface: faceSizes refine one face, a face that is not in the B-rep is named, unknown options are refused", async () => {
  const dir = tmpDir();
  const cad = await cubeCad(dir);
  const out = path.join(dir, "sized.vtu");
  const plain = await derive({ path: cad, kind: "cadSurface", targetSize: 0.4, outputPath: out });
  const fine = await derive({ path: cad, kind: "cadSurface", targetSize: 0.4, cadOptions: { faceSizes: { 0: 0.1 } }, outputPath: out });
  assert.ok((fine.cadSurface?.triangles ?? 0) > (plain.cadSurface?.triangles ?? 0) * 2, `${fine.cadSurface?.triangles} vs ${plain.cadSurface?.triangles}`);
  await assert.rejects(derive({ path: cad, kind: "cadSurface", targetSize: 0.4, cadOptions: { faceSizes: { 99: 0.1 } }, outputPath: out }), /face 99 is not a face of the B-rep/);
  await assert.rejects(derive({ path: cad, kind: "cadSurface", targetSize: 0.4, cadOptions: { minAngel: 30 } as never, outputPath: out }), /Unknown CAD meshing option/);
  await assert.rejects(derive({ path: cad, kind: "cadSurface", targetSize: 0.4, cadOptions: { reparamConditionNumber: 5, order: 2 }, outputPath: out }), /order 1 only/);
});

test("mesh_derive cadSurface: a background mesh supplies the size field and is not copied into the recorded recipe", async () => {
  const dir = tmpDir();
  const cad = await cubeCad(dir);
  const box = await generateMesh({ kind: "generate", shape: "box", params: { dims: [4, 4, 4] } });
  const sized = fieldCalcModel(box.model, { expr: "0.12", location: "Nodal", output: "SIZE" }).model;
  const bg = path.join(dir, "size.mdpa");
  fs.writeFileSync(bg, writeMdpa(sized));
  const out = path.join(dir, "bg.vtu");
  const plain = await derive({ path: cad, kind: "cadSurface", targetSize: 0.4, outputPath: path.join(dir, "p.vtu") });
  const r = (await derive({ path: cad, kind: "cadSurface", targetSize: 0.4, cadOptions: { backgroundPath: bg, backgroundArray: "SIZE" }, outputPath: out, provenance: "sidecar" })) as CadReply;
  assert.ok((r.cadSurface?.triangles ?? 0) > (plain.cadSurface?.triangles ?? 0), "the finer background size takes effect");
  const sidecar = fs.readFileSync(out + ".kratosexport.json", "utf8");
  assert.ok(sidecar.includes("size.mdpa") && !sidecar.includes("coords"), "the recipe names the file, not the mesh");
  await assert.rejects(derive({ path: cad, kind: "cadSurface", targetSize: 0.4, cadOptions: { backgroundPath: bg, backgroundArray: "NOPE" }, outputPath: out }), /no one-component Nodal field "NOPE" \(it has: SIZE\)/);
});

test("mesh_convert .step accepts the 17.13.0 freeform fit options", async () => {
  const dir = tmpDir();
  const cube = await writeCubeSkin(dir);
  const out = path.join(dir, "adaptive.step");
  const r = (await meshConvert({ path: cube, outputPath: out, fitCad: { freeformMode: "adaptive" } })) as { warnings: string[] };
  assert.ok(fs.existsSync(out));
  assert.ok(r.warnings.some((w) => /fitted CAD B-rep via fitCad/.test(w)), r.warnings.join(" | "));
  assert.ok(r.warnings.some((w) => /freeform adaptive/.test(w)), "the report states the freeform mode: " + r.warnings.join(" | "));
});

test("mesh_transform chains segment then refinePatches on a surface", async () => {
  const dir = tmpDir();
  const cube = await writeCubeSkin(dir);
  const out = path.join(dir, "patched.mdpa");
  const r = (await meshTransform({
    path: cube,
    outputPath: out,
    ops: [{ op: "segment", createParts: true }, { op: "refinePatches", maxIterations: 2 }],
  })) as { messages?: string[]; steps?: unknown };
  assert.ok(fs.existsSync(out));
  assert.match(fs.readFileSync(out, "utf8"), /Begin ConditionalData SEGMENT_PATCH/);
  assert.match(JSON.stringify(r), /Segmented 48 surface cell\(s\) into 6 patch/);
});

test("mesh_capabilities names the new operations as available", async () => {
  const caps = (await meshCapabilities()) as { operations: { available: string[]; unavailable: { name: string }[] } };
  for (const name of ["segment", "refinePatches", "octree", "octreeMesh", "meshCadSurface"]) {
    assert.ok(caps.operations.available.includes(name), name);
    assert.ok(!caps.operations.unavailable.some((u) => u.name.startsWith(name)), `${name} is not also unavailable`);
  }
});
