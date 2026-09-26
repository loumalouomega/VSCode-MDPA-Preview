// Field contour / isosurface / cut-cap data for the renderer: which scalars a
// surface carries and how it is coloured. Backend-neutral since the renderer
// boundary (roadmap item 18) — everything here returns plain DisplayGeometry /
// ScalarColoring values that webview/render/ turns into backend objects.

import type { FieldAttach } from "../src/parser/render/displayGeometry";
import type { DisplayGeometry, ScalarArray, ScalarColoring } from "../src/parser/render/types";
import { fieldColoring } from "../src/parser/render/scalarColoring";
import { FieldInfo, scalarAt } from "./fieldData";
import { getColormap } from "./colormaps";
import { IsoSurfaceResult } from "../src/parser/isoSurface";
import { PlaneCutResult } from "../src/parser/planeCut";
import { FieldComponent } from "../src/parser/fieldScalars";

// Everything needed to color a mapper/legend/cut-cap consistently: which
// scalar to read off a (possibly vector) field, the effective range it's
// stretched over, and any display transform on the colormap itself.
export interface ScalarStyle {
  colormap: string;
  component: FieldComponent;
  min: number;
  max: number;
  log?: boolean;
  bands?: number;
}

// FieldAttach for a contour: nodal fields are point-data, elemental/conditional
// fields are cell-data. Missing values map to NaN (colored by the CTF below-range).
export function contourAttach(info: FieldInfo, component: FieldComponent = "mag"): FieldAttach {
  const name = info.field.variable;
  if (info.field.kind === "Nodal") {
    return { name, pointScalar: (nid) => scalarAt(info, nid, component) ?? NaN };
  }
  return {
    name,
    cellScalar: (eid) => (eid === undefined ? NaN : scalarAt(info, eid, component) ?? NaN),
  };
}

/**
 * How a field-attached surface is coloured: nodal fields map point data and
 * interpolate before mapping, elemental/conditional fields map flat per cell,
 * and a degenerate range paints one mid-colormap hue (scalarColoring.ts has
 * the full reason — vtk.js turns max === min into NaN texture coordinates).
 */
export function fieldColoringFor(info: FieldInfo, style: ScalarStyle): ScalarColoring {
  return fieldColoring(
    getColormap(style.colormap).stops,
    { min: style.min, max: style.max, log: style.log, bands: style.bands },
    info.field.kind === "Nodal" ? "point" : "cell"
  );
}

// Cut-cap surface: one convex polygon per sectioned volume element.
export function cutCapGeometry(cut: PlaneCutResult, scalars?: CutCapScalars): DisplayGeometry {
  const g: DisplayGeometry = { points: cut.points };
  if (cut.polys.length) g.polys = cut.polys;
  if (scalars?.point) g.pointScalars = scalars.point;
  else if (scalars?.cell) g.cellScalars = scalars.cell;
  return g;
}

// Cut-cap element edges: the polygon boundaries as deduplicated line segments.
// A separate prop because edge visibility draws the edges of the TRIANGULATED
// primitives, which would add fan diagonals across quads/pentagons.
export function cutCapEdgeGeometry(cut: PlaneCutResult): DisplayGeometry {
  const lines: number[] = [];
  const seen = new Set<number>();
  let i = 0;
  const pointCount = cut.points.length / 3;
  while (i < cut.polys.length) {
    const n = cut.polys[i++];
    for (let e = 0; e < n; e++) {
      const a = cut.polys[i + e];
      const b = cut.polys[i + ((e + 1) % n)];
      const key = a < b ? a * pointCount + b : b * pointCount + a;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(2, a, b);
    }
    i += n;
  }
  const g: DisplayGeometry = { points: cut.points };
  if (lines.length) g.lines = Uint32Array.from(lines);
  return g;
}

export interface CutCapScalars {
  point?: ScalarArray;
  cell?: ScalarArray;
}

// The active field's scalars on the cut cap, so the section is coloured
// consistently with the contour layer: nodal fields interpolate along each
// crossed mesh edge, elemental fields colour per owning element. Undefined
// when the field cannot apply (conditional fields — the cap polygons belong
// to elements).
export function cutCapScalars(
  cut: PlaneCutResult,
  info: FieldInfo,
  component: FieldComponent = "mag"
): CutCapScalars | undefined {
  const name = info.field.variable;
  if (info.field.kind === "Nodal") {
    const pointCount = cut.points.length / 3;
    const values = new Float32Array(pointCount);
    for (let k = 0; k < pointCount; k++) {
      const sA = scalarAt(info, cut.edgeNodeA[k], component) ?? NaN;
      const sB = scalarAt(info, cut.edgeNodeB[k], component) ?? NaN;
      values[k] = sA + cut.edgeT[k] * (sB - sA);
    }
    return { point: { name, values } };
  }
  if (info.field.kind === "Elemental") {
    const values = new Float32Array(cut.polyCount);
    for (let p = 0; p < cut.polyCount; p++) {
      values[p] = scalarAt(info, cut.cellIds[p], component) ?? NaN;
    }
    return { cell: { name, values } };
  }
  return undefined;
}

// Geometry directly from an isosurface result (already triangulated in world
// coordinates) — no local remap needed.
export function isoGeometry(result: IsoSurfaceResult): DisplayGeometry {
  const g: DisplayGeometry = { points: result.points };
  if (result.is2D) {
    const segs: number[] = [];
    for (let i = 0; i < result.lines.length; i += 2) {
      segs.push(2, result.lines[i], result.lines[i + 1]);
    }
    if (segs.length) g.lines = Uint32Array.from(segs);
  } else {
    const tris: number[] = [];
    for (let i = 0; i < result.triangles.length; i += 3) {
      tris.push(3, result.triangles[i], result.triangles[i + 1], result.triangles[i + 2]);
    }
    if (tris.length) g.polys = Uint32Array.from(tris);
  }
  return g;
}
