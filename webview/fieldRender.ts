// vtk.js wiring for scalar field contour and isosurface rendering. Keeps the
// color-mapping and polydata details out of main.ts.

import vtkPolyData from "@kitware/vtk.js/Common/DataModel/PolyData";
import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";
import { FieldAttach } from "./meshBuilder";
import { FieldInfo, scalarAt } from "./fieldData";
import { makeColorTransferFunction } from "./colormaps";
import { IsoSurfaceResult } from "../src/parser/isoSurface";
import { PlaneCutResult } from "../src/parser/planeCut";

// FieldAttach for a contour: nodal fields are point-data, elemental/conditional
// fields are cell-data. Missing values map to NaN (colored by the CTF below-range).
export function contourAttach(info: FieldInfo): FieldAttach {
  const name = info.field.variable;
  if (info.field.kind === "Nodal") {
    return { name, pointScalar: (nid) => scalarAt(info, nid) ?? NaN };
  }
  return { name, cellScalar: (eid) => (eid === undefined ? NaN : scalarAt(info, eid) ?? NaN) };
}

// Configures a mapper to color by the field's attached scalar array.
export function configureScalarMapper(mapper: any, info: FieldInfo, colormapName: string): void {
  const ctf = makeColorTransferFunction(colormapName, info.scalarMin, info.scalarMax);
  mapper.setLookupTable(ctf);
  mapper.setUseLookupTableScalarRange(true);
  mapper.setScalarRange(info.scalarMin, info.scalarMax);
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
export function attachCutCapScalars(pd: any, cut: PlaneCutResult, info: FieldInfo): boolean {
  const name = info.field.variable;
  if (info.field.kind === "Nodal") {
    const pointCount = cut.points.length / 3;
    const values = new Float32Array(pointCount);
    for (let k = 0; k < pointCount; k++) {
      const sA = scalarAt(info, cut.edgeNodeA[k]) ?? NaN;
      const sB = scalarAt(info, cut.edgeNodeB[k]) ?? NaN;
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
      values[p] = scalarAt(info, cut.cellIds[p]) ?? NaN;
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
