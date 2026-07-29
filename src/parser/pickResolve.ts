// Pure resolver: turns a vtkCellPicker hit into a model entity id + nearest
// node id. No vtk/DOM here — the webview (main.ts) pulls plain numbers/arrays
// out of the picker/polydata and this module just does the lookup math, which
// keeps it Node-testable like the rest of src/parser/.

export interface PickMaps {
  /** Local point index (as used by the picked cell's point ids) → global node id. */
  pointGlobalIds: Int32Array;
  /** Local cell index (VTK verts→lines→polys order) → owning entity id, -1 = none. */
  cellEntityIds: Int32Array;
}

export interface ResolvedPick {
  /** The picked cell's owning entity id, or undefined when the cell carries none. */
  entityId: number | undefined;
  /** Global id of the picked cell's corner nearest the pick position, or undefined. */
  nodeId: number | undefined;
}

/**
 * The candidate (local point index) nearest `target`, by squared distance.
 * `coordsOf` returning undefined for a candidate skips it (never crashes on a
 * point outside the caller's coordinate table).
 */
export function nearestPointLocal(
  candidates: ArrayLike<number>,
  coordsOf: (localId: number) => [number, number, number] | undefined,
  target: [number, number, number]
): number | undefined {
  let best: number | undefined;
  let bestDist = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const localId = candidates[i];
    const c = coordsOf(localId);
    if (!c) continue;
    const dx = c[0] - target[0];
    const dy = c[1] - target[1];
    const dz = c[2] - target[2];
    const dist = dx * dx + dy * dy + dz * dz;
    if (dist < bestDist) {
      bestDist = dist;
      best = localId;
    }
  }
  return best;
}

/** The entity id owning `cellId`, or undefined for an out-of-range/entity-less cell. */
export function resolveEntity(maps: PickMaps, cellId: number): number | undefined {
  if (cellId < 0 || cellId >= maps.cellEntityIds.length) return undefined;
  const id = maps.cellEntityIds[cellId];
  return id >= 0 ? id : undefined;
}

/** Global node id of a local point index, or undefined when out of range. */
export function resolveNode(maps: PickMaps, localPointId: number): number | undefined {
  if (localPointId < 0 || localPointId >= maps.pointGlobalIds.length) return undefined;
  return maps.pointGlobalIds[localPointId];
}

/**
 * Full resolution of one pick: the cell's entity id, plus the global id of its
 * corner nearest the pick position (a stand-in for "which node did I click
 * near" — cell picking has no notion of a single point on its own).
 */
export function resolvePick(
  maps: PickMaps,
  cellId: number,
  cellPointLocalIds: ArrayLike<number>,
  coordsOf: (localId: number) => [number, number, number] | undefined,
  pickPosition: [number, number, number]
): ResolvedPick {
  const entityId = resolveEntity(maps, cellId);
  const nearestLocal = nearestPointLocal(cellPointLocalIds, coordsOf, pickPosition);
  const nodeId = nearestLocal !== undefined ? resolveNode(maps, nearestLocal) : undefined;
  return { entityId, nodeId };
}
