// Beam/line rendering: one tube glyph per line cell, sized by its section.
// Modelled on sphereGlyph.ts, with the orientation half taken from quiver.ts.
//
// Why glyphs rather than the ordinary line path: a line cell draws as a
// `setLineWidth(1.5)` polyline, i.e. screen-space pixels. That carries no
// cross-section and does not scale with the camera, so a tie rod and a girder
// look identical at every zoom. A beam's section is physical data and should
// behave like geometry — exactly the argument the sphere work made for
// one-node cells.
//
// The construction differs from the sphere one in a way that matters. A beam
// needs three things per cell: a direction, a LENGTH, and a RADIUS independent
// of that length. vtkGlyph3DMapper exposes a single scale array, so
// SCALE_BY_MAGNITUDE — which the sphere module uses — cannot express it: it
// copies one magnitude into all three axes. SCALE_BY_COMPONENTS can, by
// scaling x/y/z independently from a 3-component array. Measured against the
// bundled vtk.js:
//
//   - Glyph3DMapper.js:60-63   SCALE_BY_COMPONENTS errors out unless the scale
//                              array has exactly 3 components.
//   - Glyph3DMapper.js:110-121 OrientationModes.DIRECTION maps +X onto the
//                              direction vector (the convention vtkArrowSource,
//                              and therefore quiver.ts, already relies on).
//   - Glyph3DMapper.js:125-148 the scale is post-multiplied AFTER the rotation,
//                              i.e. applied in the glyph's own local frame
//                              before it is rotated.
//
// So a unit cylinder lying along +X, scaled by [length, 2r, 2r] and oriented
// by the cell's own endpoint vector, is an exact endpoint-to-endpoint tube of
// radius r. No vtkTubeFilter, no hand-built geometry.

import vtkActor from "@kitware/vtk.js/Rendering/Core/Actor";
// The Geometry profile registers PolyDataMapper but NOT Glyph3DMapper, so its
// OpenGL peer must be pulled in explicitly or the actor is built, added to the
// renderer, and silently draws nothing. sphereGlyph.ts and quiver.ts each do
// the same; the import is idempotent.
import "@kitware/vtk.js/Rendering/OpenGL/Glyph3DMapper";
import vtkGlyph3DMapper from "@kitware/vtk.js/Rendering/Core/Glyph3DMapper";
import vtkCylinderSource from "@kitware/vtk.js/Filters/Sources/CylinderSource";
import vtkPolyData from "@kitware/vtk.js/Common/DataModel/PolyData";
import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";
import { makeColorTransferFunction } from "./colormaps";

export interface BeamGlyphData {
  /** Midpoint x,y,z per cell — the glyph anchor. */
  centers: Float32Array;
  /** Endpoint-to-endpoint vector per cell: direction AND length. */
  axes: Float32Array;
  /** Section radius per cell, already resolved or defaulted. */
  radii: Float32Array;
  /** Cells in the arrays above. */
  count: number;
}

export interface BeamGlyphColor {
  colormap: string;
  min: number;
  max: number;
}

/**
 * Builds the tube actor.
 *
 * `thickness` multiplies the RADIUS only, never the length — that is the whole
 * reason it is baked into the scale array here instead of being passed to
 * `setScaleFactor`. Under SCALE_BY_COMPONENTS the mapper's scale factor
 * multiplies all three components alike (`Glyph3DMapper.js:126-141`), so a
 * `setScaleFactor(2)` would also make every tube twice as long as its own
 * element and detach it from its endpoints. This is precisely where the sphere
 * module's pattern must NOT be copied: there, `setScaleFactor` is the correct
 * knob.
 */
export function buildBeamGlyphActor(
  data: BeamGlyphData,
  thickness: number,
  resolution: number,
  color: [number, number, number],
  scalarColor?: BeamGlyphColor
): any {
  // [length, diameter, diameter] per cell, in the cylinder's own local frame.
  const scales = new Float32Array(data.count * 3);
  for (let i = 0; i < data.count; i++) {
    const o = i * 3;
    const length = Math.hypot(data.axes[o], data.axes[o + 1], data.axes[o + 2]);
    const d = 2 * data.radii[i] * thickness;
    scales[o] = length;
    scales[o + 1] = d;
    scales[o + 2] = d;
  }

  const pd = vtkPolyData.newInstance();
  pd.getPoints().setData(data.centers, 3);
  // The axis drives orientation; a separate array drives scale. quiver.ts uses
  // one array for both, which is right for an arrow whose length IS the datum
  // and wrong here, where length and thickness are independent.
  pd.getPointData().setVectors(
    vtkDataArray.newInstance({ name: "axis", numberOfComponents: 3, values: data.axes })
  );
  pd.getPointData().addArray(
    vtkDataArray.newInstance({ name: "beamScale", numberOfComponents: 3, values: scales })
  );
  // Colour by the radius, when asked. Kept as its own 1-component array rather
  // than reusing `beamScale`, whose magnitude mixes length into the value.
  pd.getPointData().setScalars(
    vtkDataArray.newInstance({
      name: "radius",
      numberOfComponents: 1,
      values: data.radii.slice(0, data.count),
    })
  );

  // A unit cylinder along +X: height 1 and radius 0.5 make the scale array read
  // directly as [length, diameter, diameter]. `direction` is what puts it on
  // the axis Glyph3DMapper's DIRECTION mode rotates from.
  const cylinder = vtkCylinderSource.newInstance({
    height: 1,
    radius: 0.5,
    resolution,
    center: [0, 0, 0],
    direction: [1, 0, 0],
    capping: true,
  });

  const mapper = vtkGlyph3DMapper.newInstance();
  mapper.setInputData(pd, 0);
  mapper.setInputConnection(cylinder.getOutputPort(), 1);
  mapper.setOrientationArray("axis");
  mapper.setOrientationModeToDirection();
  // setScaleArray exists at runtime (macro.setGet) but is missing from the
  // vtk.js TS typedefs — same cast as sphereGlyph.ts/quiver.ts.
  (mapper as any).setScaleArray("beamScale");
  mapper.setScaleModeToScaleByComponents();
  mapper.setScaleFactor(1);

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
    // Without this the radius array doubles as the colour array and every
    // tube is tinted by its own thickness (sphereGlyph.ts's rule, same reason).
    mapper.setScalarVisibility(false);
    actor.getProperty().setColor(color[0], color[1], color[2]);
  }

  actor.setMapper(mapper);
  return actor;
}
