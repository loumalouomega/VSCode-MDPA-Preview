/**
 * Revolved (axisymmetric) field integrals for planar xy meshes.
 *
 * An axisymmetric result is stored on the r-z half plane; the physical
 * integral revolves each cell by 2*pi*r. This module does that weighting
 * natively and exactly for piecewise-constant cell fields: a surface cell
 * weighs 2*pi * integral(r dA) (sum over its triangle decomposition of
 * area * mean corner r), a line cell 2*pi * L * mean(r) (the area of the
 * surface of revolution). The axis is NEVER inferred: the caller names it
 * ("x": r = y; "y": r = x), a mesh with z != 0 (3D) or a node on the wrong
 * side of the axis is refused by name. Pure; no wasm.
 */

import { EntityKind, FieldData, MdpaModel, SubModelPart } from "./types";
import { decompositionFor } from "./cellDecomposition";
import { cellCategory } from "./writers/writerCommon";
import { collectIds, IdSets } from "./subModelPartExtract";
import type { FieldIntegral, IntegralTotals } from "./fieldIntegrate";

export type RevolveAxis = "x" | "y";

/** Validates the caller's axis spelling; refuses anything else by name. */
export function parseRevolveAxis(v: unknown): RevolveAxis {
  if (v === "x" || v === "y") return v;
  throw new Error(
    `revolveAbout must be "x" or "y" (the axis of revolution of a planar xy mesh), got ${JSON.stringify(v)}. ` +
      `Other axes are not supported; the axis is never inferred.`
  );
}

const KIND_OF_FIELD: Record<string, EntityKind> = { Elemental: "Elements", Conditional: "Conditions" };

export async function integrateRevolved(
  model: MdpaModel,
  variables: string[],
  axisIn: unknown
): Promise<FieldIntegral[]> {
  const axis = parseRevolveAxis(axisIn);
  // Axis "y": r = x (coordinate 0); axis "x": r = y (coordinate 1).
  const rOff = axis === "y" ? 0 : 1;
  let maxAbs = 1;
  for (let i = 0; i < model.coords.length; i++) maxAbs = Math.max(maxAbs, Math.abs(model.coords[i]));
  const tol = 1e-9 * maxAbs;
  for (let i = 0; i < model.nodeCount; i++) {
    if (Math.abs(model.coords[i * 3 + 2]) > tol) {
      throw new Error("revolveAbout needs a planar xy mesh (all z = 0); this mesh is 3D, so a revolved integral is not defined.");
    }
    if (model.coords[i * 3 + rOff] < -tol) {
      throw new Error(
        `revolveAbout "${axis}": node ${model.nodeIds[i]} has ${axis === "y" ? "x" : "y"} < 0, i.e. the mesh crosses the axis of revolution.`
      );
    }
  }
  for (const b of model.blocks) {
    if (cellCategory(b.vtkCellType) === "volume") {
      throw new Error("revolveAbout needs a planar xy mesh; this mesh has volume cells, so a revolved integral is not defined.");
    }
  }

  const wanted = variables.map((v) => v.trim()).filter((v) => v.length > 0);
  for (const v of wanted) {
    const f = model.fields.find((x) => x.variable === v);
    if (f && f.kind === "Nodal") {
      throw new Error(
        `"${v}" is a Nodal field. Integration is cell-measure weighted, so move it to the cells first with the Average field operation (nodalToElemental), then integrate.`
      );
    }
  }
  const fields: FieldData[] = model.fields.filter(
    (f) => KIND_OF_FIELD[f.kind] && (wanted.length === 0 || wanted.includes(f.variable))
  );

  const idx = new Map<number, number>();
  for (let i = 0; i < model.nodeCount; i++) idx.set(model.nodeIds[i], i);
  const pt = (id: number): number[] => {
    const i = idx.get(id)!;
    return [model.coords[i * 3], model.coords[i * 3 + 1], model.coords[i * 3 + 2]];
  };

  // Per kind: entity id -> revolved weight, only for the kind's top dimension.
  const weights: Record<EntityKind, Map<number, number>> = {
    Elements: new Map(),
    Conditions: new Map(),
    Geometries: new Map(),
  };
  for (const kind of ["Elements", "Conditions"] as EntityKind[]) {
    let top = 0;
    for (const b of model.blocks) {
      if (b.kind !== kind) continue;
      const cat = cellCategory(b.vtkCellType);
      top = Math.max(top, cat === "surface" ? 2 : cat === "line" ? 1 : 0);
    }
    for (const b of model.blocks) {
      if (b.kind !== kind) continue;
      const cat = cellCategory(b.vtkCellType);
      const d = cat === "surface" ? 2 : cat === "line" ? 1 : 0;
      if (d === 0 || d !== top) continue;
      const dec = decompositionFor(b.vtkCellType);
      const corners = dec.corners || b.stride;
      for (let c = 0; c < b.count; c++) {
        const ids: number[] = [];
        let ok = true;
        for (let k = 0; k < corners && ok; k++) {
          const id = b.connectivity[c * b.stride + k];
          if (!idx.has(id)) ok = false;
          ids.push(id);
        }
        if (!ok) continue;
        let w = 0;
        if (d === 2 && dec.tris) {
          for (const t of dec.tris) {
            const a = pt(ids[t[0]]);
            const bb = pt(ids[t[1]]);
            const cc = pt(ids[t[2]]);
            const area = 0.5 * Math.abs((bb[0] - a[0]) * (cc[1] - a[1]) - (cc[0] - a[0]) * (bb[1] - a[1]));
            w += (area * (a[rOff] + bb[rOff] + cc[rOff])) / 3;
          }
        } else if (d === 1) {
          const a = pt(ids[0]);
          const e = pt(ids[1]);
          w = (Math.hypot(e[0] - a[0], e[1] - a[1]) * (a[rOff] + e[rOff])) / 2;
        } else continue;
        weights[kind].set(b.entityIds[c], 2 * Math.PI * w);
      }
    }
  }

  const regionsFor = (kind: EntityKind): { name: string; ids: Set<number> }[] => {
    const out: { name: string; ids: Set<number> }[] = [];
    const byBlock = new Map<string, Set<number>>();
    for (const b of model.blocks) {
      if (b.kind !== kind) continue;
      let s = byBlock.get(b.name);
      if (!s) byBlock.set(b.name, (s = new Set()));
      for (const id of b.entityIds) s.add(id);
    }
    for (const [name, ids] of byBlock) out.push({ name, ids });
    const walk = (parts: SubModelPart[]): void => {
      for (const p of parts) {
        const sets: IdSets = { elements: new Set(), conditions: new Set(), geometries: new Set(), nodes: new Set() };
        collectIds(p, sets);
        out.push({ name: p.path, ids: kind === "Elements" ? sets.elements : sets.conditions });
        walk(p.children);
      }
    };
    walk(model.subModelParts);
    return out;
  };

  const result: FieldIntegral[] = [];
  for (const f of fields) {
    const kind = KIND_OF_FIELD[f.kind];
    const wmap = weights[kind];
    const comps = f.components;
    const rowOf = new Map<number, number>();
    for (let i = 0; i < f.ids.length; i++) rowOf.set(f.ids[i], i);
    const accumulate = (ids: Iterable<number>): IntegralTotals => {
      const total = new Array<number>(comps).fill(0);
      const measure = new Array<number>(comps).fill(0);
      let numCells = 0;
      let numSkipped = 0;
      for (const id of ids) {
        const w = wmap.get(id);
        if (w === undefined) continue;
        numCells++;
        const row = rowOf.get(id);
        if (row === undefined) {
          numSkipped++;
          continue;
        }
        for (let k = 0; k < comps; k++) {
          const v = f.values[row * comps + k];
          if (!Number.isFinite(v) || !Number.isFinite(w)) continue;
          total[k] += v * w;
          measure[k] += w;
        }
      }
      return { numCells, numSkipped, total, mean: total.map((t, k) => (measure[k] > 0 ? t / measure[k] : NaN)), measure };
    };
    const domain = accumulate(wmap.keys());
    const regions = regionsFor(kind)
      .map((r) => ({ ...accumulate(r.ids), name: r.name }))
      .filter((r) => r.numCells > 0);
    result.push({ variable: f.variable, components: comps, domain, regions, revolvedAbout: axis });
  }
  return result;
}
