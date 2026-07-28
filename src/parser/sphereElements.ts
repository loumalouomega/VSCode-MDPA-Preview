/**
 * Sphere / particle elements — the one place that spells out what makes a cell
 * a sphere, so the reader, the writer, the operation and the renderer all agree.
 *
 * Pure: no vscode / DOM / vtk imports, because the webview bundle reaches this
 * file through webview/sphereGlyph.ts (the same cross-runtime arrangement as
 * writers/exportFormats.ts and sizeExpr.ts).
 *
 * There is no "sphere" cell type anywhere in the stack. Exodus `SPHERE` maps to
 * meshio++'s `vertex`, i.e. VTK_VERTEX (1) — a one-node cell. What separates a
 * particle from an ordinary point cloud is therefore not the topology but the
 * RADIUS attached to it, which Exodus stores as a per-element *attribute*
 * (`attrib{k}`, named by `attrib_name{k}`) and meshio++ surfaces as
 * `cell_data["exodus:attr:RADIUS"]`.
 *
 * The `exodus:attr:` prefix is stripped on read (meshioConvert.ts) so the field
 * is plainly `RADIUS` — which is also a real Kratos variable, so a .mdpa export
 * of a particle mesh yields a `Begin ElementalData RADIUS` block Kratos DEM can
 * read. It is re-applied on export to Exodus only; see meshioConvert's
 * `exodusAttributes` option for why that is an export-time rule rather than
 * state carried on the model.
 */

import { EntityBlock, FieldData, MdpaModel } from "./types";
import { nodeIndexMap } from "./writers/writerCommon";

/** The canonical radius variable, in both Exodus and Kratos spelling. */
export const RADIUS_VARIABLE = "RADIUS";

/** VTK_VERTEX — the one-node cell every sphere/particle element decodes to. */
const VTK_VERTEX = 1;

/** Every one-node cell block, whether or not it carries a radius. */
export function sphereBlocks(model: MdpaModel): EntityBlock[] {
  return model.blocks.filter((b) => b.vtkCellType === VTK_VERTEX);
}

/** Total one-node cells in the model. */
export function sphereCellCount(model: MdpaModel): number {
  let n = 0;
  for (const b of sphereBlocks(model)) n += b.count;
  return n;
}

/**
 * The scalar RADIUS field, if the model has one.
 *
 * Elemental first, then Conditional: an Exodus attribute is per-element, but a
 * .mdpa may legitimately carry point *conditions*. A vector field named RADIUS
 * is not a radius and is ignored rather than half-interpreted.
 */
export function radiusField(model: MdpaModel): FieldData | undefined {
  const scalar = (f: FieldData): boolean =>
    f.variable === RADIUS_VARIABLE && f.components === 1;
  return (
    model.fields.find((f) => f.kind === "Elemental" && scalar(f)) ??
    model.fields.find((f) => f.kind === "Conditional" && scalar(f))
  );
}

/** Everything the panels and the MCP report need, from ONE pass. */
export interface SphereStats {
  /** One-node cell blocks. */
  blocks: number;
  /** One-node cells in total. */
  cells: number;
  /** How many of them carry a radius. */
  withRadius: number;
  /** Range of the radii actually present; both 0 when there are none. */
  radiusMin: number;
  radiusMax: number;
}

/**
 * Counts and radius range of the model's particles.
 *
 * One function rather than a `has`/`count`/`min`/`max` family because every
 * caller wants several of them at once and each would otherwise re-walk the
 * blocks and the field — the panel re-renders on every control change, and a
 * DEM file has a million particles.
 *
 * Coverage is by INTERSECTION, deliberately: a multi-block Exodus file merges
 * all its SPHERE blocks into ONE EntityBlock (buildBlocksFromOffsets groups by
 * cellType+stride) and only some of those blocks may declare the attribute, so
 * demanding full coverage would reject a mesh that is plainly a particle mesh.
 * The cells left over fall back to the viewer's constant.
 */
export function sphereStats(model: MdpaModel): SphereStats {
  const blocks = sphereBlocks(model);
  const ids = new Set<number>();
  let cells = 0;
  for (const b of blocks) {
    cells += b.count;
    for (const id of b.entityIds) ids.add(id);
  }

  const field = radiusField(model);
  let withRadius = 0;
  let radiusMin = Infinity;
  let radiusMax = -Infinity;
  if (field) {
    for (let i = 0; i < field.ids.length; i++) {
      if (!ids.has(field.ids[i])) continue;
      withRadius++;
      const v = field.values[i];
      if (v < radiusMin) radiusMin = v;
      if (v > radiusMax) radiusMax = v;
    }
  }

  return {
    blocks: blocks.length,
    cells,
    withRadius,
    radiusMin: withRadius > 0 ? radiusMin : 0,
    radiusMax: withRadius > 0 ? radiusMax : 0,
  };
}

/** True when some one-node cell actually has a radius. */
export function hasSphereRadius(model: MdpaModel): boolean {
  return sphereStats(model).withRadius > 0;
}

/** The xyz of every one-node cell's node, in block order. */
function sphereAnchors(model: MdpaModel): Float64Array {
  const index = nodeIndexMap(model);
  const blocks = sphereBlocks(model);
  let total = 0;
  for (const b of blocks) total += b.count;
  const out = new Float64Array(total * 3);
  let w = 0;
  for (const b of blocks) {
    for (let c = 0; c < b.count; c++) {
      const i = index.get(b.connectivity[c]);
      if (i === undefined) continue;
      out[w++] = model.coords[i * 3];
      out[w++] = model.coords[i * 3 + 1];
      out[w++] = model.coords[i * 3 + 2];
    }
  }
  return w === out.length ? out : out.subarray(0, w);
}

/** How many anchors to sample when estimating the spacing. */
const SPACING_SAMPLE = 2000;

/** Only used when there is nothing to measure: 1% of the bounding diagonal. */
const DIAGONAL_FRACTION = 0.01;

/** The 27 cells of a spatial-hash neighbourhood, built once. */
const NEIGHBOR_CELLS: readonly (readonly [number, number, number])[] = (() => {
  const out: [number, number, number][] = [];
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) out.push([dx, dy, dz]);
  return out;
})();

/**
 * Hash a grid cell to a single number.
 *
 * Numeric rather than a `"x,y,z"` template string: the string form allocates
 * one key per particle on build plus 27 per sampled point on query, which on a
 * million-particle file is a million throwaway strings for a viewer default.
 */
function cellKey(x: number, y: number, z: number): number {
  return ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) >>> 0;
}

/**
 * A sensible drawn radius for a particle mesh that declares none.
 *
 * Half the median nearest-neighbour spacing, so touching particles read as
 * touching — which is what a peridynamics or DEM discretization looks like.
 * The reporter's file (issue #63) has a uniform 0.2727 lattice, giving 0.136.
 *
 * computeMeshSize's NODAL_H cannot be reused here: meshSize.ts skips point
 * cells outright, so an all-particle model yields no NODAL_H at all.
 *
 * Cost is O(n) via a uniform spatial hash over a bounded sample — a
 * million-particle DEM file must not turn a viewer default into an O(n^2) scan.
 */
export function defaultSphereRadius(model: MdpaModel): number {
  const diag = Math.hypot(
    model.bounds.max[0] - model.bounds.min[0],
    model.bounds.max[1] - model.bounds.min[1],
    model.bounds.max[2] - model.bounds.min[2]
  );
  // An empty model leaves bounds at ±Infinity, and a one-point model leaves a
  // zero diagonal. Neither may reach the renderer as a radius: 1 is an
  // arbitrary but finite, positive, visible fallback.
  const usableDiag = Number.isFinite(diag) && diag > 0;
  const fallback = usableDiag ? diag * DIAGONAL_FRACTION : 1;

  const anchors = sphereAnchors(model);
  const count = Math.floor(anchors.length / 3);
  if (count < 2 || !usableDiag) return fallback;

  // A cell size near the mean spacing keeps the 27-cell neighbourhood small.
  const cell = diag / Math.max(1, Math.cbrt(count));
  if (!(cell > 0)) return fallback;

  const grid = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const k = cellKey(
      Math.floor(anchors[i * 3] / cell),
      Math.floor(anchors[i * 3 + 1] / cell),
      Math.floor(anchors[i * 3 + 2] / cell)
    );
    const bucket = grid.get(k);
    if (bucket) bucket.push(i);
    else grid.set(k, [i]);
  }

  const stride = Math.max(1, Math.floor(count / SPACING_SAMPLE));
  const nearest: number[] = [];
  for (let i = 0; i < count; i += stride) {
    const x = anchors[i * 3];
    const y = anchors[i * 3 + 1];
    const z = anchors[i * 3 + 2];
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    const cz = Math.floor(z / cell);
    let best = Infinity;
    for (const [dx, dy, dz] of NEIGHBOR_CELLS) {
      const bucket = grid.get(cellKey(cx + dx, cy + dy, cz + dz));
      if (!bucket) continue;
      for (const j of bucket) {
        if (j === i) continue;
        const d = Math.hypot(
          anchors[j * 3] - x,
          anchors[j * 3 + 1] - y,
          anchors[j * 3 + 2] - z
        );
        if (d > 0 && d < best) best = d;
      }
    }
    if (Number.isFinite(best)) nearest.push(best);
  }
  if (nearest.length === 0) return fallback; // every sampled point was isolated

  nearest.sort((a, b) => a - b);
  const median = nearest[Math.floor(nearest.length / 2)];
  return median > 0 ? median / 2 : fallback;
}
