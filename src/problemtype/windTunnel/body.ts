/**
 * The body in a virtual wind tunnel: what an imported surface is (size, area,
 * frontal area, whether it is closed) and how it is put into the tunnel frame
 * (flow along +X, up along +Z).
 *
 * Everything here is measured from the triangles, never assumed from a unit or a
 * name: a mesh in millimetres is the common failure, so the wizard shows the
 * size it measured and asks for the unit instead of guessing.
 *
 * Pure: no vscode, no wasm.
 */

import { triangleSurfaceOf } from "../../parser/gridSample";
import { surfaceDefects } from "../../parser/surfaceDefects";
import { rotateCoords, scaleCoords, translateCoords } from "../../parser/transformCoords";
import { VtkCellType } from "../../parser/geometryMap";
import type { MdpaModel } from "../../parser/types";

export type Vec3 = [number, number, number];

export interface BodyMetrics {
  triangles: number;
  nodes: number;
  min: Vec3;
  max: Vec3;
  /** Extent along x (flow), y (span) and z (up). */
  size: Vec3;
  surfaceArea: number;
  /** Enclosed volume from the divergence theorem; negative = inward-wound. */
  signedVolume: number;
  /** Area of the shadow on the plane normal to the flow (the union, not the sum of faces). */
  frontalArea: number;
  boundaryEdges: number;
  nonManifoldEdges: number;
  inconsistentFaces: number;
  degenerateFaces: number;
  /** True when no edge is open, shared by three faces, or wound against its neighbour. */
  closed: boolean;
  problems: string[];
}

interface Tri {
  a: Vec3;
  b: Vec3;
  c: Vec3;
}

function triangles(model: MdpaModel): Tri[] {
  const { surface } = triangleSurfaceOf(model);
  const idx = new Map<number, number>();
  for (let i = 0; i < surface.nodeCount; i++) idx.set(surface.nodeIds[i], i);
  const pt = (id: number): Vec3 => {
    const i = idx.get(id)!;
    return [surface.coords[3 * i], surface.coords[3 * i + 1], surface.coords[3 * i + 2]];
  };
  const out: Tri[] = [];
  for (const b of surface.blocks) {
    if (b.vtkCellType !== VtkCellType.TRIANGLE) continue;
    for (let c = 0; c < b.count; c++) {
      out.push({ a: pt(b.connectivity[3 * c]), b: pt(b.connectivity[3 * c + 1]), c: pt(b.connectivity[3 * c + 2]) });
    }
  }
  return out;
}

/** Union area of the triangles projected on the YZ plane, by rasterisation (so overlapping shadows count once). */
function shadowArea(tris: Tri[], min: Vec3, max: Vec3): number {
  const w = max[1] - min[1];
  const h = max[2] - min[2];
  if (!(w > 0) || !(h > 0)) return 0;
  const n = 512;
  const cell = Math.max(w, h) / n;
  const nx = Math.max(1, Math.ceil(w / cell));
  const ny = Math.max(1, Math.ceil(h / cell));
  const covered = new Uint8Array(nx * ny);
  for (const t of tris) {
    const ys = [t.a[1], t.b[1], t.c[1]];
    const zs = [t.a[2], t.b[2], t.c[2]];
    const i0 = Math.max(0, Math.floor((Math.min(...ys) - min[1]) / cell));
    const i1 = Math.min(nx - 1, Math.floor((Math.max(...ys) - min[1]) / cell));
    const j0 = Math.max(0, Math.floor((Math.min(...zs) - min[2]) / cell));
    const j1 = Math.min(ny - 1, Math.floor((Math.max(...zs) - min[2]) / cell));
    const d = (ys[1] - ys[0]) * (zs[2] - zs[0]) - (ys[2] - ys[0]) * (zs[1] - zs[0]);
    if (d === 0) continue;
    for (let j = j0; j <= j1; j++) {
      const pz = min[2] + (j + 0.5) * cell;
      for (let i = i0; i <= i1; i++) {
        const py = min[1] + (i + 0.5) * cell;
        const u = ((py - ys[0]) * (zs[2] - zs[0]) - (ys[2] - ys[0]) * (pz - zs[0])) / d;
        const v = ((ys[1] - ys[0]) * (pz - zs[0]) - (py - ys[0]) * (zs[1] - zs[0])) / d;
        if (u >= -1e-9 && v >= -1e-9 && u + v <= 1 + 1e-9) covered[j * nx + i] = 1;
      }
    }
  }
  let count = 0;
  for (let i = 0; i < covered.length; i++) count += covered[i];
  return count * cell * cell;
}

export function bodyMetrics(model: MdpaModel): BodyMetrics {
  const tris = triangles(model);
  if (tris.length === 0) throw new Error("The body has no triangles.");
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let area = 0;
  let vol = 0;
  for (const t of tris) {
    for (const p of [t.a, t.b, t.c]) {
      for (let k = 0; k < 3; k++) {
        if (p[k] < min[k]) min[k] = p[k];
        if (p[k] > max[k]) max[k] = p[k];
      }
    }
    const u = [t.b[0] - t.a[0], t.b[1] - t.a[1], t.b[2] - t.a[2]];
    const v = [t.c[0] - t.a[0], t.c[1] - t.a[1], t.c[2] - t.a[2]];
    const cx = u[1] * v[2] - u[2] * v[1];
    const cy = u[2] * v[0] - u[0] * v[2];
    const cz = u[0] * v[1] - u[1] * v[0];
    area += 0.5 * Math.hypot(cx, cy, cz);
    vol += (t.a[0] * (t.b[1] * t.c[2] - t.b[2] * t.c[1]) - t.a[1] * (t.b[0] * t.c[2] - t.b[2] * t.c[0]) + t.a[2] * (t.b[0] * t.c[1] - t.b[1] * t.c[0])) / 6;
  }
  const defects = surfaceDefects(model);
  const problems: string[] = [];
  if (defects.boundaryEdges.length > 0) problems.push(`${defects.boundaryEdges.length} open edge(s) — the surface is not closed`);
  if (defects.nonManifoldEdges.length > 0) problems.push(`${defects.nonManifoldEdges.length} edge(s) shared by three or more faces`);
  if (defects.inconsistentFaces.length > 0) problems.push(`${defects.inconsistentFaces.length} face(s) wound against a neighbour`);
  if (defects.degenerateFaces.length > 0) problems.push(`${defects.degenerateFaces.length} zero-area face(s)`);
  const size: Vec3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  return {
    triangles: tris.length,
    nodes: model.nodeCount,
    min,
    max,
    size,
    surfaceArea: area,
    signedVolume: vol,
    frontalArea: shadowArea(tris, min, max),
    boundaryEdges: defects.boundaryEdges.length,
    nonManifoldEdges: defects.nonManifoldEdges.length,
    inconsistentFaces: defects.inconsistentFaces.length,
    degenerateFaces: defects.degenerateFaces.length,
    closed: problems.length === 0,
    problems,
  };
}

/** Length units a body can be authored in, as metres per unit. */
export const LENGTH_UNITS: Record<string, number> = { m: 1, cm: 0.01, mm: 0.001, in: 0.0254, ft: 0.3048 };

export interface BodyPlacement {
  /** Metres per model unit (use LENGTH_UNITS). Default 1. */
  scale?: number;
  /** Euler angles in degrees, applied about x, then y, then z, through the body centre. */
  rotation?: Vec3;
  /**
   * "floor": the body's lowest point sits `clearance` above the floor (a ground
   * vehicle, a building); "free": the body floats at the middle of the tunnel height.
   */
  ground?: "floor" | "free";
  clearance?: number;
}

/**
 * Puts the body into the tunnel frame: scaled to metres, rotated so the flow
 * runs along +X, and centred on x = 0 and y = 0. The vertical position is
 * decided by the domain, which knows where the floor is, so this returns the
 * body with its centre of mass of the bounding box on the origin and the
 * vertical offset to apply separately.
 */
export function placeBody(model: MdpaModel, placement: BodyPlacement = {}): MdpaModel {
  let m = model;
  const scale = placement.scale ?? 1;
  if (scale !== 1) m = scaleCoords(m, scale, scale, scale);
  const [rx, ry, rz] = placement.rotation ?? [0, 0, 0];
  if (rx) m = rotateCoords(m, "x", rx);
  if (ry) m = rotateCoords(m, "y", ry);
  if (rz) m = rotateCoords(m, "z", rz);
  const b = bodyMetrics(m);
  return translateCoords(m, -(b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2, -(b.min[2] + b.max[2]) / 2);
}
