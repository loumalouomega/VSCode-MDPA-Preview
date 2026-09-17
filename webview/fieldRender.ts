// vtk.js wiring for scalar field contour and isosurface rendering. Keeps the
// color-mapping and polydata details out of main.ts.

import vtkPolyData from "@kitware/vtk.js/Common/DataModel/PolyData";
import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";
import { FieldAttach } from "./meshBuilder";
import { FieldInfo, scalarAt } from "./fieldData";
import { getColormap, makeCtfFromStops } from "./colormaps";
import { IsoSurfaceResult } from "../src/parser/isoSurface";
import { PlaneCutResult } from "../src/parser/planeCut";
import { FieldComponent, interpolateStops, transformStops } from "../src/parser/fieldScalars";

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

// Configures a mapper to color by the field's attached scalar array. `prop`
// is the owning actor's property, used only for the degenerate-range bypass
// below — the normal path colors purely through the mapper/lookup table.
export function configureScalarMapper(
  mapper: any,
  prop: any,
  info: FieldInfo,
  style: ScalarStyle
): void {
  if (style.max <= style.min) {
    // Degenerate/empty range: vtk.js's per-vertex scalar→texture-coordinate
    // math (ScalarColoringHelper's getOrCreateColorTextureCoordinates)
    // divides by the range width with no zero guard, so max===min produces
    // a NaN texture coordinate for every vertex — confirmed via
    // `(scalarValue - textureSOrigin) * textureSCoeff` where textureSCoeff
    // is `1/0 = Infinity` and the product is `0 * Infinity = NaN`. Sampling
    // a texture at NaN coordinates is then genuinely GPU/driver-dependent
    // undefined behavior: a software rasterizer (SwiftShader) happens to
    // render it plausibly, but real hardware GPUs can and do sample
    // garbage — this is what was actually behind a flat field rendering as
    // an arbitrary, inconsistent color instead of the intended neutral one.
    // The color transfer function itself handles a degenerate range fine
    // (see colormaps.ts:makeCtfFromStops and its getRange()/getColor()
    // behavior) — this is purely a vtkMapper texture-sampling issue, so the
    // fix is to skip texture-based coloring entirely and paint the whole
    // surface with one deliberate mid-colormap hue via the actor's plain
    // property color instead.
    mapper.setScalarVisibility(false);
    const [r, g, b] = interpolateStops(getColormap(style.colormap).stops, 0.5);
    prop.setColor(r, g, b);
    return;
  }
  const stops = transformStops(getColormap(style.colormap).stops, {
    log: style.log,
    bands: style.bands,
    min: style.min,
    max: style.max,
  });
  const ctf = makeCtfFromStops(stops, style.min, style.max);
  mapper.setLookupTable(ctf);
  mapper.setUseLookupTableScalarRange(true);
  mapper.setScalarRange(style.min, style.max);
  mapper.setScalarVisibility(true);
  if (info.field.kind === "Nodal") {
    mapper.setScalarModeToUsePointData();
    mapper.setInterpolateScalarsBeforeMapping(true);
  } else {
    mapper.setScalarModeToUseCellData();
    // Flat per-cell coloring: do not pre-interpolate.
    mapper.setInterpolateScalarsBeforeMapping(false);
  }
}

// Cut-cap surface: one convex polygon per sectioned volume element.
export function buildCutCapPolyData(cut: PlaneCutResult): ReturnType<typeof vtkPolyData.newInstance> {
  const pd = vtkPolyData.newInstance();
  pd.getPoints().setData(cut.points, 3);
  if (cut.polys.length) pd.getPolys().setData(cut.polys);
  return pd;
}

// Cut-cap element edges: the polygon boundaries as deduplicated line segments.
// Rendered as a separate actor because vtk.js edge visibility draws the edges
// of the *triangulated* primitives, which would add fan diagonals across
// quads/pentagons.
export function buildCutCapEdgePolyData(cut: PlaneCutResult): ReturnType<typeof vtkPolyData.newInstance> {
  const pd = vtkPolyData.newInstance();
  pd.getPoints().setData(cut.points, 3);
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
  if (lines.length) pd.getLines().setData(Uint32Array.from(lines));
  return pd;
}

// Attaches the active field's scalars to the cut-cap polydata so the section
// is colored consistently with the contour layer: nodal fields interpolate
// along each crossed mesh edge, elemental fields color per owning element.
// Returns false when the field cannot apply (conditional fields — the cap
// polygons belong to elements).
export function attachCutCapScalars(
  pd: any,
  cut: PlaneCutResult,
  info: FieldInfo,
  component: FieldComponent = "mag"
): boolean {
  const name = info.field.variable;
  if (info.field.kind === "Nodal") {
    const pointCount = cut.points.length / 3;
    const values = new Float32Array(pointCount);
    for (let k = 0; k < pointCount; k++) {
      const sA = scalarAt(info, cut.edgeNodeA[k], component) ?? NaN;
      const sB = scalarAt(info, cut.edgeNodeB[k], component) ?? NaN;
      values[k] = sA + cut.edgeT[k] * (sB - sA);
    }
    pd.getPointData().setScalars(
      vtkDataArray.newInstance({ name, numberOfComponents: 1, values })
    );
    return true;
  }
  if (info.field.kind === "Elemental") {
    const values = new Float32Array(cut.polyCount);
    for (let p = 0; p < cut.polyCount; p++) {
      values[p] = scalarAt(info, cut.cellIds[p], component) ?? NaN;
    }
    pd.getCellData().setScalars(
      vtkDataArray.newInstance({ name, numberOfComponents: 1, values })
    );
    return true;
  }
  return false;
}

// Builds polydata directly from an isosurface result (already triangulated in
// world coordinates) — bypassing buildPolyData's local remap.
export function buildIsoPolyData(result: IsoSurfaceResult): ReturnType<typeof vtkPolyData.newInstance> {
  const pd = vtkPolyData.newInstance();
  pd.getPoints().setData(result.points, 3);
  if (result.is2D) {
    const segs: number[] = [];
    for (let i = 0; i < result.lines.length; i += 2) {
      segs.push(2, result.lines[i], result.lines[i + 1]);
    }
    if (segs.length) pd.getLines().setData(Uint32Array.from(segs));
  } else {
    const tris: number[] = [];
    for (let i = 0; i < result.triangles.length; i += 3) {
      tris.push(3, result.triangles[i], result.triangles[i + 1], result.triangles[i + 2]);
    }
    if (tris.length) pd.getPolys().setData(Uint32Array.from(tris));
  }
  return pd;
}
