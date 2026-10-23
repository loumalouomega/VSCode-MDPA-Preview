/**
 * New meshes made by meshio++ kernels that need no input beyond a skin or a
 * B-rep: procedural generators (17.9.0 / 17.11.0), the octree (17.8.0) and
 * octree-mesh (17.13.0) volume meshers, and the B-rep surface mesher
 * `meshCadSurface` (17.13.0).
 *
 * Every one is a DERIVED mesh (a new file, never an edit of the open mesh), so
 * `deriveMesh.ts` dispatches here and the UI export and MCP `mesh_derive`
 * share one path. The kernel result is read back through plain
 * `meshioToModel` — the output cells are newly created, so there is no
 * correspondence to the source to preserve — and upstream's colon-named
 * provenance arrays are renamed to legal Kratos variables.
 *
 * Pure module (no vscode / DOM): the wasm is loaded through `loadMeshio`.
 */

import type { MdpaDiagnostic, MdpaModel } from "./types";
import { meshioToModel, modelToMeshio } from "./meshioConvert";
import { loadMeshio } from "./meshio";
import { triangleSurfaceOf } from "./gridSample";
import { defaultBlockName } from "./cellInheritance";
import { reclassifyFlac3dFaces } from "./flac3dGroups";
import { cellCategory } from "./writers/writerCommon";

/** The most cells a generator may be asked for (the kernel's own default is 20 million). */
export const GENERATE_MAX_CELLS = 5_000_000;

type ArgType = "ints" | "nums" | "int" | "num" | "str" | "bool" | "strs";

interface ArgSpec {
  name: string;
  type: ArgType;
  /** Cells it multiplies into the estimate (for the pre-flight size check). */
  note?: string;
}

/**
 * The positional argument order of each generator, as index.d.ts declares it.
 * `maxCells` is appended by `generateMesh` itself and is never a caller input.
 */
export const GENERATORS = {
  rectangle: [
    { name: "dims", type: "ints" }, { name: "size", type: "nums" }, { name: "origin", type: "nums" },
    { name: "cellType", type: "str" }, { name: "split", type: "str" }, { name: "order", type: "int" },
  ],
  box: [
    { name: "dims", type: "ints" }, { name: "size", type: "nums" }, { name: "origin", type: "nums" },
    { name: "cellType", type: "str" }, { name: "order", type: "int" },
  ],
  disk: [
    { name: "radius", type: "num" }, { name: "n", type: "int" }, { name: "center", type: "nums" },
    { name: "cellType", type: "str" }, { name: "order", type: "int" },
  ],
  uvSphere: [
    { name: "radius", type: "num" }, { name: "nu", type: "int" }, { name: "nv", type: "int" },
    { name: "center", type: "nums" }, { name: "cellType", type: "str" }, { name: "order", type: "int" },
  ],
  icosaSphere: [
    { name: "radius", type: "num" }, { name: "subdivisions", type: "int" }, { name: "center", type: "nums" },
    { name: "order", type: "int" },
  ],
  cylinder: [
    { name: "radius", type: "num" }, { name: "height", type: "num" }, { name: "nxy", type: "int" },
    { name: "nz", type: "int" }, { name: "center", type: "nums" }, { name: "cellType", type: "str" },
    { name: "order", type: "int" },
  ],
  referenceTriangle: [
    { name: "n", type: "int" }, { name: "size", type: "nums" }, { name: "origin", type: "nums" },
    { name: "order", type: "int" },
  ],
  ngon: [
    { name: "sides", type: "int" }, { name: "radius", type: "num" }, { name: "rings", type: "int" },
    { name: "center", type: "nums" }, { name: "order", type: "int" },
  ],
  annulus: [
    { name: "innerRadius", type: "num" }, { name: "outerRadius", type: "num" }, { name: "ntheta", type: "int" },
    { name: "nr", type: "int" }, { name: "angle", type: "num" }, { name: "center", type: "nums" },
    { name: "cellType", type: "str" }, { name: "order", type: "int" },
  ],
  lshape: [
    { name: "n", type: "int" }, { name: "size", type: "num" }, { name: "center", type: "nums" },
    { name: "cellType", type: "str" }, { name: "order", type: "int" },
  ],
  plateWithHole: [
    { name: "radius", type: "num" }, { name: "size", type: "num" }, { name: "nt", type: "int" },
    { name: "nr", type: "int" }, { name: "center", type: "nums" }, { name: "cellType", type: "str" },
    { name: "order", type: "int" },
  ],
  honeycomb: [
    { name: "dims", type: "ints" }, { name: "edge", type: "num" }, { name: "origin", type: "nums" },
  ],
  referenceCells: [
    { name: "types", type: "strs" }, { name: "pairs", type: "bool" },
  ],
} as const satisfies Record<string, readonly ArgSpec[]>;

export type GeneratorShape = keyof typeof GENERATORS;
export const GENERATOR_SHAPES = Object.keys(GENERATORS) as GeneratorShape[];

/** A starting point for the "Generate mesh…" prompt: what each shape takes, with sizes that make a useful mesh. */
export const GENERATOR_EXAMPLES: Record<GeneratorShape, { description: string; params: Record<string, unknown> }> = {
  rectangle: { description: "regular quad or triangle grid, side regions xmin…ymax", params: { dims: [20, 10], size: [2, 1], cellType: "quad" } },
  box: { description: "regular hexahedron, tetra or wedge grid, six side regions", params: { dims: [10, 10, 10], size: [1, 1, 1], cellType: "hexahedron" } },
  disk: { description: "disk of quads (or triangles), region rim", params: { radius: 1, n: 12 } },
  uvSphere: { description: "latitude/longitude sphere surface", params: { radius: 1, nu: 32, nv: 16 } },
  icosaSphere: { description: "icosahedral sphere surface, 20·4^n triangles", params: { radius: 1, subdivisions: 3 } },
  cylinder: { description: "solid cylinder along z, regions side/top/bottom", params: { radius: 0.5, height: 2, nxy: 8, nz: 20 } },
  referenceTriangle: { description: "reference triangle refined into n·n triangles", params: { n: 8 } },
  ngon: { description: "regular polygon fanned or ringed with triangles", params: { sides: 6, radius: 1, rings: 4 } },
  annulus: { description: "annulus or sector, regions inner/outer (start/end)", params: { innerRadius: 0.5, outerRadius: 1, ntheta: 48, nr: 8 } },
  lshape: { description: "L-shaped domain with a re-entrant corner", params: { n: 8, size: 2 } },
  plateWithHole: { description: "square plate around a circular hole", params: { radius: 0.25, size: 1, nt: 8, nr: 8 } },
  honeycomb: { description: "pointy-top hexagon tiling (one polygon block)", params: { dims: [6, 6], edge: 1 } },
  referenceCells: { description: "one cell of every meshio type in reference coordinates", params: {} },
};

export interface GenerateSpec {
  kind: "generate";
  shape: GeneratorShape;
  /** The generator's own arguments by name (see GENERATORS); anything omitted takes the kernel default. */
  params?: Record<string, unknown>;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function coerceArg(shape: string, a: ArgSpec, v: unknown): unknown {
  const bad = (what: string) => new Error(`${shape}: "${a.name}" must be ${what}.`);
  switch (a.type) {
    case "int":
      if (!isNum(v) || !Number.isInteger(v)) throw bad("an integer");
      return v;
    case "num":
      if (!isNum(v)) throw bad("a finite number");
      return v;
    case "ints":
      if (!Array.isArray(v) || v.length === 0 || !v.every((x) => isNum(x) && Number.isInteger(x) && x >= 1)) throw bad("a list of positive integers");
      return v;
    case "nums":
      if (!Array.isArray(v) || v.length === 0 || !v.every(isNum)) throw bad("a list of finite numbers");
      return v;
    case "str":
      if (typeof v !== "string") throw bad("a string");
      return v;
    case "strs":
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw bad("a list of strings");
      return v;
    case "bool":
      if (typeof v !== "boolean") throw bad("true or false");
      return v;
  }
}

/**
 * Kratos-legal block names for a result a kernel named after meshio types
 * (`tetra`, `triangle`). When the result has volume cells, its surface blocks
 * that were read as Elements are the mesh's boundary faces — Conditions in
 * Kratos — so they move to their own id space first (the FLAC3D face rule).
 */
function withKratosBlockNames(model: MdpaModel): MdpaModel {
  const hasVolume = model.blocks.some((b) => b.count > 0 && cellCategory(b.vtkCellType) === "volume");
  const base = hasVolume ? reclassifyFlac3dFaces(model) : model;
  return {
    ...base,
    blocks: base.blocks.map((b) => {
      const name = defaultBlockName(b.kind, b.vtkCellType);
      return /^(Element|Condition|Geometry)_/.test(name) ? b : { ...b, name };
    }),
  };
}

/** Upper-cases the Kratos-style names of upstream's arrays (`meshioToModel` already turned `sdf:distance` into `sdf_distance`). */
function legalFields(model: MdpaModel, rename: Record<string, string> = {}): MdpaModel {
  return { ...model, fields: model.fields.map((f) => (rename[f.variable] ? { ...f, variable: rename[f.variable] } : f)) };
}

export interface KernelMeshResult {
  model: MdpaModel;
  summary: string;
  suffix: string;
}

/** Cells a generator will produce, estimated from the sizes alone, so a runaway request is refused before the wasm runs. */
export function estimateGeneratedCells(shape: GeneratorShape, p: Record<string, unknown>): number {
  const prod = (v: unknown, d: number[]) => (Array.isArray(v) ? v : d).reduce((s: number, x) => s * Number(x), 1);
  const num = (v: unknown, d: number) => (isNum(v) ? v : d);
  switch (shape) {
    case "rectangle": return prod(p.dims, [1, 1]) * (p.cellType === "triangle" ? 2 : 1);
    case "box": return prod(p.dims, [1, 1, 1]) * (p.cellType === "tetra" ? 6 : p.cellType === "wedge" ? 2 : 1);
    case "disk": { const n = num(p.n, 8); return n * n; }
    case "uvSphere": return num(p.nu, 16) * num(p.nv, 8) * 2;
    case "icosaSphere": return 20 * 4 ** Math.max(0, num(p.subdivisions, 2));
    case "cylinder": return num(p.nxy, 8) * num(p.nxy, 8) * num(p.nz, 8);
    case "referenceTriangle": return num(p.n, 4) ** 2;
    case "ngon": return num(p.sides, 6) * num(p.rings, 1) ** 2;
    case "annulus": return num(p.ntheta, 32) * num(p.nr, 4) * 2;
    case "lshape": { const n = num(p.n, 8); return 3 * n * n * 2; }
    case "plateWithHole": return 4 * num(p.nt, 8) * num(p.nr, 8) * 2;
    case "honeycomb": return prod(p.dims, [1, 1]);
    case "referenceCells": return 1;
  }
}

/** A procedural mesh (rectangle, box, disk, spheres, cylinder, planar test domains, reference cells). */
export async function generateMesh(spec: GenerateSpec, diagnostics: MdpaDiagnostic[] = []): Promise<KernelMeshResult> {
  const args = GENERATORS[spec.shape] as readonly ArgSpec[] | undefined;
  if (!args) throw new Error(`shape must be one of ${GENERATOR_SHAPES.join(", ")}.`);
  const params = spec.params ?? {};
  const known = new Set(args.map((a) => a.name));
  for (const k of Object.keys(params)) {
    if (!known.has(k)) throw new Error(`${spec.shape} has no parameter "${k}" (it takes ${[...known].join(", ")}).`);
  }
  const positional = args.map((a) => (params[a.name] === undefined || params[a.name] === null ? undefined : coerceArg(spec.shape, a, params[a.name])));
  const estimate = estimateGeneratedCells(spec.shape, params);
  if (!(estimate <= GENERATE_MAX_CELLS)) {
    throw new Error(`${spec.shape} with those sizes would have about ${Math.round(estimate).toLocaleString("en-US")} cells (over ${GENERATE_MAX_CELLS.toLocaleString("en-US")}). Use fewer cells.`);
  }
  const m = await loadMeshio();
  // referenceCells and honeycomb differ in arity: only the shapes with a maxCells slot get one.
  const withMax = spec.shape !== "referenceCells";
  const call = (m as unknown as Record<string, (...a: unknown[]) => unknown>)[spec.shape];
  const mesh = (withMax ? call.call(m, ...positional, GENERATE_MAX_CELLS) : call.call(m, ...positional)) as Parameters<typeof meshioToModel>[0];
  // referenceCells is a catalogue of one cell per meshio type: keep the type names.
  const read = meshioToModel(mesh, diagnostics);
  const model = spec.shape === "referenceCells" ? read : withKratosBlockNames(read);
  const cells = model.blocks.reduce((s, b) => s + b.count, 0);
  return {
    model,
    summary:
      `Generated ${spec.shape}: ${cells.toLocaleString("en-US")} cell(s), ${model.nodeCount.toLocaleString("en-US")} node(s)` +
      (model.subModelParts.length ? `; side regions as SubModelParts: ${model.subModelParts.map((p) => p.name).join(", ")}.` : "."),
    suffix: spec.shape,
  };
}

/** Options of `octreeMesh` (17.13.0); the kernel validates every key and range. */
export interface OctreeMeshSpec {
  kind: "octreeMesh";
  options?: Record<string, unknown>;
}

const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

/** A volume mesh of the inside of a skin on a balanced octree. */
export async function octreeMeshModel(model: MdpaModel, spec: OctreeMeshSpec, diagnostics: MdpaDiagnostic[] = []): Promise<KernelMeshResult> {
  const { surface, note } = triangleSurfaceOf(model);
  const m = await loadMeshio();
  const options = defined(spec.options ?? {});
  const r = m.octreeMesh(modelToMeshio(surface, diagnostics, { dim: 3 }), options);
  const read = legalFields(withKratosBlockNames(meshioToModel(r.mesh as Parameters<typeof meshioToModel>[0], diagnostics)), { sdf_distance: "SDF_DISTANCE" });
  const f = (x: number) => (Number.isFinite(x) ? +x.toPrecision(4) : "n/a");
  const parts: string[] = [
    `Octree ${r.output} mesh (${note}): ${r.numCells.toLocaleString("en-US")} cell(s) (${r.numTetrahedra.toLocaleString("en-US")} tet, ${r.numHexahedra.toLocaleString("en-US")} hex) on ${r.numLeaves.toLocaleString("en-US")} leaves, finest level ${r.finestLevel}.`,
  ];
  if (r.numTetrahedra > 0) parts.push(`Dihedral ${f(r.minDihedral)}°–${f(r.maxDihedral)}°.`);
  parts.push(`Min scaled Jacobian ${f(r.minScaledJacobian)}${r.numInverted > 0 ? `, ${r.numInverted} INVERTED cell(s)` : ""}.`);
  if (r.hausdorffToSkin >= 0) parts.push(`Boundary within ${f(r.hausdorffToSkin)} of the skin.`);
  if (r.numBoundaryEdgesOpen > 0 || r.numNonManifoldBoundaryEdges > 0) {
    parts.push(`Boundary is not watertight (${r.numBoundaryEdgesOpen} open, ${r.numNonManifoldBoundaryEdges} non-manifold edge(s)).`);
  }
  if (r.output === "castellated") parts.push(`${r.numSurrogateFaces.toLocaleString("en-US")} surrogate boundary face(s), ${r.numHanging.toLocaleString("en-US")} hanging node(s).`);
  if (r.warnings.length) parts.push(r.warnings.join(" "));
  return { model: read, summary: parts.join(" "), suffix: `octree_${r.output}` };
}

/** Options of the older `octree` (17.8.0); positional in the kernel, named here. */
export interface OctreeSpec {
  kind: "octree";
  rootCells?: number[];
  minLevel?: number;
  maxLevel?: number;
  bounds?: number[];
  padding?: number;
  paddingRelative?: number;
  balance?: "face" | "edge" | "vertex" | string;
  fill?: "all" | "surface" | "inside" | string;
  sign?: string;
  attachDistance?: boolean;
  maxCells?: number;
}

/** The adaptive octree (a lattice of leaves, with hanging nodes) around a skin. */
export async function octreeModel(model: MdpaModel, spec: OctreeSpec, diagnostics: MdpaDiagnostic[] = []): Promise<KernelMeshResult> {
  const { surface, note } = triangleSurfaceOf(model);
  const m = await loadMeshio();
  const r = m.octree(
    modelToMeshio(surface, diagnostics, { dim: 3 }),
    spec.rootCells ?? null,
    spec.minLevel,
    spec.maxLevel,
    spec.bounds ?? null,
    spec.padding,
    spec.paddingRelative,
    0,
    0,
    spec.balance,
    spec.fill,
    spec.sign,
    spec.attachDistance,
    false,
    spec.maxCells
  );
  const read = legalFields(withKratosBlockNames(meshioToModel(r.mesh, diagnostics)), { sdf_distance: "SDF_DISTANCE" });
  const flaws = r.numNonManifold + r.numInconsistent + r.numBoundary;
  return {
    model: read,
    summary:
      `Octree (${note}): ${r.numLeaves.toLocaleString("en-US")} leaves (${r.dimension}-D), ${read.nodeCount.toLocaleString("en-US")} node(s); hanging nodes are NOT merged.` +
      (flaws > 0 ? ` Skin defects seen: ${r.numBoundary} boundary, ${r.numNonManifold} non-manifold, ${r.numInconsistent} inconsistently wound edge(s) — the inside test is unreliable near them.` : ""),
    suffix: "octree",
  };
}

/** Options of `meshCadSurface` (17.13.0). */
export interface CadSurfaceSpec {
  kind: "cadSurface";
  /** The target edge length (required, > 0). */
  targetSize: number;
  maxChordalDeviation?: number;
  minPointsPerEdge?: number;
  tolerance?: number;
  recordFaceIds?: boolean;
  edges?: boolean;
  matchUnreferencedTrims?: boolean;
  strict?: boolean;
  maxPoints?: number;
}

/** The faces of the model's B-rep (its NURBS side channel) triangulated into one conforming surface. */
export async function cadSurfaceModel(model: MdpaModel, spec: CadSurfaceSpec, diagnostics: MdpaDiagnostic[] = []): Promise<KernelMeshResult> {
  const channel = model.nurbs;
  if (!channel) {
    throw new Error(
      "This mesh carries no B-rep side channel, so there is nothing to mesh. " +
        "Open a .cad.json (or a .step/.igs read, which runs on the full artifact) — and only while the model is unedited, because any edit invalidates the channel."
    );
  }
  if (!isNum(spec.targetSize) || !(spec.targetSize > 0)) throw new Error("targetSize must be a positive number.");
  if (channel.format !== "cad_json") {
    throw new Error(`The side channel is ${channel.format}; a CAD surface mesh needs a B-rep (a .cad.json, or a STEP/IGES read).`);
  }
  const { kind: _kind, ...options } = spec;
  const m = await loadMeshio();
  const r = m.meshCadSurface(channel.info as Parameters<typeof m.meshCadSurface>[0], defined(options) as unknown as Parameters<typeof m.meshCadSurface>[1]);
  const read = legalFields(withKratosBlockNames(meshioToModel(r.mesh as Parameters<typeof meshioToModel>[0], diagnostics)), { cad_face: "CAD_FACE", cad_edge: "CAD_EDGE" });
  const failed = r.faces.filter((f) => f.status !== "ok");
  const f = (x: number) => (Number.isFinite(x) ? +x.toPrecision(3) : "n/a");
  const parts = [
    `B-rep surface mesh of ${r.numFaces} face(s): ${r.numTriangles.toLocaleString("en-US")} triangle(s), ${r.numPoints.toLocaleString("en-US")} point(s), edge length ${f(r.minEdge)}–${f(r.maxEdge)}, angles ${f(r.minAngleDeg)}°–${f(r.maxAngleDeg)}°.`,
    `Edges: ${r.numEdges} (${r.numOpenEdges} open, ${r.numNonManifoldEdges} non-manifold, ${r.numMisorientedEdges} misoriented), largest gap between faces ${f(r.maxEdgeGap)}.`,
  ];
  if (failed.length > 0) {
    parts.push(`${failed.length} face(s) NOT meshed: ${failed.slice(0, 5).map((x) => `#${x.face} ${x.status}${x.reason ? ` (${x.reason})` : ""}`).join("; ")}${failed.length > 5 ? "; …" : ""}.`);
  }
  if (r.warnings.length) parts.push(r.warnings.join(" "));
  return { model: read, summary: parts.join(" "), suffix: "cad_surface" };
}
