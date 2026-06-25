// Named colormaps for field visualization. Each is a small set of ordered RGB
// stops (t in [0,1]); the same stops drive both the vtk.js color transfer
// function (3D coloring) and the DOM legend gradient, keeping them in sync.

import vtkColorTransferFunction from "@kitware/vtk.js/Rendering/Core/ColorTransferFunction";

export type ColorStop = [t: number, r: number, g: number, b: number];

export interface Colormap {
  name: string;
  stops: ColorStop[];
}

// Rainbow / jet is the default (first entry).
export const COLORMAPS: Colormap[] = [
  {
    name: "Rainbow",
    stops: [
      [0.0, 0.0, 0.0, 1.0],
      [0.25, 0.0, 1.0, 1.0],
      [0.5, 0.0, 1.0, 0.0],
      [0.75, 1.0, 1.0, 0.0],
      [1.0, 1.0, 0.0, 0.0],
    ],
  },
  {
    name: "Viridis",
    stops: [
      [0.0, 0.267, 0.005, 0.329],
      [0.25, 0.231, 0.318, 0.545],
      [0.5, 0.128, 0.567, 0.551],
      [0.75, 0.369, 0.789, 0.383],
      [1.0, 0.993, 0.906, 0.144],
    ],
  },
  {
    name: "Cool-warm",
    stops: [
      [0.0, 0.23, 0.299, 0.754],
      [0.5, 0.865, 0.865, 0.865],
      [1.0, 0.706, 0.016, 0.15],
    ],
  },
  {
    name: "Grayscale",
    stops: [
      [0.0, 0.0, 0.0, 0.0],
      [1.0, 1.0, 1.0, 1.0],
    ],
  },
];

export const DEFAULT_COLORMAP = COLORMAPS[0].name;

export function getColormap(name: string): Colormap {
  return COLORMAPS.find((c) => c.name === name) ?? COLORMAPS[0];
}

// Builds a vtk color transfer function spanning [min, max] for the named map.
export function makeColorTransferFunction(
  name: string,
  min: number,
  max: number
): ReturnType<typeof vtkColorTransferFunction.newInstance> {
  const ctf = vtkColorTransferFunction.newInstance();
  const span = max > min ? max - min : 1;
  for (const [t, r, g, b] of getColormap(name).stops) {
    ctf.addRGBPoint(min + t * span, r, g, b);
  }
  return ctf;
}

// Interpolated RGB (0..1) at normalized position t along the colormap.
export function colorAt(name: string, t: number): [number, number, number] {
  const stops = getColormap(name).stops;
  const x = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const [t0, r0, g0, b0] = stops[i - 1];
      const [t1, r1, g1, b1] = stops[i];
      const f = t1 > t0 ? (x - t0) / (t1 - t0) : 0;
      return [r0 + f * (r1 - r0), g0 + f * (g1 - g0), b0 + f * (b1 - b0)];
    }
  }
  const last = stops[stops.length - 1];
  return [last[1], last[2], last[3]];
}

// CSS linear-gradient stop list (left→right) for the DOM legend bar.
export function gradientCss(name: string): string {
  const stops = getColormap(name).stops.map(
    ([t, r, g, b]) =>
      `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)}) ${(t * 100).toFixed(1)}%`
  );
  return `linear-gradient(to right, ${stops.join(", ")})`;
}
