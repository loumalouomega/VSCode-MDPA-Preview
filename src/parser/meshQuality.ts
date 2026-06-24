// Geometric mesh-quality metrics, modelled on Kratos'
// ComputeMeshQualityProcess but reduced to what a purely geometric mesh can
// answer (no boundary-condition / flag dependent checks like dead-tetra or
// gap/hole detection).
//
// Pure module: imports only the shared data model and the VTK cell-type ids
// (no DOM, no vtk.js, no vscode) so it can run both inside the webview and in
// plain Node unit tests.
//
// Metrics, each classifying every element into good/acceptable/bad/unacceptable
// bands with thresholds mirroring the Kratos defaults:
//   - Aspect / Edge ratio : longest edge / shortest edge.
//   - Min angle (deg)     : volume -> min dihedral angle; surface -> min interior angle.
//   - Max angle (deg)     : volume -> max dihedral angle; surface -> max interior angle.
//   - Size gradation      : per node, max / min characteristic length of touching elements.

import { MdpaModel } from "./types";
import { VtkCellType } from "./geometryMap";

export type QualityBand = "good" | "acceptable" | "bad" | "unacceptable";

export const BAND_ORDER: QualityBand[] = ["good", "acceptable", "bad", "unacceptable"];

export interface MetricResult {
  key: string;
  label: string;
  unit?: string;
  min: number;
  max: number;
  mean: number;
  count: number;
  /** True when larger values are better (min angle); false otherwise. */
  higherIsBetter: boolean;
  /** Ordered [good, acceptable, bad] threshold values. */
  thresholds: [number, number, number];
  bands: Record<QualityBand, number>;
  bandPct: Record<QualityBand, number>;
  histogram: { edges: number[]; counts: number[]; bandOfBin: QualityBand[] };
  /** Entity ids in the bad/unacceptable bands (empty for per-node metrics). */
  badEntityIds: number[];
  /** True for element-level metrics that support in-view highlighting. */
  perElement: boolean;
  /** Share of bad+unacceptable above which the metric is considered failing. */
  failed: boolean;
}

export interface QualityReport {
  elementCount: number;
  analyzedCount: number;
  elementTypes: string[];
  metrics: MetricResult[];
  overallOk: boolean;
}

// --- topology -----------------------------------------------------------
type Category = "point" | "line" | "surface" | "volume" | "unknown";
interface Topo {
  corners: number;
  category: Category;
  faces?: number[][];
}

const C = VtkCellType;

// Local copies of the boundary-face tables (kept in sync with
// webview/meshBuilder.ts). Duplicated here so this module stays free of the
// vtk.js import that meshBuilder pulls in.
const TET_FACES = [
  [0, 1, 2],
  [0, 3, 1],
  [0, 2, 3],
  [1, 3, 2],
];
const HEX_FACES = [
  [0, 1, 2, 3],
  [4, 7, 6, 5],
  [0, 4, 5, 1],
  [1, 5, 6, 2],
  [2, 6, 7, 3],
  [3, 7, 4, 0],
];
const WEDGE_FACES = [
  [0, 1, 2],
  [3, 5, 4],
  [0, 3, 4, 1],
  [1, 4, 5, 2],
  [2, 5, 3, 0],
];
const PYRAMID_FACES = [
  [0, 3, 2, 1],
  [0, 1, 4],
  [1, 2, 4],
  [2, 3, 4],
  [3, 0, 4],
];

function topo(cellType?: number): Topo {
  switch (cellType) {
    case C.VERTEX:
      return { corners: 1, category: "point" };
    case C.LINE:
    case C.QUADRATIC_EDGE:
      return { corners: 2, category: "line" };
    case C.TRIANGLE:
    case C.QUADRATIC_TRIANGLE:
      return { corners: 3, category: "surface", faces: [[0, 1, 2]] };
    case C.QUAD:
    case C.QUADRATIC_QUAD:
    case C.BIQUADRATIC_QUAD:
      return { corners: 4, category: "surface", faces: [[0, 1, 2, 3]] };
    case C.TETRA:
    case C.QUADRATIC_TETRA:
      return { corners: 4, category: "volume", faces: TET_FACES };
    case C.HEXAHEDRON:
    case C.QUADRATIC_HEXAHEDRON:
    case C.TRIQUADRATIC_HEXAHEDRON:
      return { corners: 8, category: "volume", faces: HEX_FACES };
    case C.WEDGE:
    case C.QUADRATIC_WEDGE:
      return { corners: 6, category: "volume", faces: WEDGE_FACES };
    case C.PYRAMID:
    case C.QUADRATIC_PYRAMID:
      return { corners: 5, category: "volume", faces: PYRAMID_FACES };
    default:
      return { corners: 0, category: "unknown" };
  }
}

// --- vector helpers (operate on plain [x,y,z]) --------------------------
type Vec3 = [number, number, number];

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function len(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}
function angleBetween(a: Vec3, b: Vec3): number {
  const la = len(a);
  const lb = len(b);
  if (la === 0 || lb === 0) return 0;
  let c = dot(a, b) / (la * lb);
  if (c > 1) c = 1;
  else if (c < -1) c = -1;
  return Math.acos(c);
}

const RAD2DEG = 180 / Math.PI;

interface CellGeometry {
  edgeRatio: number;
  minAngle: number;
  maxAngle: number;
  charLen: number;
}

// Computes the geometric measures for one element given its corner coords.
function cellGeometry(pts: Vec3[], t: Topo): CellGeometry | undefined {
  if (!t.faces || pts.length < t.corners) return undefined;

  // Unique edges (by sorted local-index pair) -> length, plus dihedral apexes.
  const edgeLen = new Map<number, number>();
  const edgeApex = new Map<number, number[]>();
  const keyOf = (i: number, j: number) => (i < j ? i * 64 + j : j * 64 + i);

  const angles: number[] = [];

  for (const face of t.faces) {
    const n = face.length;
    for (let k = 0; k < n; k++) {
      const a = face[k];
      const b = face[(k + 1) % n];
      const key = keyOf(a, b);
      if (!edgeLen.has(key)) {
        edgeLen.set(key, len(sub(pts[a], pts[b])));
      }
      if (t.category === "volume") {
        // Record a face apex (a face vertex not on this edge) for dihedral.
        const apex = face.find((v) => v !== a && v !== b);
        if (apex !== undefined) {
          const list = edgeApex.get(key) ?? [];
          list.push(apex);
          edgeApex.set(key, list);
        }
      }
    }

    if (t.category === "surface") {
      // Interior corner angles of the polygon.
      for (let k = 0; k < n; k++) {
        const prev = pts[face[(k - 1 + n) % n]];
        const cur = pts[face[k]];
        const next = pts[face[(k + 1) % n]];
        angles.push(angleBetween(sub(prev, cur), sub(next, cur)) * RAD2DEG);
      }
    }
  }

  if (t.category === "volume") {
    // Dihedral angle along each edge shared by two faces.
    for (const [key, apexes] of edgeApex) {
      if (apexes.length < 2) continue;
      // Recover the edge endpoints from the key.
      const a = Math.floor(key / 64);
      const b = key % 64;
      const u = sub(pts[b], pts[a]);
      const ul = len(u);
      if (ul === 0) continue;
      const un: Vec3 = [u[0] / ul, u[1] / ul, u[2] / ul];
      // Project the two apex directions onto the plane perpendicular to the edge.
      const proj = (p: number): Vec3 => {
        const w = sub(pts[p], pts[a]);
        const d = dot(w, un);
        return [w[0] - d * un[0], w[1] - d * un[1], w[2] - d * un[2]];
      };
      angles.push(angleBetween(proj(apexes[0]), proj(apexes[1])) * RAD2DEG);
    }
  }

  let minE = Infinity;
  let maxE = -Infinity;
  let sumE = 0;
  let nE = 0;
  for (const l of edgeLen.values()) {
    if (l < minE) minE = l;
    if (l > maxE) maxE = l;
    sumE += l;
    nE++;
  }
  if (nE === 0 || minE === 0 || angles.length === 0) return undefined;

  let minA = Infinity;
  let maxA = -Infinity;
  for (const a of angles) {
    if (a < minA) minA = a;
    if (a > maxA) maxA = a;
  }

  return {
    edgeRatio: maxE / minE,
    minAngle: minA,
    maxAngle: maxA,
    charLen: sumE / nE,
  };
}

// --- banding ------------------------------------------------------------
const BAD_MAX_PCT = 5;

function classify(
  value: number,
  thresholds: [number, number, number],
  higherIsBetter: boolean
): QualityBand {
  const [good, acc, bad] = thresholds;
  if (higherIsBetter) {
    if (value > good) return "good";
    if (value > acc) return "acceptable";
    if (value > bad) return "bad";
    return "unacceptable";
  }
  if (value < good) return "good";
  if (value < acc) return "acceptable";
  if (value < bad) return "bad";
  return "unacceptable";
}

interface MetricSpec {
  key: string;
  label: string;
  unit?: string;
  higherIsBetter: boolean;
  thresholds: [number, number, number];
  perElement: boolean;
}

const SPECS: Record<string, MetricSpec> = {
  edgeRatio: {
    key: "edgeRatio",
    label: "Aspect / Edge ratio",
    higherIsBetter: false,
    thresholds: [3, 8, 50],
    perElement: true,
  },
  minAngle: {
    key: "minAngle",
    label: "Min angle",
    unit: "°",
    higherIsBetter: true,
    thresholds: [10, 2, 0.5],
    perElement: true,
  },
  maxAngle: {
    key: "maxAngle",
    label: "Max angle",
    unit: "°",
    higherIsBetter: false,
    thresholds: [170, 178, 179.5],
    perElement: true,
  },
  gradation: {
    key: "gradation",
    label: "Size gradation",
    higherIsBetter: false,
    thresholds: [3, 6, 10],
    perElement: false,
  },
};

const HIST_BINS = 28;

function finalize(spec: MetricSpec, values: number[], badEntityIds: number[]): MetricResult {
  const bands: Record<QualityBand, number> = {
    good: 0,
    acceptable: 0,
    bad: 0,
    unacceptable: 0,
  };
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of values) {
    bands[classify(v, spec.thresholds, spec.higherIsBetter)]++;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const count = values.length;
  if (count === 0) {
    min = 0;
    max = 0;
  }
  const pct = (n: number): number => (count > 0 ? (100 * n) / count : 0);
  const bandPct: Record<QualityBand, number> = {
    good: pct(bands.good),
    acceptable: pct(bands.acceptable),
    bad: pct(bands.bad),
    unacceptable: pct(bands.unacceptable),
  };

  // Histogram over [min, max].
  const lo = min;
  const hi = max > min ? max : min + 1;
  const edges: number[] = [];
  for (let i = 0; i <= HIST_BINS; i++) edges.push(lo + ((hi - lo) * i) / HIST_BINS);
  const counts = new Array<number>(HIST_BINS).fill(0);
  for (const v of values) {
    let bin = Math.floor(((v - lo) / (hi - lo)) * HIST_BINS);
    if (bin < 0) bin = 0;
    else if (bin >= HIST_BINS) bin = HIST_BINS - 1;
    counts[bin]++;
  }
  const bandOfBin: QualityBand[] = [];
  for (let i = 0; i < HIST_BINS; i++) {
    const center = (edges[i] + edges[i + 1]) / 2;
    bandOfBin.push(classify(center, spec.thresholds, spec.higherIsBetter));
  }

  const failed = bandPct.bad > BAD_MAX_PCT || bands.unacceptable > 0;

  return {
    key: spec.key,
    label: spec.label,
    unit: spec.unit,
    min,
    max,
    mean: count > 0 ? sum / count : 0,
    count,
    higherIsBetter: spec.higherIsBetter,
    thresholds: spec.thresholds,
    bands,
    bandPct,
    histogram: { edges, counts, bandOfBin },
    badEntityIds,
    perElement: spec.perElement,
    failed,
  };
}

// --- main entry ---------------------------------------------------------
export function computeMeshQuality(model: MdpaModel): QualityReport {
  // nodeId (1-based Kratos id) -> coord index.
  const nodeIndex = new Map<number, number>();
  for (let i = 0; i < model.nodeCount; i++) nodeIndex.set(model.nodeIds[i], i);

  const coordOf = (nodeId: number): Vec3 | undefined => {
    const idx = nodeIndex.get(nodeId);
    if (idx === undefined) return undefined;
    const o = idx * 3;
    return [model.coords[o], model.coords[o + 1], model.coords[o + 2]];
  };

  // Analyse Elements; if a mesh has none, fall back to surface/volume cells in
  // any block so 2D condition/geometry-only meshes still report something.
  let blocks = model.blocks.filter((b) => b.kind === "Elements");
  if (blocks.length === 0) {
    blocks = model.blocks.filter((b) => {
      const cat = topo(b.vtkCellType).category;
      return cat === "surface" || cat === "volume";
    });
  }

  const edgeRatioValues: number[] = [];
  const minAngleValues: number[] = [];
  const maxAngleValues: number[] = [];
  const edgeRatioBad: number[] = [];
  const minAngleBad: number[] = [];
  const maxAngleBad: number[] = [];

  // Per-node smallest / largest touching element characteristic length.
  const nodeMinLen = new Map<number, number>();
  const nodeMaxLen = new Map<number, number>();

  const elementTypes = new Set<string>();
  let elementCount = 0;
  let analyzedCount = 0;

  for (const block of blocks) {
    const t = topo(block.vtkCellType);
    elementCount += block.count;
    if (t.category !== "surface" && t.category !== "volume") continue;

    for (let i = 0; i < block.count; i++) {
      const base = i * block.stride;
      const pts: Vec3[] = [];
      let ok = true;
      for (let k = 0; k < t.corners; k++) {
        const p = coordOf(block.connectivity[base + k]);
        if (!p) {
          ok = false;
          break;
        }
        pts.push(p);
      }
      if (!ok) continue;

      const g = cellGeometry(pts, t);
      if (!g) continue;

      analyzedCount++;
      elementTypes.add(block.name);
      const id = block.entityIds[i];

      edgeRatioValues.push(g.edgeRatio);
      minAngleValues.push(g.minAngle);
      maxAngleValues.push(g.maxAngle);

      if (classify(g.edgeRatio, SPECS.edgeRatio.thresholds, false) === "bad" ||
          classify(g.edgeRatio, SPECS.edgeRatio.thresholds, false) === "unacceptable") {
        edgeRatioBad.push(id);
      }
      const minBand = classify(g.minAngle, SPECS.minAngle.thresholds, true);
      if (minBand === "bad" || minBand === "unacceptable") minAngleBad.push(id);
      const maxBand = classify(g.maxAngle, SPECS.maxAngle.thresholds, false);
      if (maxBand === "bad" || maxBand === "unacceptable") maxAngleBad.push(id);

      // Gradation bookkeeping: update each touching node with this charLen.
      for (let k = 0; k < t.corners; k++) {
        const nid = block.connectivity[base + k];
        const cur = nodeMinLen.get(nid);
        if (cur === undefined || g.charLen < cur) nodeMinLen.set(nid, g.charLen);
        const curMax = nodeMaxLen.get(nid);
        if (curMax === undefined || g.charLen > curMax) nodeMaxLen.set(nid, g.charLen);
      }
    }
  }

  const gradationValues: number[] = [];
  for (const [nid, minL] of nodeMinLen) {
    const maxL = nodeMaxLen.get(nid)!;
    if (minL > 0) gradationValues.push(maxL / minL);
  }

  const metrics: MetricResult[] = [
    finalize(SPECS.edgeRatio, edgeRatioValues, edgeRatioBad),
    finalize(SPECS.minAngle, minAngleValues, minAngleBad),
    finalize(SPECS.maxAngle, maxAngleValues, maxAngleBad),
    finalize(SPECS.gradation, gradationValues, []),
  ];

  const overallOk = analyzedCount > 0 && metrics.every((m) => !m.failed);

  return {
    elementCount,
    analyzedCount,
    elementTypes: Array.from(elementTypes),
    metrics,
    overallOk,
  };
}
