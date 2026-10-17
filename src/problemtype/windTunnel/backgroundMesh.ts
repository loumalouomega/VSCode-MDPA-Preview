/**
 * The background mesh of a virtual wind tunnel: a graded box of tetrahedra with
 * its six faces named, built natively (no meshio++) so the face SubModelParts
 * are exact and the whole thing is deterministic.
 *
 * Why a lattice and not a mesher: the next steps sample a signed distance
 * function of the body at the nodes and let MMG refine and carve along it, so
 * the background only has to be fine enough inside the body zone to SEE the body
 * (a cell larger than the feature samples the SDF as "all outside") and may be
 * coarse far away. Each axis is therefore graded independently: a uniform core
 * around the body that grows geometrically towards the walls.
 *
 * Every cube is split with the Kuhn (Freudenthal) triangulation — six tetrahedra
 * around the main diagonal, always the same axis order — which is conforming
 * across neighbouring cubes by construction, so no hanging nodes and no
 * face-diagonal bookkeeping.
 *
 * Pure: no vscode, no wasm.
 */

import { finalizeModel } from "../../parser/modelBuilder";
import { VtkCellType } from "../../parser/geometryMap";
import type { EntityBlock, MdpaModel, SubModelPart } from "../../parser/types";

export interface AxisGrading {
  min: number;
  max: number;
  /** The interval kept at the fine size (the body zone), inside [min, max]. */
  focusMin: number;
  focusMax: number;
  /** Cell size inside the focus interval. */
  fine: number;
  /** Largest cell size anywhere. */
  coarse: number;
  /** Geometric growth per cell outside the focus (> 1). */
  growth: number;
}

/** Node coordinates along one axis: uniform in the focus, growing outwards, ending exactly on min and max. */
export function gradedAxis(g: AxisGrading): number[] {
  if (!(g.max > g.min)) throw new Error("A tunnel axis needs max > min.");
  if (!(g.fine > 0) || !(g.coarse >= g.fine)) throw new Error("Cell sizes need 0 < fine <= coarse.");
  const growth = Math.max(1, g.growth);
  const f0 = Math.min(Math.max(g.focusMin, g.min), g.max);
  const f1 = Math.min(Math.max(g.focusMax, f0), g.max);
  const core: number[] = [];
  const nCore = Math.max(1, Math.round((f1 - f0) / g.fine));
  for (let i = 0; i <= nCore; i++) core.push(f0 + ((f1 - f0) * i) / nCore);
  const outward = (from: number, to: number, dir: 1 | -1): number[] => {
    const pts: number[] = [];
    let h = g.fine;
    let x = from;
    while ((to - x) * dir > 1e-12) {
      h = Math.min(g.coarse, h * growth);
      x += dir * h;
      if ((to - x) * dir < 0.5 * h) break; // fold a sliver into the last cell
      pts.push(x);
    }
    pts.push(to);
    return pts;
  };
  const up = f1 < g.max ? outward(f1, g.max, 1) : [];
  const down = f0 > g.min ? outward(f0, g.min, -1).reverse() : [];
  return [...down, ...core, ...up];
}

/** Names of the six tunnel faces; the wizard renames the side pair for a half model. */
export interface TunnelFaceNames {
  inlet: string;
  outlet: string;
  floor: string;
  ceiling: string;
  sideLow: string;
  sideHigh: string;
}

export const DEFAULT_FACE_NAMES: TunnelFaceNames = {
  inlet: "Inlet",
  outlet: "Outlet",
  floor: "Floor",
  ceiling: "Ceiling",
  sideLow: "SideLow",
  sideHigh: "SideHigh",
};

export interface BackgroundOptions {
  names?: Partial<TunnelFaceNames>;
  /** SubModelPart (and block) name of the fluid volume. Default "Fluid". */
  fluidName?: string;
}

/** Number of tetrahedra a lattice would hold — for the estimator, before any allocation. */
export function backgroundCellCount(nx: number, ny: number, nz: number): number {
  return 6 * nx * ny * nz;
}

const PERMS: [number, number, number][] = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

/**
 * A box of tetrahedra from per-axis node coordinates. Flow runs along +X and the
 * floor is at the lowest Z — the wizard rotates the body into that frame, so
 * the tunnel never needs to know about any other.
 */
export function buildTunnelBackground(xs: number[], ys: number[], zs: number[], opts: BackgroundOptions = {}): MdpaModel {
  const names: TunnelFaceNames = { ...DEFAULT_FACE_NAMES, ...opts.names };
  const fluidName = opts.fluidName ?? "Fluid";
  const [nx, ny, nz] = [xs.length - 1, ys.length - 1, zs.length - 1];
  if (nx < 1 || ny < 1 || nz < 1) throw new Error("A tunnel lattice needs at least one cell along each axis.");
  const axes = [xs, ys, zs];
  const dims = [nx + 1, ny + 1, nz + 1];
  const nodeCount = dims[0] * dims[1] * dims[2];
  const id = (i: number, j: number, k: number): number => 1 + i + dims[0] * (j + dims[1] * k);
  const coords = new Float32Array(nodeCount * 3);
  for (let k = 0; k <= nz; k++) {
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const o = (id(i, j, k) - 1) * 3;
        coords[o] = xs[i];
        coords[o + 1] = ys[j];
        coords[o + 2] = zs[k];
      }
    }
  }
  const at = (n: number, a: number): number => coords[(n - 1) * 3 + a];
  const volume6 = (a: number, b: number, c: number, d: number): number => {
    const u = [0, 1, 2].map((t) => at(b, t) - at(a, t));
    const v = [0, 1, 2].map((t) => at(c, t) - at(a, t));
    const w = [0, 1, 2].map((t) => at(d, t) - at(a, t));
    return u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0]);
  };

  const tets = new Int32Array(nx * ny * nz * 6 * 4);
  let nt = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const base = [i, j, k];
        const corner = (o: number[]): number => id(base[0] + o[0], base[1] + o[1], base[2] + o[2]);
        const v7 = corner([1, 1, 1]);
        for (const [a, b] of PERMS) {
          const o1 = [0, 0, 0];
          o1[a] = 1;
          const o2 = [...o1];
          o2[b] = 1;
          let t = [corner([0, 0, 0]), corner(o1), corner(o2), v7];
          if (volume6(t[0], t[1], t[2], t[3]) < 0) t = [t[0], t[2], t[1], t[3]];
          tets.set(t, nt * 4);
          nt++;
        }
      }
    }
  }

  // Boundary triangles, per face, along the same low-to-high diagonal the tets use.
  type Face = { name: string; axis: number; high: boolean };
  const faces: Face[] = [
    { name: names.inlet, axis: 0, high: false },
    { name: names.outlet, axis: 0, high: true },
    { name: names.sideLow, axis: 1, high: false },
    { name: names.sideHigh, axis: 1, high: true },
    { name: names.floor, axis: 2, high: false },
    { name: names.ceiling, axis: 2, high: true },
  ];
  const tris: number[] = [];
  const faceCond: Int32Array[] = [];
  const faceNodes: Set<number>[] = [];
  const nElem = nt;
  for (const f of faces) {
    const [u, v] = [0, 1, 2].filter((t) => t !== f.axis);
    const fixed = f.high ? (f.axis === 0 ? nx : f.axis === 1 ? ny : nz) : 0;
    const ids: number[] = [];
    const nodes = new Set<number>();
    for (let q = 0; q < dims[v] - 1; q++) {
      for (let p = 0; p < dims[u] - 1; p++) {
        const pt = (du: number, dv: number): number => {
          const idx = [0, 0, 0];
          idx[f.axis] = fixed;
          idx[u] = p + du;
          idx[v] = q + dv;
          return id(idx[0], idx[1], idx[2]);
        };
        for (const tri of [
          [pt(0, 0), pt(1, 0), pt(1, 1)],
          [pt(0, 0), pt(1, 1), pt(0, 1)],
        ]) {
          // Outward = away from the box centre along the face axis.
          const e1 = [0, 1, 2].map((t) => at(tri[1], t) - at(tri[0], t));
          const e2 = [0, 1, 2].map((t) => at(tri[2], t) - at(tri[0], t));
          const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
          const outward = f.high ? 1 : -1;
          const out = n[f.axis] * outward > 0 ? tri : [tri[0], tri[2], tri[1]];
          tris.push(...out);
          ids.push(tris.length / 3);
          for (const nn of out) nodes.add(nn);
        }
      }
    }
    faceCond.push(Int32Array.from(ids));
    faceNodes.push(nodes);
  }

  const elementIds = new Int32Array(nElem);
  for (let e = 0; e < nElem; e++) elementIds[e] = e + 1;
  const nCond = tris.length / 3;
  const condIds = new Int32Array(nCond);
  for (let c = 0; c < nCond; c++) condIds[c] = c + 1;
  const blocks: EntityBlock[] = [
    {
      kind: "Elements",
      name: "Element3D4N",
      vtkCellType: VtkCellType.TETRA,
      count: nElem,
      stride: 4,
      entityIds: elementIds,
      propertyIds: new Int32Array(nElem),
      connectivity: tets,
    },
    {
      kind: "Conditions",
      name: "SurfaceCondition3D3N",
      vtkCellType: VtkCellType.TRIANGLE,
      count: nCond,
      stride: 3,
      entityIds: condIds,
      propertyIds: new Int32Array(nCond),
      connectivity: Int32Array.from(tris),
    },
  ];
  const allNodes = new Int32Array(nodeCount);
  for (let n = 0; n < nodeCount; n++) allNodes[n] = n + 1;
  const empty = new Int32Array(0);
  const part = (name: string, nodeIds: Int32Array, elementIdsP: Int32Array, conditionIds: Int32Array): SubModelPart => ({
    name,
    nodeIds,
    elementIds: elementIdsP,
    conditionIds,
    geometryIds: empty,
    constraintIds: empty,
    path: name,
    children: [],
  });
  const parts: SubModelPart[] = [part(fluidName, allNodes, elementIds, empty)];
  faces.forEach((f, idx) => {
    parts.push(part(f.name, Int32Array.from([...faceNodes[idx]].sort((a, b) => a - b)), empty, faceCond[idx]));
  });
  void axes;
  return finalizeModel({ nodeCount, coords, blocks, fields: [], diagnostics: [], subModelParts: parts });
}
