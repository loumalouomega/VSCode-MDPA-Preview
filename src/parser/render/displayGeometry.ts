// Parsed MDPA entities -> backend-neutral display geometry (roadmap item 12).
//
// Moved verbatim from webview/meshBuilder.ts's buildPolyData, minus the final
// vtk.js object construction, so the whole topology pass is Node-testable and
// both renderer backends consume identical arrays.
//
// Surface cells (triangle/quad) become polygons; line cells become lines;
// points/unknown cells become vertices. Volume cells (tet/hex/wedge/pyramid)
// are reduced to their boundary surface: each cell contributes its faces, and
// faces shared by two cells cancel out (boundary-face rule), leaving only the
// outer skin. Face keys use BigInt packing (sorted node ids) instead of string
// joins — faster for large meshes with millions of faces; see
// src/parser/faceKey.ts for the packing scheme.

import type { MdpaModel } from "../types";
import { VtkCellType } from "../geometryMap";
import { faceKey } from "../faceKey";
import type { BuiltDisplayGeometry, DisplayGeometry } from "./types";
import {
  curvedPointKey,
  quadraticFaces,
  QUADRATIC_VOLUME_NODES,
  tessellateEdge,
  tessellateFace,
  type CurvedPatch,
  type CurvedPoint,
  type QuadraticVolume,
} from "./curvedDisplay";

export interface PreparedNodes {
  index: Map<number, number>;
  coords: Float32Array;
}

export function prepareNodes(model: MdpaModel): PreparedNodes {
  const index = new Map<number, number>();
  for (let i = 0; i < model.nodeCount; i++) {
    index.set(model.nodeIds[i], i);
  }
  return { index, coords: model.coords };
}

export interface Cell {
  cellType?: number;
  nodeIds: ArrayLike<number>;
  /** Source entity id; used to align cell-data field scalars. */
  entityId?: number;
}

// Optional field-scalar attachment. Exactly one of the two providers is used
// depending on whether the field is point-data (nodal) or cell-data
// (elemental/conditional).
export interface FieldAttach {
  name: string;
  /** Nodal scalar for a global node id (NaN when undefined). Point-data path. */
  pointScalar?: (globalNodeId: number) => number;
  /** Per-cell scalar for a source entity id (NaN when undefined). Cell-data path. */
  cellScalar?: (entityId: number | undefined) => number;
}

type Category = "point" | "line" | "surface" | "volume" | "unknown";
interface Topo {
  corners: number;
  category: Category;
  faces?: number[][];
}

const C = VtkCellType;

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
      return { corners: 3, category: "surface" };
    case C.QUAD:
    case C.QUADRATIC_QUAD:
    case C.BIQUADRATIC_QUAD:
      return { corners: 4, category: "surface" };
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

export interface BuildDisplayGeometryOptions {
  /**
   * Also return the local->global node id map and the per-cell owning entity
   * id (verts -> lines -> polys order) so a picked cell can be resolved back
   * to a model entity — see src/parser/pickResolve.ts. Skipped by default:
   * the extra arrays cost real memory on a multi-million-cell mesh that will
   * never be clicked on (overlays, glyph anchors, etc).
   */
  wantPickMaps?: boolean;
  /**
   * Draw quadratic cells with their mid-side nodes (display only): edges and
   * faces are subdivided 2^level times with the cell's shape functions. Off by
   * default, which keeps the output identical to the linear skeleton.
   */
  curved?: { level: number };
}

const CURVED_VOLUME: Record<number, QuadraticVolume> = {
  [C.QUADRATIC_TETRA]: "tet10",
  [C.QUADRATIC_HEXAHEDRON]: "hex20",
  [C.TRIQUADRATIC_HEXAHEDRON]: "hex27",
  [C.QUADRATIC_WEDGE]: "wedge15",
  [C.QUADRATIC_PYRAMID]: "pyramid13",
};
const CURVED_SURFACE_NODES: Record<number, number> = {
  [C.QUADRATIC_TRIANGLE]: 6,
  [C.QUADRATIC_QUAD]: 8,
  [C.BIQUADRATIC_QUAD]: 9,
};

export function buildDisplayGeometry(
  prep: PreparedNodes,
  cells: Cell[],
  attach?: FieldAttach,
  opts?: BuildDisplayGeometryOptions
): BuiltDisplayGeometry | null {
  const localPoints: number[] = [];
  const localIndex = new Map<number, number>();
  const polys: number[] = [];
  const lines: number[] = [];
  const verts: number[] = [];
  const wantPickMaps = !!opts?.wantPickMaps;

  // Point-data scalars, aligned 1:1 with localPoints by filling at the moment a
  // new local index is born inside localOf — keeps order correct regardless of
  // boundary-face extraction. localGlobalIds (pick maps) rides along the same way.
  const pointScalar = attach?.pointScalar;
  const localScalars: number[] | undefined = pointScalar ? [] : undefined;
  const localGlobalIds: number[] | undefined = wantPickMaps ? [] : undefined;

  const localOf = (id: number): number | undefined => {
    const cached = localIndex.get(id);
    if (cached !== undefined) return cached;
    const base = prep.index.get(id);
    if (base === undefined) return undefined;
    const li = localPoints.length / 3;
    const off = base * 3;
    localPoints.push(prep.coords[off], prep.coords[off + 1], prep.coords[off + 2]);
    if (localScalars) localScalars.push(pointScalar!(id));
    localGlobalIds?.push(id);
    localIndex.set(id, li);
    return li;
  };

  // Cell-data scalars, collected per emitted cell in VTK's verts→lines→polys
  // enumeration order. Volume boundary faces inherit their owning cell's value.
  const cellScalar = attach?.cellScalar;
  const vertScalars: number[] | undefined = cellScalar ? [] : undefined;
  const lineScalars: number[] | undefined = cellScalar ? [] : undefined;
  const polyScalars: number[] | undefined = cellScalar ? [] : undefined;

  // Pick-map entity ids, same per-cell enumeration as the scalar arrays above
  // but tracked independently — needed even when there is no FieldAttach.
  const vertEntities: number[] | undefined = wantPickMaps ? [] : undefined;
  const lineEntities: number[] | undefined = wantPickMaps ? [] : undefined;
  const polyEntities: number[] | undefined = wantPickMaps ? [] : undefined;

  // Curved display: a point is a weighted mix of a cell's own nodes, cached by
  // its (id, weight) key so shared edges and faces weld across cells.
  const curved = opts?.curved;
  const curvedIndex = new Map<string, number>();
  const curvedLocal = (p: CurvedPoint): number | undefined => {
    if (p.ids.length === 1) return localOf(p.ids[0]);
    const key = curvedPointKey(p);
    const cached = curvedIndex.get(key);
    if (cached !== undefined) return cached;
    let x = 0;
    let y = 0;
    let z = 0;
    let sc = 0;
    let best = p.ids[0];
    let bestW = -Infinity;
    for (let i = 0; i < p.ids.length; i++) {
      const base = prep.index.get(p.ids[i]);
      if (base === undefined) return undefined;
      const w = p.w[i];
      x += w * prep.coords[base * 3];
      y += w * prep.coords[base * 3 + 1];
      z += w * prep.coords[base * 3 + 2];
      if (pointScalar) sc += w * pointScalar(p.ids[i]);
      if (w > bestW) {
        bestW = w;
        best = p.ids[i];
      }
    }
    const li = localPoints.length / 3;
    localPoints.push(x, y, z);
    localScalars?.push(sc);
    localGlobalIds?.push(best);
    curvedIndex.set(key, li);
    return li;
  };
  const emitPatch = (patch: CurvedPatch, kind: "line" | "poly", scalarOf: number, entity: number): boolean => {
    const map: number[] = [];
    for (const p of patch.points) {
      const li = curvedLocal(p);
      if (li === undefined) return false;
      map.push(li);
    }
    for (const c of patch.cells) {
      const lis = c.map((k) => map[k]);
      if (kind === "line") {
        lines.push(lis.length, ...lis);
        lineScalars?.push(scalarOf);
        lineEntities?.push(entity);
      } else {
        polys.push(lis.length, ...lis);
        polyScalars?.push(scalarOf);
        polyEntities?.push(entity);
      }
    }
    return true;
  };
  const faceFull = curved ? new Map<bigint, number[]>() : undefined;

  const faceIds = new Map<bigint, number[]>();
  const faceCount = new Map<bigint, number>();
  const trackOwner = !!cellScalar || wantPickMaps;
  const faceOwner = trackOwner ? new Map<bigint, number | undefined>() : undefined;

  for (const cell of cells) {
    const t = topo(cell.cellType);

    if (cell.cellType === undefined || t.category === "unknown") {
      for (let i = 0; i < cell.nodeIds.length; i++) {
        const li = localOf(cell.nodeIds[i]);
        if (li !== undefined) {
          verts.push(1, li);
          vertScalars?.push(cellScalar!(cell.entityId));
          vertEntities?.push(cell.entityId ?? -1);
        }
      }
      continue;
    }

    const cornerCount = Math.min(t.corners, cell.nodeIds.length);
    const corners: number[] = [];
    let hasAll = true;
    for (let i = 0; i < cornerCount; i++) {
      corners.push(cell.nodeIds[i]);
      if (prep.index.get(cell.nodeIds[i]) === undefined) {
        hasAll = false;
        break;
      }
    }
    if (!hasAll || corners.length < t.corners) continue;

    if (t.category === "point") {
      const li = localOf(corners[0]);
      if (li !== undefined) {
        verts.push(1, li);
        vertScalars?.push(cellScalar!(cell.entityId));
        vertEntities?.push(cell.entityId ?? -1);
      }
    } else if (t.category === "line") {
      if (curved && cell.cellType === C.QUADRATIC_EDGE && cell.nodeIds.length >= 3) {
        const full = Array.from({ length: 3 }, (_, i) => cell.nodeIds[i]);
        const patch = tessellateEdge(full, curved.level);
        if (patch && full.every((id) => prep.index.has(id))) {
          if (emitPatch(patch, "line", cellScalar ? cellScalar(cell.entityId) : 0, cell.entityId ?? -1)) continue;
        }
      }
      const a = localOf(corners[0]);
      const b = localOf(corners[1]);
      if (a !== undefined && b !== undefined) {
        lines.push(2, a, b);
        lineScalars?.push(cellScalar!(cell.entityId));
        lineEntities?.push(cell.entityId ?? -1);
      }
    } else if (t.category === "surface") {
      const need = cell.cellType === undefined ? 0 : CURVED_SURFACE_NODES[cell.cellType] ?? 0;
      if (curved && need && cell.nodeIds.length >= need) {
        const full = Array.from({ length: need }, (_, i) => cell.nodeIds[i]);
        if (full.every((id) => prep.index.has(id))) {
          const patch = tessellateFace(full, curved.level);
          if (patch && emitPatch(patch, "poly", cellScalar ? cellScalar(cell.entityId) : 0, cell.entityId ?? -1)) continue;
        }
      }
      const lis = corners.map(localOf) as number[];
      polys.push(lis.length, ...lis);
      polyScalars?.push(cellScalar!(cell.entityId));
      polyEntities?.push(cell.entityId ?? -1);
    } else if (t.category === "volume" && t.faces) {
      const qv = curved && cell.cellType !== undefined ? CURVED_VOLUME[cell.cellType] : undefined;
      const qFaces = qv && cell.nodeIds.length >= QUADRATIC_VOLUME_NODES[qv] ? quadraticFaces(qv) : undefined;
      for (let f = 0; f < t.faces.length; f++) {
        const ids = t.faces[f].map((fi) => corners[fi]);
        const key = faceKey(ids);
        faceCount.set(key, (faceCount.get(key) ?? 0) + 1);
        if (!faceIds.has(key)) {
          faceIds.set(key, ids);
          faceOwner?.set(key, cell.entityId);
          if (qFaces) {
            const full = qFaces[f].map((li) => cell.nodeIds[li]);
            if (full.every((id) => prep.index.has(id))) faceFull!.set(key, full);
          }
        }
      }
    }
  }

  for (const [key, ids] of faceIds) {
    if (faceCount.get(key) === 1) {
      const full = faceFull?.get(key);
      if (full) {
        const patch = tessellateFace(full, curved!.level);
        if (patch && emitPatch(patch, "poly", cellScalar ? cellScalar(faceOwner!.get(key)) : 0, faceOwner?.get(key) ?? -1)) continue;
      }
      const lis = ids.map(localOf) as number[];
      polys.push(lis.length, ...lis);
      polyScalars?.push(cellScalar!(faceOwner!.get(key)));
      polyEntities?.push(faceOwner?.get(key) ?? -1);
    }
  }

  if (polys.length === 0 && lines.length === 0 && verts.length === 0) return null;

  const geometry: DisplayGeometry = { points: Float32Array.from(localPoints) };
  if (polys.length) geometry.polys = Uint32Array.from(polys);
  if (lines.length) geometry.lines = Uint32Array.from(lines);
  if (verts.length) geometry.verts = Uint32Array.from(verts);

  if (localScalars && attach) {
    geometry.pointScalars = { name: attach.name, values: Float32Array.from(localScalars) };
  } else if (vertScalars && attach) {
    // VTK enumerates polydata cells as verts, then lines, then polys.
    geometry.cellScalars = { name: attach.name, values: Float32Array.from([...vertScalars, ...lineScalars!, ...polyScalars!]) };
  }

  const built: BuiltDisplayGeometry = { geometry };
  if (wantPickMaps) {
    built.pointGlobalIds = Int32Array.from(localGlobalIds!);
    built.cellEntityIds = Int32Array.from([...vertEntities!, ...lineEntities!, ...polyEntities!]);
  }
  return built;
}
