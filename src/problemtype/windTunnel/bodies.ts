/**
 * Several bodies in one virtual wind tunnel: placing them, refusing overlaps,
 * merging their surfaces for the distance, and splitting the carved wall back
 * into one part per body.
 *
 * A body is placed like the single one (unit, rotation about its centre) and
 * then moved to its tunnel-frame position. The distance comes from the union
 * of the surfaces (one merged STL, winding-number sign), so touching or
 * overlapping bodies are refused up front: the plan reports the pair and the
 * gap. After the carve the single `Body` wall is split by connectivity and
 * each component matched to its nearest body (`Body_1…n`, plus a `Bodies`
 * parent the RANS wall function applies to).
 *
 * Pure: no vscode, no wasm, no file system.
 */

import { bodyMetrics, placeBody } from "./body";
import type { BodyMetrics, Vec3 } from "./body";
import { triangleSurfaceOf } from "../../parser/gridSample";
import { translateCoords } from "../../parser/transformCoords";
import { VtkCellType } from "../../parser/geometryMap";
import type { MdpaModel, SubModelPart } from "../../parser/types";
import { finalizeModel } from "../../parser/modelBuilder";
import { planPlacedTunnel } from "./plan";
import type { PlacedBodySummary, WindTunnelParams, WindTunnelPlan } from "./plan";
import type { WindTunnelBodySpec } from "./plan";

export interface PlacedBody {
  name: string;
  model: MdpaModel;
  metrics: BodyMetrics;
  /** Tunnel-frame centre (bounding-box centre) in metres. */
  center: Vec3;
}

type Tri = { a: Vec3; b: Vec3; c: Vec3 };

function trianglesOf(model: MdpaModel): Tri[] {
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

/** Every k-th element, capped at `limit` — deterministic sampling for the gap checks. */
function sample<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  const step = Math.ceil(items.length / limit);
  const out: T[] = [];
  for (let i = 0; i < items.length; i += step) out.push(items[i]);
  return out;
}

/** Places each body (unit, rotation about its centre, then the tunnel-frame position). */
export function placeBodies(models: MdpaModel[], specs: WindTunnelBodySpec[], unitOf: (s: WindTunnelBodySpec) => number): PlacedBody[] {
  return models.map((model, i) => {
    const spec = specs[i] ?? {};
    const scale = unitOf(spec);
    const centered = placeBody(model, { scale, rotation: spec.rotation });
    const position = spec.position ?? [0, 0, 0];
    const placed = position[0] === 0 && position[1] === 0 && position[2] === 0 ? centered : translateCoords(centered, position[0], position[1], position[2]);
    const metrics = bodyMetrics(placed);
    return {
      name: spec.name ?? `body ${i + 1}`,
      model: placed,
      metrics,
      center: [(metrics.min[0] + metrics.max[0]) / 2, (metrics.min[1] + metrics.max[1]) / 2, (metrics.min[2] + metrics.max[2]) / 2] as Vec3,
    };
  });
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/**
 * Möller triangle–triangle intersection (no divisions, with an epsilon band).
 * Coplanar pairs fall back to a 2D edge-overlap test on the dominant plane.
 */
export function trianglesIntersect(s: Tri, t: Tri): boolean {
  return triTri(s, t);
}

function triTri(s: Tri, t: Tri): boolean {
  const e1 = sub(s.b, s.a);
  const e2 = sub(s.c, s.a);
  const n1 = cross(e1, e2);
  const d1 = -dot(n1, s.a);
  let du0 = dot(n1, t.a) + d1;
  let du1 = dot(n1, t.b) + d1;
  let du2 = dot(n1, t.c) + d1;
  if (Math.abs(du0) < 1e-12) du0 = 0;
  if (Math.abs(du1) < 1e-12) du1 = 0;
  if (Math.abs(du2) < 1e-12) du2 = 0;
  if (du0 * du1 > 0 && du0 * du2 > 0) return false;
  const f1 = sub(t.b, t.a);
  const f2 = sub(t.c, t.a);
  const n2 = cross(f1, f2);
  const d2 = -dot(n2, t.a);
  let dv0 = dot(n2, s.a) + d2;
  let dv1 = dot(n2, s.b) + d2;
  let dv2 = dot(n2, s.c) + d2;
  if (Math.abs(dv0) < 1e-12) dv0 = 0;
  if (Math.abs(dv1) < 1e-12) dv1 = 0;
  if (Math.abs(dv2) < 1e-12) dv2 = 0;
  if (dv0 * dv1 > 0 && dv0 * dv2 > 0) return false;
  const coplanar = dv0 === 0 && dv1 === 0 && dv2 === 0;
  if (coplanar) return coplanarOverlap(s, t, Math.abs(n1[0]) >= Math.abs(n1[1]) && Math.abs(n1[0]) >= Math.abs(n1[2]) ? 0 : Math.abs(n1[1]) >= Math.abs(n1[2]) ? 1 : 2);
  const d = cross(n1, n2);
  const axis = Math.abs(d[0]) >= Math.abs(d[1]) && Math.abs(d[0]) >= Math.abs(d[2]) ? 0 : Math.abs(d[1]) >= Math.abs(d[2]) ? 1 : 2;
  const proj = (p: Vec3): number => p[axis];
  const sPts = [s.a, s.b, s.c];
  const tPts = [t.a, t.b, t.c];
  const interval = (pts: Vec3[], dists: number[]): [number, number] => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        if (dists[i] * dists[j] >= 0) continue;
        const t = dists[i] / (dists[i] - dists[j]);
        const v = proj(pts[i]) + (proj(pts[j]) - proj(pts[i])) * t;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    return [lo, hi];
  };
  const [s0, s1] = interval(sPts, [dv0, dv1, dv2]);
  const [t0, t1] = interval(tPts, [du0, du1, du2]);
  return Math.max(s0, t0) <= Math.min(s1, t1);
}

function coplanarOverlap(s: Tri, t: Tri, drop: number): boolean {
  const p = (v: Vec3): [number, number] => (drop === 0 ? [v[1], v[2]] : drop === 1 ? [v[0], v[2]] : [v[0], v[1]]);
  const edges = (x: Tri): [[number, number], [number, number]][] => [
    [p(x.a), p(x.b)],
    [p(x.b), p(x.c)],
    [p(x.c), p(x.a)],
  ];
  const inside = (q: [number, number], x: Tri): boolean => {
    const [a, b, c] = [p(x.a), p(x.b), p(x.c)];
    const d = (u: [number, number], v: [number, number], w: [number, number]): number => (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]);
    const s1 = d(a, b, q);
    const s2 = d(b, c, q);
    const s3 = d(c, a, q);
    return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
  };
  const seg = (u: [number, number], v: [number, number], w: [number, number], z: [number, number]): boolean => {
    const d = (a: [number, number], b: [number, number], c: [number, number]): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const d1 = d(w, z, u);
    const d2 = d(w, z, v);
    const d3 = d(u, v, w);
    const d4 = d(u, v, z);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  };
  const se = edges(s);
  const te = edges(t);
  for (const [u, v] of se) for (const [w, z] of te) if (seg(u, v, w, z)) return true;
  for (const tri of [s, t]) for (const q of [p(tri.a)]) if (inside(q, tri === s ? t : s)) return true;
  return false;
}

/** Gap between two bounding boxes (0 when they overlap), in metres. */
function bboxGap(aMin: Vec3, aMax: Vec3, bMin: Vec3, bMax: Vec3): number {
  let g = 0;
  for (let k = 0; k < 3; k++) g = Math.max(g, Math.max(aMin[k] - bMax[k], bMin[k] - aMax[k]));
  return Math.max(0, g);
}

/**
 * Refuses overlapping or touching bodies: intersecting triangles, or a gap
 * below the minimum (twice the surface size — MMG needs cells between walls).
 * Surfaces are stride-sampled, so a spike far smaller than a triangle could
 * slip through; the message says what was checked.
 */
export function checkBodyGaps(bodies: PlacedBody[], minGap: number): string[] {
  const problems: string[] = [];
  const tris = bodies.map((b) => sample(trianglesOf(b.model), 1500));
  const verts = bodies.map((b) => {
    const seen: Vec3[] = [];
    for (const t of tris[bodies.indexOf(b)]) seen.push(t.a, t.b, t.c);
    return sample(seen, 1500);
  });
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const pair = `"${bodies[i].name}" and "${bodies[j].name}"`;
      if (bboxGap(bodies[i].metrics.min, bodies[i].metrics.max, bodies[j].metrics.min, bodies[j].metrics.max) > minGap) continue;
      let hit = false;
      for (const a of tris[i]) {
        for (const b of tris[j]) {
          if (trianglesIntersect(a, b)) {
            hit = true;
            break;
          }
        }
        if (hit) break;
      }
      if (hit) {
        problems.push(`Bodies ${pair} overlap: separate them so every wall stands free.`);
        continue;
      }
      let gap = Infinity;
      for (const a of verts[i]) {
        for (const b of verts[j]) {
          const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
          if (d < gap) gap = d;
        }
      }
      if (!(gap >= minGap)) {
        problems.push(`Bodies ${pair} are ${gap.toPrecision(3)} m apart, below the minimum gap of ${minGap.toPrecision(3)} m (twice the surface size): the mesh cannot put cells between their walls.`);
      }
    }
  }
  return problems;
}

/** Merges placed body surfaces into one model for the distance sampling. */
export function mergeBodySurfaces(bodies: PlacedBody[]): MdpaModel {
  const coords: number[] = [];
  const connectivity: number[] = [];
  const entityIds: number[] = [];
  let nodes = 0;
  let cells = 0;
  for (const b of bodies) {
    const { surface } = triangleSurfaceOf(b.model);
    const index = new Map<number, number>();
    for (let i = 0; i < surface.nodeCount; i++) index.set(surface.nodeIds[i], ++nodes);
    for (let i = 0; i < surface.nodeCount; i++) coords.push(surface.coords[3 * i], surface.coords[3 * i + 1], surface.coords[3 * i + 2]);
    for (const blk of surface.blocks) {
      if (blk.vtkCellType !== VtkCellType.TRIANGLE) continue;
      for (let c = 0; c < blk.count; c++) {
        connectivity.push(index.get(blk.connectivity[3 * c])!, index.get(blk.connectivity[3 * c + 1])!, index.get(blk.connectivity[3 * c + 2])!);
        entityIds.push(++cells);
      }
    }
  }
  const nodeIds = Int32Array.from({ length: nodes }, (_, i) => i + 1);
  return finalizeModel({
    nodeCount: nodes,
    coords: Float32Array.from(coords),
    nodeIds,
    blocks: [
      {
        kind: "Conditions",
        name: "SurfaceCondition3D3N",
        vtkCellType: VtkCellType.TRIANGLE,
        stride: 3,
        count: cells,
        connectivity: Int32Array.from(connectivity),
        entityIds: Int32Array.from(entityIds),
        propertyIds: new Int32Array(cells),
      },
    ],
    subModelParts: [],
    fields: [],
    diagnostics: [],
  });
}

/**
 * Splits the carved `Body` wall into one part per body plus a `Bodies` parent
 * holding the whole wall (the RANS wall function applies to one part). Wall
 * triangles are grouped by connectivity, each group matched to its nearest
 * body centre; the task's gap rule keeps the match unambiguous.
 */
export function splitWallByBodies(model: MdpaModel, bodies: { name: string; center: Vec3 }[]): { model: MdpaModel; matched: string[]; problems: string[] } {
  const problems: string[] = [];
  const body = model.subModelParts.find((p) => p.name === "Body");
  if (!body) return { model, matched: [], problems: ["The carved mesh has no \"Body\" wall to split."] };
  // Triangles of the Body part, grouped by shared nodes (union-find).
  const tris: { ids: [number, number, number]; cond: number }[] = [];
  const nodeIndex = new Map<number, number>();
  for (let i = 0; i < model.nodeCount; i++) nodeIndex.set(model.nodeIds[i], i);
  const condSet = new Set<number>(body.conditionIds);
  for (const b of model.blocks) {
    if (b.kind !== "Conditions" || b.stride !== 3) continue;
    for (let c = 0; c < b.count; c++) {
      if (!condSet.has(b.entityIds[c])) continue;
      tris.push({ ids: [b.connectivity[3 * c], b.connectivity[3 * c + 1], b.connectivity[3 * c + 2]], cond: b.entityIds[c] });
    }
  }
  const parent = new Int32Array(tris.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const firstSeen = new Map<number, number>();
  tris.forEach((t, i) => {
    for (const n of t.ids) {
      const prev = firstSeen.get(n);
      if (prev === undefined) firstSeen.set(n, i);
      else {
        const a = find(prev);
        const b = find(i);
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
  });
  const groups = new Map<number, number[]>();
  tris.forEach((_, i) => {
    const r = find(i);
    const g = groups.get(r) ?? [];
    g.push(i);
    groups.set(r, g);
  });
  const at = (id: number): Vec3 => {
    const i = nodeIndex.get(id)!;
    return [model.coords[3 * i], model.coords[3 * i + 1], model.coords[3 * i + 2]];
  };
  const comps = [...groups.values()].map((idxs) => {
    const nodes = new Set<number>();
    for (const i of idxs) for (const n of tris[i].ids) nodes.add(n);
    const centroid: Vec3 = [0, 0, 0];
    for (const n of nodes) {
      const p = at(n);
      centroid[0] += p[0];
      centroid[1] += p[1];
      centroid[2] += p[2];
    }
    centroid[0] /= nodes.size;
    centroid[1] /= nodes.size;
    centroid[2] /= nodes.size;
    let best = 0;
    let bestD = Infinity;
    bodies.forEach((b, bi) => {
      const d = (centroid[0] - b.center[0]) ** 2 + (centroid[1] - b.center[1]) ** 2 + (centroid[2] - b.center[2]) ** 2;
      if (d < bestD) {
        bestD = d;
        best = bi;
      }
    });
    return { idxs, nodes: [...nodes], body: best, gap: Math.sqrt(bestD) };
  });
  const perBody: number[][] = bodies.map(() => []);
  comps.forEach((c, ci) => perBody[c.body].push(ci));
  bodies.forEach((b, bi) => {
    if (perBody[bi].length === 0) problems.push(`Body "${b.name}" has no wall: it may lie inside another body or outside the tunnel.`);
  });
  if (problems.length > 0) return { model, matched: [], problems };
  if (comps.length > bodies.length) {
    problems.push(`${comps.length} wall components for ${bodies.length} bodies: extra slivers merge into their nearest body.`);
  }
  const empty = new Int32Array(0);
  const mkPart = (name: string, nodeIds: number[], condIds: number[]): SubModelPart => ({
    name,
    nodeIds: Int32Array.from([...nodeIds].sort((a, b) => a - b)),
    elementIds: empty,
    conditionIds: Int32Array.from([...condIds].sort((a, b) => a - b)),
    geometryIds: empty,
    constraintIds: empty,
    path: name,
    children: [],
  });
  const parts: SubModelPart[] = [];
  const allNodes = new Set<number>();
  const allConds: number[] = [];
  const matched: string[] = [];
  bodies.forEach((b, bi) => {
    const nodes = new Set<number>();
    const conds: number[] = [];
    for (const ci of perBody[bi]) {
      for (const i of comps[ci].idxs) conds.push(tris[i].cond);
      for (const n of comps[ci].nodes) {
        nodes.add(n);
        allNodes.add(n);
      }
    }
    for (const i of perBody[bi]) for (const t of comps[i].idxs) allConds.push(tris[t].cond);
    parts.push(mkPart(`Body_${bi + 1}`, [...nodes], conds));
    matched.push(`Body_${bi + 1} ("${b.name}")`);
  });
  parts.push(mkPart("Bodies", [...allNodes], allConds));
  // Drop only the part entry: the wall conditions stay in the blocks, now
  // owned by Body_1…n/Bodies (deleteSubModelPart would delete the entities).
  const next = { ...model, subModelParts: [...model.subModelParts.filter((q) => q.name !== "Body" && q.path !== "Body"), ...parts] };
  return { model: next, matched, problems };
}

/** One body in plain words, for the plan summary and the wizard review. */
export function describeBody(b: PlacedBodySummary, i: number): string {
  return `Body ${i + 1} ("${b.name}"): ${b.size.map((v) => +v.toPrecision(4)).join(" × ")} m, ${b.triangles.toLocaleString("en-US")} triangles, frontal area ${+b.frontalArea.toPrecision(4)} m², centre [${b.center.map((v) => +v.toPrecision(4)).join(", ")}]${b.closed ? "" : ` — not clean: ${b.problems.join("; ")}`}`;
}

/**
 * Plans a tunnel around several bodies: each placed (unit, rotation, then
 * position), the union meshed like one body, the first giving the reference
 * length, area and moment point. Shared sizing, estimate and steps come from
 * the single-body planner over the union.
 */
export function planTunnelBodies(params: WindTunnelParams, models: MdpaModel[], unitOf: (s: { unit?: string | number }) => number): WindTunnelPlan {
  const specs = params.bodies ?? [];
  const warnings: string[] = [];
  const errors: string[] = [];
  if (specs.length === 0) throw new Error("Give at least one body.");
  if (specs.length !== models.length) {
    throw new Error(`Got ${models.length} bod${models.length === 1 ? "y" : "ies"} for ${specs.length} bodies entries.`);
  }
  const names = specs.map((s, i) => s.name ?? `body ${i + 1}`);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length > 0) errors.push(`Body names must be unique (doubled: ${[...new Set(dupes)].join(", ")}).`);
  const bodies = placeBodies(models.slice(0, specs.length), specs, unitOf);
  bodies.forEach((b) => {
    if (!b.metrics.closed) warnings.push(`Body "${b.name}" is not clean: ${b.metrics.problems.join("; ")}. The distance sign is computed with the winding number, which tolerates small gaps, but a leaky body gives a leaky wall.`);
    if (b.metrics.signedVolume < 0) warnings.push(`Body "${b.name}" is wound inward; this does not matter here (the sign comes from the winding number).`);
  });
  const unionMin: Vec3 = [Infinity, Infinity, Infinity];
  const unionMax: Vec3 = [-Infinity, -Infinity, -Infinity];
  let surfaceArea = 0;
  let frontalArea = 0;
  let triangles = 0;
  const unionProblems: string[] = [];
  let unionSignedVolume = 0;
  for (const b of bodies) {
    for (let k = 0; k < 3; k++) {
      unionMin[k] = Math.min(unionMin[k], b.metrics.min[k]);
      unionMax[k] = Math.max(unionMax[k], b.metrics.max[k]);
    }
    surfaceArea += b.metrics.surfaceArea;
    frontalArea += b.metrics.frontalArea;
    triangles += b.metrics.triangles;
    unionSignedVolume += b.metrics.signedVolume;
    for (const p of b.metrics.problems) unionProblems.push(`"${b.name}": ${p}`);
  }
  const unionBody = {
    triangles,
    nodes: bodies.reduce((s, b) => s + b.metrics.nodes, 0),
    min: unionMin,
    max: unionMax,
    size: [unionMax[0] - unionMin[0], unionMax[1] - unionMin[1], unionMax[2] - unionMin[2]] as Vec3,
    surfaceArea,
    signedVolume: unionSignedVolume,
    frontalArea,
    boundaryEdges: bodies.reduce((s, b) => s + b.metrics.boundaryEdges, 0),
    nonManifoldEdges: bodies.reduce((s, b) => s + b.metrics.nonManifoldEdges, 0),
    inconsistentFaces: bodies.reduce((s, b) => s + b.metrics.inconsistentFaces, 0),
    degenerateFaces: bodies.reduce((s, b) => s + b.metrics.degenerateFaces, 0),
    closed: bodies.every((b) => b.metrics.closed),
    problems: unionProblems,
  };
  const merged = mergeBodySurfaces(bodies);
  const refLength = bodies[0]?.metrics.size[0] ?? 1;
  const plan = planPlacedTunnel(params, merged, unionBody, refLength, warnings, errors, 1);
  for (const p of checkBodyGaps(bodies, 2 * plan.sizes.surface)) plan.errors.push(p);
  const summaries: PlacedBodySummary[] = bodies.map((b, bi) => ({
    name: b.name,
    size: b.metrics.size,
    surfaceArea: b.metrics.surfaceArea,
    frontalArea: b.metrics.frontalArea,
    center: b.center,
    unitScale: unitOf(specs[bi] ?? {}),
    triangles: b.metrics.triangles,
    closed: b.metrics.closed,
    problems: b.metrics.problems,
  }));
  plan.bodies = summaries;
  // The wall parts are split per body after the carve.
  const splitAt = plan.steps.findIndex((s) => s.id === "wall" || s.id === "distance");
  if (plan.mode === "bodyFitted" && splitAt >= 0) {
    plan.steps.splice(splitAt, 0, { id: "split", label: "Split the wall per body", weight: 1 });
  }
  return plan;
}

/** The minimum wall-to-wall gap, from the plan's surface size. */
export function minimumBodyGap(plan: Pick<WindTunnelPlan, "sizes">): number {
  return 2 * plan.sizes.surface;
}

