/**
 * MdpaModel → ASCII STL.  STL is a triangle-soup surface format, so the model's
 * outer surface (surface cells + volume boundary faces) is triangulated by the
 * shared `surfaceTriangles` helper and each triangle is written with a computed
 * facet normal.
 *
 * Pure module: no vscode / DOM / vtk.js imports.
 */

import { MdpaDiagnostic, MdpaModel } from "../types";
import { num, surfaceTriangles } from "./writerCommon";

export function writeStl(model: MdpaModel, name = "mesh"): string {
  const diagnostics: MdpaDiagnostic[] = [];
  const tris = surfaceTriangles(model, diagnostics);
  const c = model.coords;
  const lines: string[] = [`solid ${name}`];

  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3;
    const b = tris[t + 1] * 3;
    const d = tris[t + 2] * 3;
    const n = normal(c, a, b, d);
    lines.push(`  facet normal ${num(n[0])} ${num(n[1])} ${num(n[2])}`);
    lines.push("    outer loop");
    for (const p of [a, b, d]) {
      lines.push(`      vertex ${num(c[p])} ${num(c[p + 1])} ${num(c[p + 2])}`);
    }
    lines.push("    endloop");
    lines.push("  endfacet");
  }

  lines.push(`endsolid ${name}`);
  return lines.join("\n") + "\n";
}

/** Unit normal of triangle (a,b,d), each an index into the flat coords array. */
function normal(c: Float32Array, a: number, b: number, d: number): [number, number, number] {
  const ux = c[b] - c[a];
  const uy = c[b + 1] - c[a + 1];
  const uz = c[b + 2] - c[a + 2];
  const vx = c[d] - c[a];
  const vy = c[d + 1] - c[a + 1];
  const vz = c[d + 2] - c[a + 2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}
