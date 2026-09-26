// Glyph source shapes built in JS (roadmap item 18). The VTK C++ build's
// vtkCylinderSource has no Direction (its axis is fixed along +Y) and the
// build carries no vtkTransformPolyDataFilter, so the beam tube — a unit
// cylinder along +X — is generated here for the VTK-wasm backend. vtk.js keeps
// its own vtkCylinderSource({direction: [1, 0, 0]}); both describe the same
// shape: height 1 centred on the origin, radius 0.5, capped.

import type { DisplayGeometry } from "./types";

export function unitCylinderX(resolution: number): DisplayGeometry {
  const n = Math.max(3, Math.floor(resolution));
  const points = new Float32Array(n * 2 * 3);
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    const y = 0.5 * Math.cos(a);
    const z = 0.5 * Math.sin(a);
    points.set([-0.5, y, z], i * 3); // ring at x = -0.5: indices 0..n-1
    points.set([0.5, y, z], (n + i) * 3); // ring at x = +0.5: indices n..2n-1
  }
  const polys: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    // Side quad wound outward: -x ring i, -x ring j, +x ring j, +x ring i.
    polys.push(4, i, j, n + j, n + i);
  }
  // Caps, wound so their normals point along -x and +x.
  polys.push(n, ...Array.from({ length: n }, (_, k) => n - 1 - k));
  polys.push(n, ...Array.from({ length: n }, (_, k) => n + k));
  return { points, polys: Uint32Array.from(polys) };
}
