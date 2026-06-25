// Vector-field quiver: arrow glyphs at anchor points (nodes or cell centroids),
// oriented and scaled by the vector array and colored by magnitude.

import vtkActor from "@kitware/vtk.js/Rendering/Core/Actor";
import vtkGlyph3DMapper from "@kitware/vtk.js/Rendering/Core/Glyph3DMapper";
import vtkArrowSource from "@kitware/vtk.js/Filters/Sources/ArrowSource";
import vtkPolyData from "@kitware/vtk.js/Common/DataModel/PolyData";
import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";
import { makeColorTransferFunction } from "./colormaps";

export interface QuiverData {
  points: Float32Array; // x,y,z anchors
  vectors: Float32Array; // 3 per anchor
  magnitudes: Float32Array; // 1 per anchor
}

// Builds a glyph actor. `scaleFactor` is the global arrow scale; per-arrow
// length is scaleFactor * |vector|.
export function buildGlyphActor(
  data: QuiverData,
  scaleFactor: number,
  colormapName: string,
  magMin: number,
  magMax: number
): any {
  const pd = vtkPolyData.newInstance();
  pd.getPoints().setData(data.points, 3);
  pd.getPointData().setVectors(
    vtkDataArray.newInstance({ name: "vectors", numberOfComponents: 3, values: data.vectors })
  );
  pd.getPointData().setScalars(
    vtkDataArray.newInstance({ name: "magnitude", numberOfComponents: 1, values: data.magnitudes })
  );

  const arrow = vtkArrowSource.newInstance();
  const mapper = vtkGlyph3DMapper.newInstance();
  mapper.setInputData(pd, 0);
  mapper.setInputConnection(arrow.getOutputPort(), 1);
  mapper.setOrientationArray("vectors");
  mapper.setOrientationModeToDirection();
  mapper.setScaleArray("vectors");
  mapper.setScaleModeToScaleByMagnitude();
  mapper.setScaleFactor(scaleFactor);

  const ctf = makeColorTransferFunction(colormapName, magMin, magMax);
  mapper.setLookupTable(ctf);
  mapper.setUseLookupTableScalarRange(true);
  mapper.setScalarRange(magMin, magMax);
  mapper.setScalarVisibility(true);
  mapper.setScalarModeToUsePointData();
  mapper.setColorByArrayName("magnitude");

  const actor = vtkActor.newInstance();
  actor.setMapper(mapper);
  return actor;
}
