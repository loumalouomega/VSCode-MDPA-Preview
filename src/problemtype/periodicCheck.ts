/**
 * Periodic pairs checked against the mesh (roadmap item 21): before a case with a
 * periodic boundary is written, translating the master part by the declared
 * direction × magnitude must land every slave node on a master node.
 *
 * Why this is checked rather than trusted: both periodic processes take the
 * translation FROM THE MASTER TO THE SLAVE (`master + t = slave`), and a pair that
 * does not match is not an error in either solver. The core Fluid process creates
 * zero constraints and the run proceeds, unperiodic, to a normal-looking finish —
 * found by running a channel and reading the result back, where the "paired" nodes
 * differed. A wrong sign is the likely mistake, so a pair that matches when the
 * translation is reversed says so.
 *
 * Pure (no fs); Generate, preflight and MCP refuse with the same words. A part
 * that is not in the mesh or has no nodes is skipped: preflight reports it, and
 * saying it twice helps nobody.
 */

import type { MdpaModel, SubModelPart } from "../parser/types";
import { buildCellLayout, nodeIndexMap, type CellLayout } from "../parser/writers/writerCommon";
import type { Assignment } from "./types";

/** The condition id the Fluid-derived problemtypes use for a periodic boundary. */
export const PERIODIC_CONDITION_ID = "periodic";

function findPart(parts: SubModelPart[], path: string): SubModelPart | undefined {
  for (const p of parts) {
    if (p.path === path) return p;
    const hit = findPart(p.children, path);
    if (hit) return hit;
  }
  return undefined;
}

/** Node indices of a part's subtree: its own node list plus the corners of its entities. */
function nodesOf(layout: CellLayout, index: Map<number, number>, part: SubModelPart): Set<number> {
  const nodes = new Set<number>();
  const visit = (p: SubModelPart): void => {
    for (const [ids, map] of [
      [p.elementIds, layout.elementIdToCell],
      [p.conditionIds, layout.conditionIdToCell],
      [p.geometryIds, layout.geometryIdToCell],
    ] as const) {
      for (const id of ids) {
        const c = map.get(id);
        if (c !== undefined) for (const n of layout.cells[c].nodes) nodes.add(n);
      }
    }
    for (const id of p.nodeIds) {
      const n = index.get(id);
      if (n !== undefined) nodes.add(n);
    }
    p.children.forEach(visit);
  };
  visit(part);
  return nodes;
}

const vec3 = (v: unknown): [number, number, number] | undefined =>
  Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x)) ? [v[0], v[1], v[2]] : undefined;

/** How many of `slave` have a node of `master` at `slave - shift` (master + shift = slave). */
function matched(model: MdpaModel, slave: Set<number>, master: Set<number>, shift: [number, number, number], h: number): number {
  const cell = (x: number, y: number, z: number): string => `${Math.round(x / h)}|${Math.round(y / h)}|${Math.round(z / h)}`;
  const c = model.coords;
  const grid = new Set<string>();
  for (const m of master) grid.add(cell(c[3 * m] + shift[0], c[3 * m + 1] + shift[1], c[3 * m + 2] + shift[2]));
  let hits = 0;
  for (const s of slave) {
    const x = c[3 * s];
    const y = c[3 * s + 1];
    const z = c[3 * s + 2];
    let found = grid.has(cell(x, y, z));
    // A point on the edge of a quantization cell may round the other way: look one cell around before giving up.
    for (let dx = -1; dx <= 1 && !found; dx++) {
      for (let dy = -1; dy <= 1 && !found; dy++) {
        for (let dz = -1; dz <= 1 && !found; dz++) {
          if (dx !== 0 || dy !== 0 || dz !== 0) found = grid.has(cell(x + dx * h, y + dy * h, z + dz * h));
        }
      }
    }
    if (found) hits++;
  }
  return hits;
}

/** Problems with the periodic pairs, as messages naming the SubModelPart. */
export function periodicPairProblems(model: MdpaModel, assignments: Assignment[]): string[] {
  const periodic = assignments.filter((a) => a.conditionId === PERIODIC_CONDITION_ID);
  if (periodic.length === 0) return [];
  const out: string[] = [];
  const layout = buildCellLayout(model, []);
  const index = nodeIndexMap(model);
  const extent = Math.max(
    model.bounds.max[0] - model.bounds.min[0],
    model.bounds.max[1] - model.bounds.min[1],
    model.bounds.max[2] - model.bounds.min[2],
    Math.abs(model.bounds.min[0]), Math.abs(model.bounds.min[1]), Math.abs(model.bounds.min[2]),
    Math.abs(model.bounds.max[0]), Math.abs(model.bounds.max[1]), Math.abs(model.bounds.max[2])
  );
  // Coordinates are stored in single precision, so the match tolerance follows the model's scale.
  const h = Math.max(extent * 1e-5, 1e-9);
  for (const a of periodic) {
    const masterPath = typeof a.values.master === "string" ? a.values.master : "";
    if (masterPath === "" || masterPath === a.smpPath) continue; // the problemtype's own rules name these
    const slavePart = findPart(model.subModelParts, a.smpPath);
    const masterPart = findPart(model.subModelParts, masterPath);
    if (!slavePart || !masterPart) continue;
    const slave = nodesOf(layout, index, slavePart);
    const master = nodesOf(layout, index, masterPart);
    if (slave.size === 0 || master.size === 0) continue;
    const direction = vec3(a.values.translation) ?? [1, 0, 0];
    const norm = Math.hypot(...direction);
    if (!(norm > 0)) {
      out.push(`The periodic boundary "${a.smpPath}" has a zero translation direction.`);
      continue;
    }
    const magnitude = typeof a.values.magnitude === "number" && Number.isFinite(a.values.magnitude) ? a.values.magnitude : 1;
    const shift = direction.map((v) => (v / norm) * magnitude) as [number, number, number];
    const here = matched(model, slave, master, shift, h);
    if (here === slave.size && master.size === slave.size) continue;
    const label = `The periodic boundary "${a.smpPath}" (master "${masterPath}", translation [${shift.map((v) => +v.toPrecision(6)).join(", ")}], from the master to the slave)`;
    if (here === slave.size) {
      out.push(`${label}: its ${slave.size} node(s) are matched, but the master has ${master.size}; the pairing must be one node to one node.`);
      continue;
    }
    const reversed = matched(model, slave, master, shift.map((v) => -v) as [number, number, number], h);
    out.push(
      `${label}: ${slave.size - here} of ${slave.size} slave node(s) have no master node at that distance, and the solver would silently apply no pairing.` +
        (reversed === slave.size ? " They all match when the direction is reversed: the translation runs from the master to the slave." : "")
    );
  }
  return out;
}

/** Condition ids of a part's subtree. */
function conditionIdsOf(part: SubModelPart, into: Set<number>): void {
  for (const id of part.conditionIds) into.add(id);
  part.children.forEach((c) => conditionIdsOf(c, into));
}

/**
 * The RANS periodic path numbers its conditions itself, and a mesh whose condition ids are in the way stops the run
 * with a cryptic "a condition with the same Id already exists" (found by running a periodic channel).
 *
 * The exact nodal process adds one root condition per slave node (m of them) after the largest id, and the
 * formulation then creates m more in the computing part numbered from that part's own condition count: k + 1 .. k + m,
 * k being the conditions of the skin parts. Those new ids must not be used by the mesh (a part's facets in that range
 * collide) and must not reach the process's (the largest id has to be at least k + m).
 *
 * `skinPaths` are the SubModelParts the solver lists as skin; the caller knows them, this module does not.
 */
export function ransPeriodicIdProblems(model: MdpaModel, assignments: Assignment[], skinPaths: string[]): string[] {
  const periodic = assignments.filter((a) => a.conditionId === PERIODIC_CONDITION_ID);
  if (periodic.length === 0) return [];
  const layout = buildCellLayout(model, []);
  const index = nodeIndexMap(model);
  const slaves = new Set<number>();
  for (const a of periodic) {
    const part = findPart(model.subModelParts, a.smpPath);
    if (part) for (const n of nodesOf(layout, index, part)) slaves.add(n);
  }
  const m = slaves.size;
  if (m === 0) return [];
  const skin = new Set<number>();
  for (const path of skinPaths) {
    const part = findPart(model.subModelParts, path);
    if (part) conditionIdsOf(part, skin);
  }
  const k = skin.size;
  let largest = 0;
  const used = new Set<number>();
  for (const id of layout.conditionIdToCell.keys()) {
    used.add(id);
    if (id > largest) largest = id;
  }
  const clash: number[] = [];
  for (let id = k + 1; id <= k + m && clash.length < 6; id++) if (used.has(id)) clash.push(id);
  const reaches = k + m > largest;
  if (clash.length === 0 && !reaches) return [];
  return [
    `RANS numbers the ${m} periodic condition(s) it creates ${k + 1}–${k + m} (one per slave node, after the ${k} condition(s) of the skin parts), ` +
      (clash.length > 0 ? `and the mesh already has condition id(s) ${clash.join(", ")}${clash.length === 6 ? "…" : ""} there` : `and the mesh's largest condition id is only ${largest}, so the process's own conditions get the same ids`) +
      `: the run would stop with "a condition with the same Id already exists". Number the mesh's conditions so none uses ${k + 1}–${k + m} and the largest is at least ${k + m} ` +
      `(for example the skin conditions first, 1–${k}, and the other conditions from ${k + m + 1}).`,
  ];
}
