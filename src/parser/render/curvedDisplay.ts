// Curved display tessellation of quadratic cells (roadmap item 10, first increment).
//
// Pure and import-free so both runtimes (and Node tests) can use it. A quadratic
// cell is drawn as its linear skeleton unless it is subdivided with its own
// shape functions; this module does the subdivision for DISPLAY only — the
// stored cells are never touched and no writer ever sees these points.
//
// Every generated point is described as a weighted combination of the cell's
// own nodes (`CurvedPoint`). That one description gives three things at once:
// the position (sum of weighted coordinates), a nodal scalar (the same sum,
// exact for a quadratic field) and a key that is identical on both sides of a
// shared edge or face, because a shape function restricted to an edge depends
// only on the nodes of that edge. So neighbouring cells weld without any
// cell-order logic.

export interface CurvedPoint {
  /** Node ids (as handed in) that contribute. */
  ids: number[];
  /** Matching weights; they sum to 1. */
  w: number[];
}

export interface CurvedPatch {
  points: CurvedPoint[];
  /** Triangles or quads as indices into `points` (faces) or 2-index segments (edges). */
  cells: number[][];
}

export const CURVED_MAX_LEVEL = 3;

/** Segments per edge for a level: 2, 4, 8. */
export function curvedDivisions(level: number): number {
  const l = Math.max(1, Math.min(CURVED_MAX_LEVEL, Math.floor(level) || 1));
  return 1 << l;
}

function point(ids: number[], w: number[]): CurvedPoint {
  const oi: number[] = [];
  const ow: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    if (Math.abs(w[i]) > 1e-12) {
      oi.push(ids[i]);
      ow.push(w[i]);
    }
  }
  return { ids: oi, w: ow };
}

/** Stable key: equal for equal (id, weight) sets whatever the order. */
export function curvedPointKey(p: CurvedPoint): string {
  const parts: string[] = [];
  for (let i = 0; i < p.ids.length; i++) parts.push(`${p.ids[i]}:${Math.round(p.w[i] * 1e8)}`);
  parts.sort();
  return parts.join("|");
}

/** Quadratic edge [a, b, mid] cut into 2^level segments. */
export function tessellateEdge(nodeIds: number[], level: number): CurvedPatch | null {
  if (nodeIds.length < 3) return null;
  const n = curvedDivisions(level);
  const ids = nodeIds.slice(0, 3);
  const points: CurvedPoint[] = [];
  const cells: number[][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    points.push(point(ids, [(1 - t) * (1 - 2 * t), t * (2 * t - 1), 4 * t * (1 - t)]));
    if (i > 0) cells.push([i - 1, i]);
  }
  return { points, cells };
}

const lag = (p: number, x: number): number => (p === 0 ? 1 - x * x : (x * (x + p)) / 2);

/**
 * A quadratic face: 6 nodes = triangle [c0 c1 c2 m01 m12 m20]; 8 or 9 nodes =
 * quad [c0 c1 c2 c3 m01 m12 m23 m30 (centre)]. Returns triangles or quads.
 */
export function tessellateFace(nodeIds: number[], level: number): CurvedPatch | null {
  const n = curvedDivisions(level);
  const points: CurvedPoint[] = [];
  const cells: number[][] = [];
  if (nodeIds.length === 6) {
    const ids = nodeIds.slice(0, 6);
    const at = new Map<number, number>();
    for (let i = 0; i <= n; i++) {
      for (let j = 0; i + j <= n; j++) {
        const l1 = i / n;
        const l2 = j / n;
        const l0 = 1 - l1 - l2;
        at.set(i * (n + 1) + j, points.length);
        points.push(point(ids, [l0 * (2 * l0 - 1), l1 * (2 * l1 - 1), l2 * (2 * l2 - 1), 4 * l0 * l1, 4 * l1 * l2, 4 * l2 * l0]));
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; i + j < n; j++) {
        cells.push([at.get(i * (n + 1) + j)!, at.get((i + 1) * (n + 1) + j)!, at.get(i * (n + 1) + j + 1)!]);
        if (i + j < n - 1) {
          cells.push([at.get((i + 1) * (n + 1) + j)!, at.get((i + 1) * (n + 1) + j + 1)!, at.get(i * (n + 1) + j + 1)!]);
        }
      }
    }
    return { points, cells };
  }
  if (nodeIds.length === 8 || nodeIds.length === 9) {
    const ids = nodeIds.slice(0, nodeIds.length);
    const cx = [-1, 1, 1, -1];
    const cy = [-1, -1, 1, 1];
    const mx = [0, 1, 0, -1];
    const my = [-1, 0, 1, 0];
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const x = -1 + (2 * i) / n;
        const y = -1 + (2 * j) / n;
        const w: number[] = [];
        if (nodeIds.length === 9) {
          for (let k = 0; k < 4; k++) w.push(lag(cx[k], x) * lag(cy[k], y));
          for (let k = 0; k < 4; k++) w.push(lag(mx[k], x) * lag(my[k], y));
          w.push(lag(0, x) * lag(0, y));
        } else {
          for (let k = 0; k < 4; k++) w.push(0.25 * (1 + cx[k] * x) * (1 + cy[k] * y) * (cx[k] * x + cy[k] * y - 1));
          for (let k = 0; k < 4; k++) {
            w.push(mx[k] === 0 ? 0.5 * (1 - x * x) * (1 + my[k] * y) : 0.5 * (1 + mx[k] * x) * (1 - y * y));
          }
        }
        points.push(point(ids, w));
      }
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i;
        cells.push([a, a + 1, a + n + 2, a + n + 1]);
      }
    }
    return { points, cells };
  }
  return null;
}

export type QuadraticVolume = "tet10" | "hex20" | "hex27" | "wedge15" | "pyramid13";

export const QUADRATIC_VOLUME_NODES: Record<QuadraticVolume, number> = {
  tet10: 10,
  hex20: 20,
  hex27: 27,
  wedge15: 15,
  pyramid13: 13,
};

// Face node lists (corner order of the linear face tables first, then the
// mid-side nodes in the same cycle, then the centre for 9-node quads), in VTK's
// quadratic node numbering.
const TET10 = [
  [0, 1, 2, 4, 5, 6],
  [0, 3, 1, 7, 8, 4],
  [0, 2, 3, 6, 9, 7],
  [1, 3, 2, 8, 9, 5],
];
const HEX20 = [
  [0, 1, 2, 3, 8, 9, 10, 11],
  [4, 7, 6, 5, 15, 14, 13, 12],
  [0, 4, 5, 1, 16, 12, 17, 8],
  [1, 5, 6, 2, 17, 13, 18, 9],
  [2, 6, 7, 3, 18, 14, 19, 10],
  [3, 7, 4, 0, 19, 15, 16, 11],
];
const HEX27 = HEX20.map((f, i) => [...f, [24, 25, 22, 21, 23, 20][i]]);
const WEDGE15 = [
  [0, 1, 2, 6, 7, 8],
  [3, 5, 4, 11, 10, 9],
  [0, 3, 4, 1, 12, 9, 13, 6],
  [1, 4, 5, 2, 13, 10, 14, 7],
  [2, 5, 3, 0, 14, 11, 12, 8],
];
const PYRAMID13 = [
  [0, 3, 2, 1, 8, 7, 6, 5],
  [0, 1, 4, 5, 10, 9],
  [1, 2, 4, 6, 11, 10],
  [2, 3, 4, 7, 12, 11],
  [3, 0, 4, 8, 9, 12],
];

/** Local node indices of each face of a quadratic volume cell. */
export function quadraticFaces(kind: QuadraticVolume): number[][] {
  switch (kind) {
    case "tet10":
      return TET10;
    case "hex20":
      return HEX20;
    case "hex27":
      return HEX27;
    case "wedge15":
      return WEDGE15;
    default:
      return PYRAMID13;
  }
}
