// A vtk.js colour transfer function from backend-neutral `x, r, g, b`
// quadruples (src/parser/render/scalarColoring.ts ctfPointsFromStops), added
// in order — exactly what webview/colormaps.ts's makeCtfFromStops used to do,
// including the single-point degenerate case.

import vtkColorTransferFunction from "@kitware/vtk.js/Rendering/Core/ColorTransferFunction";

export function ctfFromPoints(points: number[]): any {
  const ctf = vtkColorTransferFunction.newInstance();
  for (let i = 0; i + 3 < points.length; i += 4) ctf.addRGBPoint(points[i], points[i + 1], points[i + 2], points[i + 3]);
  return ctf;
}
