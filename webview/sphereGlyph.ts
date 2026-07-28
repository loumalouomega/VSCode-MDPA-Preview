// Sphere/particle rendering: one sphere glyph per one-node cell, sized by its
// RADIUS. Modelled on quiver.ts (the other Glyph3DMapper user here).
//
// Why glyphs rather than the ordinary point path: a one-node cell has no
// extent, so meshBuilder emits it into vtkPolyData's `verts` and it draws as a
// fixed-pixel GL point. That is fine for a point cloud but wrong for a
// peridynamics or DEM particle, whose radius is physical data — it must scale
// with the camera and with the mesh, not with the screen.

import vtkActor from "@kitware/vtk.js/Rendering/Core/Actor";
// The Geometry profile registers PolyDataMapper and CubeAxesActor but NOT
// Glyph3DMapper, so its OpenGL peer must be pulled in explicitly or the actor
// is built, added to the renderer, and silently draws nothing (same reason
// gridAxes.ts imports Rendering/OpenGL/CubeAxesActor).
import "@kitware/vtk.js/Rendering/OpenGL/Glyph3DMapper";
import vtkGlyph3DMapper from "@kitware/vtk.js/Rendering/Core/Glyph3DMapper";
import vtkSphereSource from "@kitware/vtk.js/Filters/Sources/SphereSource";
import vtkPolyData from "@kitware/vtk.js/Common/DataModel/PolyData";
import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";
import { makeColorTransferFunction } from "./colormaps";

export interface SphereGlyphData {
  /** x,y,z per particle. */
  points: Float32Array;
  /** One radius per particle, already resolved (field value or the fallback). */
  radii: Float32Array;
}

export interface SphereGlyphColor {
  colormap: string;
  min: number;
  max: number;
}

/**
 * Builds the glyph actor.
 *
 * `scaleFactor` is a plain multiplier on top of each particle's own radius: the
 * source sphere has radius 1 and SCALE_BY_MAGNITUDE of a 1-component array is
 * the value itself (`norm(tuple, 1)`), so the drawn radius is exactly
 * `scaleFactor * radii[i]`.
 */
export function buildSphereGlyphActor(
  data: SphereGlyphData,
  scaleFactor: number,
  resolution: number,
  color: [number, number, number],
  scalarColor?: SphereGlyphColor
): any {
  const pd = vtkPolyData.newInstance();
  pd.getPoints().setData(data.points, 3);
  pd.getPointData().setScalars(
    vtkDataArray.newInstance({ name: "radius", numberOfComponents: 1, values: data.radii })
  );

  const sphere = vtkSphereSource.newInstance({
    radius: 1,
    thetaResolution: resolution,
    phiResolution: resolution,
  });

  const mapper = vtkGlyph3DMapper.newInstance();
  mapper.setInputData(pd, 0);
  mapper.setInputConnection(sphere.getOutputPort(), 1);
  // setScaleArray exists at runtime (macro.setGet) but is missing from vtk.js TS typedefs
  (mapper as any).setScaleArray("radius");
  mapper.setScaleModeToScaleByMagnitude();
  mapper.setScaleFactor(scaleFactor);
  // No orientation array: a sphere has no orientation to take from the data.

  const actor = vtkActor.newInstance();
  if (scalarColor) {
    const ctf = makeColorTransferFunction(scalarColor.colormap, scalarColor.min, scalarColor.max);
    mapper.setLookupTable(ctf);
    mapper.setUseLookupTableScalarRange(true);
    mapper.setScalarRange(scalarColor.min, scalarColor.max);
    mapper.setScalarVisibility(true);
    mapper.setScalarModeToUsePointData();
    mapper.setColorByArrayName("radius");
  } else {
    // The radius array is the SCALE array; without this it would double as the
    // colour array and every particle would be tinted by its own size.
    mapper.setScalarVisibility(false);
    actor.getProperty().setColor(color[0], color[1], color[2]);
  }

  actor.setMapper(mapper);
  return actor;
}
