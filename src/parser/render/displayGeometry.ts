// Parsed MDPA entities -> backend-neutral display geometry (roadmap item 18).
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
}

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
      const a = localOf(corners[0]);
      const b = localOf(corners[1]);
      if (a !== undefined && b !== undefined) {
        lines.push(2, a, b);
        lineScalars?.push(cellScalar!(cell.entityId));
        lineEntities?.push(cell.entityId ?? -1);
      }
    } else if (t.category === "surface") {
      const lis = corners.map(localOf) as number[];
      polys.push(lis.length, ...lis);
      polyScalars?.push(cellScalar!(cell.entityId));
      polyEntities?.push(cell.entityId ?? -1);
    } else if (t.category === "volume" && t.faces) {
      for (const face of t.faces) {
        const ids = face.map((fi) => corners[fi]);
        const key = faceKey(ids);
        faceCount.set(key, (faceCount.get(key) ?? 0) + 1);
        if (!faceIds.has(key)) {
          faceIds.set(key, ids);
          faceOwner?.set(key, cell.entityId);
        }
      }
    }
  }

  for (const [key, ids] of faceIds) {
    if (faceCount.get(key) === 1) {
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
