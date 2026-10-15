/**
 * Coupling interfaces checked against the mesh (roadmap item 16): before a
 * coupled case is written, each declared interface pair (a fluid-side and a
 * structure-side `noProcess` condition) must pair up one-to-one, every side
 * must carry boundary cells of the right dimension (lines in 2D, faces in 3D —
 * a mapper needs geometry, not bare nodes), and the two sides of a pair must
 * overlap in space. Pairs are matched by assignment order, the convention the
 * FSI `mapper_settings` and the CoSimulation data entries both use.
 *
 * Pure (no fs), so Generate, preflight and MCP refuse with the same words.
 * A side whose SubModelPart is not in the mesh is skipped here: preflight
 * reports it as `smp-missing`, and saying it twice helps nobody. A side with
 * no assignment at all is the domain's `required` rule, not this check.
 */

import type { MdpaModel, SubModelPart } from "../parser/types";
import { buildCellLayout, cellCategory, nodeIndexMap, type CellLayout } from "../parser/writers/writerCommon";
import type { Assignment, CouplingInterfaceSpec, ProblemtypeDeclaration } from "./types";

interface SideGeometry {
  /** Cell categories present in the part's subtree. */
  categories: Set<string>;
  min: [number, number, number];
  max: [number, number, number];
  nodeCount: number;
}

function findPart(parts: SubModelPart[], path: string): SubModelPart | undefined {
  for (const p of parts) {
    if (p.path === path) return p;
    const hit = findPart(p.children, path);
    if (hit) return hit;
  }
  return undefined;
}

function sideGeometry(model: MdpaModel, layout: CellLayout, index: Map<number, number>, part: SubModelPart): SideGeometry {
  const categories = new Set<string>();
  const nodes = new Set<number>();
  const visit = (p: SubModelPart): void => {
    const take = (ids: Int32Array, map: Map<number, number>): void => {
      for (const id of ids) {
        const c = map.get(id);
        if (c === undefined) continue;
        const cell = layout.cells[c];
        categories.add(cellCategory(cell.type));
        for (const n of cell.nodes) nodes.add(n);
      }
    };
    take(p.elementIds, layout.elementIdToCell);
    take(p.conditionIds, layout.conditionIdToCell);
    take(p.geometryIds, layout.geometryIdToCell);
    for (const id of p.nodeIds) {
      const n = index.get(id);
      if (n !== undefined) nodes.add(n);
    }
    p.children.forEach(visit);
  };
  visit(part);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const n of nodes) {
    for (let k = 0; k < 3; k++) {
      const v = model.coords[3 * n + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { categories, min, max, nodeCount: nodes.size };
}

function overlaps(a: SideGeometry, b: SideGeometry, tol: number): boolean {
  if (a.nodeCount === 0 || b.nodeCount === 0) return false;
  for (let k = 0; k < 3; k++) {
    if (a.min[k] > b.max[k] + tol || b.min[k] > a.max[k] + tol) return false;
  }
  return true;
}

const EXPECTED: Record<2 | 3, { category: string; noun: string }> = {
  2: { category: "line", noun: "line conditions or elements" },
  3: { category: "surface", noun: "surface (face) conditions or elements" },
};

/** The assignments of one interface side, in assignment order. */
export function interfaceSidePaths(assignments: Assignment[], conditionId: string): string[] {
  return assignments.filter((a) => a.conditionId === conditionId).map((a) => a.smpPath);
}

/** The pairs of one declared interface, by assignment order; unpaired tails are dropped. */
export function interfacePairs(spec: CouplingInterfaceSpec, assignments: Assignment[]): [string, string][] {
  const a = interfaceSidePaths(assignments, spec.sides[0]);
  const b = interfaceSidePaths(assignments, spec.sides[1]);
  return a.slice(0, Math.min(a.length, b.length)).map((p, i) => [p, b[i]]);
}

/** Problems with the declared coupling interfaces, as messages naming the SubModelPart. */
export function interfacePairProblems(
  decl: ProblemtypeDeclaration,
  model: MdpaModel,
  assignments: Assignment[],
  domainSize: 2 | 3
): string[] {
  const specs = decl.couplingInterfaces ?? [];
  if (specs.length === 0) return [];
  const out: string[] = [];
  const label = (conditionId: string): string => decl.conditions.find((c) => c.id === conditionId)?.label ?? conditionId;
  let layout: CellLayout | undefined;
  let index: Map<number, number> | undefined;
  const geometry = new Map<string, SideGeometry | null>();
  const geometryOf = (path: string): SideGeometry | undefined => {
    if (!geometry.has(path)) {
      const part = findPart(model.subModelParts, path);
      layout ??= buildCellLayout(model, []);
      index ??= nodeIndexMap(model);
      geometry.set(path, part ? sideGeometry(model, layout, index, part) : null);
    }
    return geometry.get(path) ?? undefined;
  };
  const diagonal = Math.hypot(
    model.bounds.max[0] - model.bounds.min[0],
    model.bounds.max[1] - model.bounds.min[1],
    model.bounds.max[2] - model.bounds.min[2]
  );
  const tol = Math.max(diagonal * 1e-6, 1e-12);
  const expected = EXPECTED[domainSize];

  for (const spec of specs) {
    const a = interfaceSidePaths(assignments, spec.sides[0]);
    const b = interfaceSidePaths(assignments, spec.sides[1]);
    if (a.length === 0 || b.length === 0) continue; // the domains' required rules say this
    if (a.length !== b.length) {
      out.push(
        `${spec.label}: ${a.length} SubModelPart${a.length === 1 ? "" : "s"} assigned as "${label(spec.sides[0])}" but ${b.length} as "${label(spec.sides[1])}". ` +
          `Assign them in pairs; the n-th of one side is coupled with the n-th of the other.`
      );
    }
    for (const [side, paths] of [[spec.sides[0], a], [spec.sides[1], b]] as const) {
      for (const path of paths) {
        const g = geometryOf(path);
        if (!g) continue; // not in the mesh: preflight's smp-missing
        if (!g.categories.has(expected.category)) {
          const found = [...g.categories].filter((c) => c !== "point");
          out.push(
            `"${path}" (${label(side)}) has no ${expected.noun}${found.length ? ` (it holds ${found.join(" and ")} cells)` : g.nodeCount ? " — only nodes" : ""}; ` +
              `a ${domainSize}D coupling interface needs them for the mapper.`
          );
        }
      }
    }
    for (const [pa, pb] of interfacePairs(spec, assignments)) {
      const ga = geometryOf(pa);
      const gb = geometryOf(pb);
      if (!ga || !gb || !ga.categories.has(expected.category) || !gb.categories.has(expected.category)) continue;
      if (!overlaps(ga, gb, tol)) {
        out.push(`${spec.label}: "${pa}" and "${pb}" do not overlap in space, so there is nothing to map between them. Check the pairing order.`);
      }
    }
  }
  return out;
}

/** Problems with a declaration's `couplingInterfaces`, for `validateDeclaration`. */
export function couplingInterfaceDeclarationProblems(decl: ProblemtypeDeclaration): string[] {
  const specs = decl.couplingInterfaces;
  if (specs === undefined) return [];
  if (!Array.isArray(specs)) return ["couplingInterfaces must be a list"];
  const out: string[] = [];
  const conditionIds = new Set(decl.conditions.map((c) => c.id));
  const owner = (id: string): string | undefined => decl.domains?.find((d) => d.conditionIds.includes(id))?.id;
  specs.forEach((s, i) => {
    if (typeof s?.label !== "string" || !Array.isArray(s.sides) || s.sides.length !== 2) {
      out.push(`couplingInterfaces[${i}]: expected {label, sides: [conditionId, conditionId]}`);
      return;
    }
    for (const id of s.sides) if (!conditionIds.has(id)) out.push(`couplingInterfaces[${i}]: unknown condition "${id}"`);
    if (decl.domains && owner(s.sides[0]) !== undefined && owner(s.sides[0]) === owner(s.sides[1])) {
      out.push(`couplingInterfaces[${i}]: both sides belong to domain "${owner(s.sides[0])}"`);
    }
  });
  return out;
}
