/**
 * Regular grids, voxelization and sampled signed-distance volumes: the "sample
 * the space around this shape" workflows. Pure module (no vscode / DOM); the
 * work is meshio++'s `grid`, `voxelize` and `computeSdf`.
 *
 * Complements — does not replace — the existing `sdfDistance` operation, which
 * measures distance only at THIS mesh's own nodes. These produce a NEW lattice
 * (a hexahedral mesh carrying occupancy or signed distance) that is written out,
 * never an edit, so they belong to the derived-mesh family (deriveMesh.ts).
 *
 * Two hazards are handled up front rather than left to the wasm:
 *
 * - **Memory.** A lattice grows with the cube of the resolution. `estimateGrid`
 *   computes the cell/point counts and an approximate byte size BEFORE anything
 *   is allocated, so a request over `GRID_MAX_CELLS` is refused by name and one
 *   over `GRID_CONFIRM_CELLS` can be confirmed by the UI. (Upstream would refuse
 *   at its own 2e7 default only after starting.)
 * - **The `.vti` boundary.** A dense lattice is exactly what ImageData is, and our
 *   unstructured writers deliberately cannot write it (an unstructured model has
 *   no implicit topology to reconstruct). So the raw upstream mesh is kept beside
 *   the model, and `denseLattice` says whether it may be written as `.vti` — the
 *   only container that keeps the `sdf:*` header (origin/spacing/dims/structure).
 *   A partial lattice (voxelize's `surface`/`inside` fill, an octree) cannot.
 */

import { MdpaDiagnostic, MdpaModel } from "./types";
import { modelToMeshio, meshioToModel, MeshioMesh } from "./meshioConvert";
import { loadMeshio } from "./meshio";
import { extractSkinModel } from "./extractSkin";
import { simplexifyModel } from "./simplexify";
import { cellCategory } from "./writers/writerCommon";

export type Vec3 = [number, number, number];

export const GRID_MAX_CELLS = 20_000_000;
export const GRID_CONFIRM_CELLS = 5_000_000;

export interface LatticeSpec {
  /** Cells along x, y, z. Exactly one of resolution / cellSize (ignored by grid). */
  resolution?: [number, number, number];
  cellSize?: number;
  /** Explicit lattice bounds `[xmin, ymin, zmin, xmax, ymax, zmax]`; default the shape's box plus padding. */
  bounds?: number[];
  /** Absolute padding around the shape (mesh units). */
  padding?: number;
  /** Extra padding as a fraction of the shape's bounding-box DIAGONAL (measured against the live wasm). */
  paddingRelative?: number;
}

export interface GridEstimate {
  dims: [number, number, number];
  cells: number;
  points: number;
  /** A rough byte count of the produced mesh (coordinates, one field, connectivity). */
  approxBytes: number;
}

/** Cell counts and size of the lattice a request would produce, computed without allocating it. */
export function estimateGrid(bounds: { min: Vec3; max: Vec3 }, spec: LatticeSpec, defaultPaddingRelative = 0): GridEstimate {
  let dims: [number, number, number];
  if (spec.resolution) dims = [spec.resolution[0], spec.resolution[1], spec.resolution[2]];
  else {
    const diag = Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]);
    const pad = (spec.padding ?? 0) + (spec.paddingRelative ?? defaultPaddingRelative) * diag;
    const h = spec.cellSize ?? 0;
    const ext = [0, 1, 2].map((k) =>
      spec.bounds ? spec.bounds[3 + k] - spec.bounds[k] : bounds.max[k] - bounds.min[k] + 2 * pad
    );
    dims = ext.map((e) => (h > 0 ? Math.max(1, Math.ceil(e / h - 1e-9)) : 0)) as [number, number, number];
  }
  const cells = dims[0] * dims[1] * dims[2];
  const points = (dims[0] + 1) * (dims[1] + 1) * (dims[2] + 1);
  return { dims, cells, points, approxBytes: points * 32 + cells * 32 };
}

export function describeGridEstimate(e: GridEstimate): string {
  const mb = e.approxBytes / (1024 * 1024);
  return `${e.dims.join(" × ")} = ${e.cells.toLocaleString("en-US")} cells, ${e.points.toLocaleString("en-US")} points (about ${mb >= 1 ? mb.toFixed(0) + " MB" : Math.max(1, Math.round(e.approxBytes / 1024)) + " KB"})`;
}

export interface GridSpec {
  kind: "grid";
  /** Cells along x, y, z. */
  dims: [number, number, number];
  origin?: Vec3;
  spacing?: Vec3;
}

export interface VoxelizeSpec extends LatticeSpec {
  kind: "voxelize";
  /** "inside" (default): cells whose centre is inside; "surface": cells a triangle passes through; "all": the whole box. */
  fill?: "all" | "surface" | "inside";
  /** "pseudonormal" (default), "winding-number" (tolerates small holes) or "unsigned". */
  sign?: "pseudonormal" | "winding-number" | "unsigned";
  /** Attach the 0/1 occupancy as VOXEL_OCCUPANCY (default true). */
  attachOccupancy?: boolean;
}

export interface SdfVolumeSpec extends LatticeSpec {
  kind: "sdfVolume";
  /** "voxel" (default): a dense lattice. "octree": adaptive, with hanging nodes — resolution/cellSize are not allowed. */
  structure?: "voxel" | "octree";
  sign?: "pseudonormal" | "winding-number" | "unsigned";
  /** Where the value lives: "corner" (default, a nodal field) or "center". */
  location?: "corner" | "center";
  /** Exact values only within this distance of the surface, clamped beyond (0 = no band). */
  band?: number;
  /** Octree only. */
  rootResolution?: number;
  maxDepth?: number;
}

export type GridSampleSpec = GridSpec | VoxelizeSpec | SdfVolumeSpec;

export interface GridSampleResult {
  model: MdpaModel;
  /** The upstream mesh, for the one container our writers cannot produce (`.vti`). */
  raw: MeshioMesh;
  /** True when the whole box is present as one regular lattice — writable as `.vti`. */
  denseLattice: boolean;
  estimate: GridEstimate;
  summary: string;
  suffix: string;
}

/** A triangle surface to sample against: the mesh's own faces, or the skin of a solid. */
export function triangleSurfaceOf(model: MdpaModel): { surface: MdpaModel; note: string } {
  const hasVolume = model.blocks.some((b) => cellCategory(b.vtkCellType) === "volume");
  let s: MdpaModel;
  let note: string;
  if (hasVolume) {
    const skin = extractSkinModel(model);
    if (skin.faces === 0) throw new Error("The mesh has no boundary faces to sample against.");
    s = skin.model;
    note = "measured against the mesh's boundary skin";
  } else {
    s = { ...model, blocks: model.blocks.filter((b) => cellCategory(b.vtkCellType) === "surface") };
    if (s.blocks.length === 0) throw new Error("The mesh has no surface faces to sample against (lines and points have no inside).");
    note = "measured against the mesh's own surface";
  }
  return { surface: simplexifyModel({ ...s, constraints: undefined, fields: [], subModelParts: [] }).model, note };
}

const RENAME: Record<string, string> = { voxel_occupancy: "VOXEL_OCCUPANCY", sdf_distance: "SDF_DISTANCE" };

function toModel(mesh: MeshioMesh, diagnostics: MdpaDiagnostic[]): MdpaModel {
  const model = meshioToModel(mesh, diagnostics);
  return { ...model, fields: model.fields.map((f) => (RENAME[f.variable] ? { ...f, variable: RENAME[f.variable] } : f)) };
}

const ORIGIN0: Vec3 = [0, 0, 0];

export async function sampleGrid(model: MdpaModel, spec: GridSampleSpec, diagnostics: MdpaDiagnostic[] = []): Promise<GridSampleResult> {
  const m = await loadMeshio();
  if (spec.kind === "grid") {
    if (!spec.dims || spec.dims.length !== 3 || !spec.dims.every((n) => Number.isInteger(n) && n >= 1)) throw new Error("dims must be three positive integers (cells along x, y, z).");
    const spacing = spec.spacing ?? [1, 1, 1];
    if (!spacing.every((s) => Number.isFinite(s) && s > 0)) throw new Error("spacing must be three positive numbers.");
    const est = estimateGrid({ min: spec.origin ?? ORIGIN0, max: ORIGIN0 }, { resolution: spec.dims });
    if (est.cells > GRID_MAX_CELLS) throw new Error(`That grid would have ${est.cells.toLocaleString("en-US")} cells (over ${GRID_MAX_CELLS.toLocaleString("en-US")}). Use fewer cells.`);
    const mesh = m.grid(spec.dims, spec.origin ?? ORIGIN0, spacing, GRID_MAX_CELLS);
    return {
      model: toModel(mesh, diagnostics),
      raw: mesh,
      denseLattice: true,
      estimate: est,
      summary: `Regular grid: ${describeGridEstimate(est)}, spacing (${spacing.join(", ")}).`,
      suffix: "grid",
    };
  }

  if ((spec.cellSize === undefined) === (spec.resolution === undefined) && !(spec.kind === "sdfVolume" && spec.structure === "octree")) {
    throw new Error("Give exactly one of cellSize or resolution.");
  }
  if (spec.cellSize !== undefined && !(spec.cellSize > 0)) throw new Error("cellSize must be positive.");
  if (spec.resolution && !spec.resolution.every((n) => Number.isInteger(n) && n >= 1)) throw new Error("resolution must be three positive integers.");
  if (spec.bounds && !(spec.bounds.length === 6 && spec.bounds.every(Number.isFinite) && spec.bounds[3] > spec.bounds[0] && spec.bounds[4] > spec.bounds[1] && spec.bounds[5] > spec.bounds[2])) {
    throw new Error("bounds must be [xmin, ymin, zmin, xmax, ymax, zmax] with max above min.");
  }
  const { surface, note } = triangleSurfaceOf(model);
  const defaultPad = spec.kind === "sdfVolume" ? 0.1 : 0;
  const est = estimateGrid(surface.bounds, spec, defaultPad);
  const octree = spec.kind === "sdfVolume" && spec.structure === "octree";
  if (!octree) {
    if (est.cells > GRID_MAX_CELLS) throw new Error(`That lattice would have ${est.cells.toLocaleString("en-US")} cells (over ${GRID_MAX_CELLS.toLocaleString("en-US")}). Use a larger cellSize.`);
  } else if (spec.cellSize !== undefined || spec.resolution !== undefined) {
    throw new Error("An octree is sized by rootResolution and maxDepth; cellSize and resolution are for the voxel structure.");
  }
  const mesh = modelToMeshio(surface, diagnostics, { dim: 3 });

  if (spec.kind === "voxelize") {
    const fill = spec.fill ?? "inside";
    const r = m.voxelize(mesh, spec.resolution ?? null, spec.cellSize ?? 0, spec.bounds ?? null, spec.padding ?? 0, spec.paddingRelative ?? 0, fill, spec.sign ?? "pseudonormal", spec.attachOccupancy ?? true, GRID_MAX_CELLS, "warn");
    if (r.numOccupied === 0) throw new Error("No voxel is occupied: the cell size may be too coarse for the shape, or the surface is not closed.");
    return {
      model: toModel(r.mesh, diagnostics),
      raw: r.mesh,
      denseLattice: fill === "all",
      estimate: { ...est, dims: r.dims as Vec3 },
      summary:
        `Voxelized (${fill}, ${note}): ${r.dims.join(" × ")} lattice, spacing ${r.spacing.map((s) => +s.toPrecision(4)).join(" × ")}, origin (${r.origin.map((o) => +o.toPrecision(4)).join(", ")}); ` +
        `${r.numOccupied.toLocaleString("en-US")} of ${(r.dims[0] * r.dims[1] * r.dims[2]).toLocaleString("en-US")} cells written` +
        (fill === "all" ? "." : " — a partial lattice, so it cannot be written as .vti (use .vtu or another cell format)."),
      suffix: "voxels",
    };
  }

  const r = m.computeSdf(
    mesh,
    spec.structure ?? "voxel",
    octree ? null : spec.resolution ?? null,
    octree ? 0 : spec.cellSize ?? 0,
    spec.bounds ?? null,
    spec.padding ?? 0,
    spec.paddingRelative ?? 0.1,
    spec.rootResolution ?? 8,
    spec.maxDepth ?? 4,
    1,
    true,
    GRID_MAX_CELLS,
    spec.sign ?? "pseudonormal",
    spec.location ?? "corner",
    spec.band ?? 0,
    "warn"
  );
  const q = r.quality;
  const caveat = q.watertight ? "" : ` The surface is not closed (${q.boundaryEdges} boundary edge(s), ${q.nonManifoldEdges} non-manifold), so the SIGN is unreliable near the defects — consider the winding-number sign or repairing it first.`;
  return {
    model: toModel(r.mesh, diagnostics),
    raw: r.mesh,
    denseLattice: !octree,
    estimate: { ...est, dims: r.dims as Vec3 },
    summary:
      `Signed-distance ${octree ? "octree" : "volume"} (${note}): ${r.dims.join(" × ")} ${octree ? "root" : "lattice"}, spacing ${r.spacing.map((s) => +s.toPrecision(4)).join(" × ")}. ` +
      `Negative is inside.` +
      (octree ? " An octree has hanging nodes and cannot be written as .vti." : " Written as .vti it also keeps the sdf:* header (origin, spacing, dims, structure).") +
      caveat,
    suffix: octree ? "sdf_octree" : "sdf",
  };
}
