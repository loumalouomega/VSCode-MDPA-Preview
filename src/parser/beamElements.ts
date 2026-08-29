/**
 * Beam / line elements — the one place that spells out what makes a line cell a
 * structural member rather than a boundary edge, so the detector, the panel and
 * the renderer all agree.
 *
 * Pure: no vscode / DOM / vtk imports, because the webview bundle reaches this
 * file through webview/beamGlyph.ts — the same cross-runtime arrangement
 * sphereElements.ts and sizeExpr.ts use. This module is the direct sibling of
 * sphereElements.ts and is meant to read like it.
 *
 * **The problem this exists to solve is telling beams from skins.** A line cell
 * has no cross-section of its own, and unlike a one-node particle it is also
 * the shape a 2D boundary takes: `example/MDPA/cylinder_Fluid.mdpa` has ~400
 * `WallCondition2D2N`, `cylinder_Solid.mdpa` ~120 `LineCondition2D2N`, and
 * `example/VTK-XML/outline.vtp` is a pure line polydata. None of those may ever
 * become a bundle of tubes. So, exactly as with spheres, the discriminator is
 * not the topology but the SECTION attached to it — and here that section lives
 * in the mdpa `Properties` block (`CROSS_AREA`), which is why this module could
 * not exist before propertiesParser.ts.
 *
 * Two further restrictions are deliberate rather than incidental:
 *
 *  - **`CROSS_AREA` only.** `AREA` is a different, widely-used Kratos variable
 *    and aliasing it would produce false positives.
 *  - **The auto-enable gate is `Elements`-kind only** (`hasBeamSection`). In a
 *    2D structural model a `LineCondition2D2N` skin legitimately references the
 *    same `Properties` id as the part it bounds, so a purely per-cell rule
 *    would tube the skin. Conditions can still be drawn — the panel offers it —
 *    but never on their own say-so.
 *
 * Known limit, stated here so it is not rediscovered as a bug: the drawn tube
 * is circular. Orienting a non-circular profile needs a roll angle about the
 * beam axis, which the section area alone does not carry.
 */

import { EntityBlock, MdpaModel } from "./types";
import { findPropertySet, propertyNumber } from "./propertiesParser";

/** The Kratos variable holding a beam/truss section area. */
export const CROSS_AREA_VARIABLE = "CROSS_AREA";

/** VTK_LINE and VTK_QUADRATIC_EDGE — every 1D cell decodes to one of these. */
const VTK_LINE = 3;
const VTK_QUADRATIC_EDGE = 21;

/**
 * A drawn tube's radius from a section area, treating the section as circular.
 * Exported so the panel can label its constant in the same terms.
 */
export function radiusFromArea(area: number): number {
  return Math.sqrt(area / Math.PI);
}

/** Every line-cell block, whether or not it carries a section. */
export function beamBlocks(model: MdpaModel): EntityBlock[] {
  return model.blocks.filter(
    (b) => b.vtkCellType === VTK_LINE || b.vtkCellType === VTK_QUADRATIC_EDGE
  );
}

/** Total line cells in the model. */
export function beamCellCount(model: MdpaModel): number {
  let n = 0;
  for (const b of beamBlocks(model)) n += b.count;
  return n;
}

/**
 * Builds the per-cell section lookup for one block.
 *
 * Precedence, highest first:
 *   1. the cell's own `Properties` id → `CROSS_AREA` (where Kratos really keeps it)
 *   2. an Elemental/Conditional scalar `CROSS_AREA` field at the cell's entity id
 *   3. nothing — the caller falls back to the panel constant
 *
 * `Geometries` blocks carry no `propertyIds` at all (mdpaParser leaves them
 * undefined), so they skip straight to step 2. That is a fact of the format,
 * not an oversight.
 */
function sectionAreaResolver(model: MdpaModel): (block: EntityBlock, i: number) => number | undefined {
  const scalarField = (kind: "Elemental" | "Conditional") =>
    model.fields.find(
      (f) => f.kind === kind && f.variable === CROSS_AREA_VARIABLE && f.components === 1
    );
  const field = scalarField("Elemental") ?? scalarField("Conditional");
  const byId = new Map<number, number>();
  if (field) {
    for (let i = 0; i < field.ids.length; i++) byId.set(field.ids[i], field.values[i]);
  }

  // Property id -> area, resolved once. A mesh has a handful of Properties and
  // may have millions of cells, so the lookup must not re-walk the sets.
  const areaByProperty = new Map<number, number>();
  for (const set of model.properties ?? []) {
    const a = propertyNumber(set, CROSS_AREA_VARIABLE);
    if (a !== undefined) areaByProperty.set(set.id, a);
  }

  return (block, i) => {
    const pid = block.propertyIds?.[i];
    if (pid !== undefined) {
      const a = areaByProperty.get(pid);
      // Only a strictly positive area is a section. Zero is not a thinner beam:
      // Glyph3DMapper clamps a zero scale component to 1e-10, so it would draw
      // an invisible sliver rather than fall back to the constant.
      if (a !== undefined && Number.isFinite(a) && a > 0) return a;
    }
    const v = byId.get(block.entityIds[i]);
    if (v !== undefined && Number.isFinite(v) && v > 0) return v;
    return undefined;
  };
}

/** Everything the panel and the MCP report need, from ONE pass. */
export interface BeamStats {
  /** Line-cell blocks. */
  blocks: number;
  /** Line cells in total. */
  cells: number;
  /** How many of them resolve a section, of any entity kind. */
  withSection: number;
  /**
   * …restricted to `Elements`-kind blocks. This, not `withSection`, is what
   * decides auto-enable: a boundary skin sharing a part's Properties id would
   * otherwise switch the whole rendering on by itself.
   */
  elementsWithSection: number;
  /** Range of the section RADII actually present; both 0 when there are none. */
  radiusMin: number;
  radiusMax: number;
}

/**
 * Counts and section-radius range of the model's line cells.
 *
 * One function rather than a `has`/`count`/`min`/`max` family, for the reason
 * sphereStats gives: the panel re-renders on every control change and each
 * would otherwise re-walk the blocks and the field.
 */
export function beamStats(model: MdpaModel): BeamStats {
  const blocks = beamBlocks(model);
  const areaOf = sectionAreaResolver(model);
  let cells = 0;
  let withSection = 0;
  let elementsWithSection = 0;
  let radiusMin = Infinity;
  let radiusMax = -Infinity;

  for (const b of blocks) {
    cells += b.count;
    for (let i = 0; i < b.count; i++) {
      const area = areaOf(b, i);
      if (area === undefined) continue;
      withSection++;
      if (b.kind === "Elements") elementsWithSection++;
      const r = radiusFromArea(area);
      if (r < radiusMin) radiusMin = r;
      if (r > radiusMax) radiusMax = r;
    }
  }

  return {
    blocks: blocks.length,
    cells,
    withSection,
    elementsWithSection,
    radiusMin: withSection > 0 ? radiusMin : 0,
    radiusMax: withSection > 0 ? radiusMax : 0,
  };
}

/**
 * The auto-enable predicate: does this mesh have genuine structural members?
 *
 * Data-gated, never name-gated — we do not sniff `Truss`/`Beam` out of a block
 * name, the same principle sphereElements.ts follows. This is what keeps the
 * three known line meshes in the repo drawing as plain lines: none of them
 * declares a `CROSS_AREA` anywhere.
 */
export function hasBeamSection(model: MdpaModel): boolean {
  return beamStats(model).elementsWithSection > 0;
}

/** Fraction of the median line length used when a mesh declares no section. */
const LENGTH_FRACTION = 1 / 20;

/** Only used when there is nothing to measure: 1% of the bounding diagonal. */
const DIAGONAL_FRACTION = 0.01;

/**
 * A sensible drawn radius for a line mesh that declares no section.
 *
 * A twentieth of the median element length — slender enough to read as a
 * structural member rather than a sausage, thick enough to be visible when
 * zoomed to the whole frame.
 *
 * Unlike defaultSphereRadius this needs no spatial hash: a beam has explicit
 * topology, so its own length is the measurement, and there is no
 * nearest-neighbour question to answer. Cost is O(cells).
 *
 * Like defaultSphereRadius, it may **never** return 0, NaN or Infinity — the
 * renderer would draw nothing at all.
 */
export function defaultBeamRadius(model: MdpaModel): number {
  const diag = Math.hypot(
    model.bounds.max[0] - model.bounds.min[0],
    model.bounds.max[1] - model.bounds.min[1],
    model.bounds.max[2] - model.bounds.min[2]
  );
  const usableDiag = Number.isFinite(diag) && diag > 0;
  const fallback = usableDiag ? diag * DIAGONAL_FRACTION : 1;

  const index = nodeIndex(model);
  const lengths: number[] = [];
  for (const b of beamBlocks(model)) {
    for (let i = 0; i < b.count; i++) {
      const a = coordAt(model, index, b.connectivity[i * b.stride]);
      const c = coordAt(model, index, b.connectivity[i * b.stride + 1]);
      if (!a || !c) continue;
      const len = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
      if (len > 0 && Number.isFinite(len)) lengths.push(len);
    }
  }
  if (lengths.length === 0) return fallback;
  lengths.sort((x, y) => x - y);
  const median = lengths[lengths.length >> 1];
  const r = median * LENGTH_FRACTION;
  return Number.isFinite(r) && r > 0 ? r : fallback;
}

/** node id -> index into `coords`. Local rather than writerCommon's, which is host-shaped. */
function nodeIndex(model: MdpaModel): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 0; i < model.nodeCount; i++) m.set(model.nodeIds[i], i);
  return m;
}

function coordAt(
  model: MdpaModel,
  index: Map<number, number>,
  nodeId: number
): [number, number, number] | undefined {
  const i = index.get(nodeId);
  if (i === undefined) return undefined;
  return [model.coords[i * 3], model.coords[i * 3 + 1], model.coords[i * 3 + 2]];
}

/** The per-cell arrays a glyph mapper needs. */
export interface BeamSegments {
  /** Midpoint xyz per drawn cell — the glyph anchor. */
  centers: Float32Array;
  /**
   * Endpoint-to-endpoint vector per drawn cell.
   *
   * Carries BOTH the direction and the length, which is what lets one array
   * drive `setOrientationArray` while its magnitude sizes the tube along its
   * own axis.
   */
  axes: Float32Array;
  /** Section radius per drawn cell, already resolved or defaulted. */
  radii: Float32Array;
  /** How many cells were actually emitted (arrays are exactly this long). */
  count: number;
  /** Cells skipped because an endpoint was missing or the segment had zero length. */
  skipped: number;
}

export interface BeamSegmentOptions {
  /** Draw line cells that are Conditions/Geometries too. Default false. */
  includeConditions?: boolean;
  /** Radius for cells that resolve no section. Must be finite and > 0. */
  fallbackRadius: number;
  /**
   * Overrides where a node's coordinates come from — the Deformed-shape warp
   * passes its displaced copy here, exactly as the sphere layer does. Defaults
   * to the model's own coordinates.
   */
  coordOf?: (nodeId: number) => readonly [number, number, number] | undefined;
}

/**
 * Builds the glyph arrays for one model.
 *
 * Lives here rather than in the webview so it is unit-testable —
 * `tsconfig.test.json` covers `src/parser/**` and excludes `webview/**`.
 *
 * A quadratic edge is drawn as a straight tube between its two end nodes; the
 * mid node is dropped, matching how meshBuilder already draws it as a straight
 * segment. A curved `Line3` therefore renders as a chord.
 */
export function buildBeamSegments(model: MdpaModel, opts: BeamSegmentOptions): BeamSegments {
  const blocks = beamBlocks(model).filter(
    (b) => opts.includeConditions || b.kind === "Elements"
  );
  const areaOf = sectionAreaResolver(model);
  const index = nodeIndex(model);
  const coordOf =
    opts.coordOf ?? ((nodeId: number) => coordAt(model, index, nodeId));

  let total = 0;
  for (const b of blocks) total += b.count;
  const centers = new Float32Array(total * 3);
  const axes = new Float32Array(total * 3);
  const radii = new Float32Array(total);

  let w = 0;
  let skipped = 0;
  for (const b of blocks) {
    for (let i = 0; i < b.count; i++) {
      const a = coordOf(b.connectivity[i * b.stride]);
      const c = coordOf(b.connectivity[i * b.stride + 1]);
      if (!a || !c) {
        skipped++;
        continue;
      }
      const dx = c[0] - a[0];
      const dy = c[1] - a[1];
      const dz = c[2] - a[2];
      // A zero-length segment (duplicate nodes) has no direction to orient by
      // and would be clamped to a 1e-10 sliver — drop it rather than draw a dot.
      if (!(Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 0)) {
        skipped++;
        continue;
      }
      const o = w * 3;
      centers[o] = (a[0] + c[0]) / 2;
      centers[o + 1] = (a[1] + c[1]) / 2;
      centers[o + 2] = (a[2] + c[2]) / 2;
      axes[o] = dx;
      axes[o + 1] = dy;
      axes[o + 2] = dz;
      const area = areaOf(b, i);
      radii[w] = area !== undefined ? radiusFromArea(area) : opts.fallbackRadius;
      w++;
    }
  }

  return {
    centers: w === total ? centers : centers.subarray(0, w * 3),
    axes: w === total ? axes : axes.subarray(0, w * 3),
    radii: w === total ? radii : radii.subarray(0, w),
    count: w,
    skipped,
  };
}
