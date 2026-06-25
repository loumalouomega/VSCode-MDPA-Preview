// vtk.js wiring for scalar field contour and isosurface rendering. Keeps the
// color-mapping and polydata details out of main.ts.

import vtkPolyData from "@kitware/vtk.js/Common/DataModel/PolyData";
import { FieldAttach } from "./meshBuilder";
import { FieldInfo, scalarAt } from "./fieldData";
import { makeColorTransferFunction } from "./colormaps";
import { IsoSurfaceResult } from "../src/parser/isoSurface";

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
