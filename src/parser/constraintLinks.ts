/**
 * Slave-to-master links of the multi-point constraints, as plain line geometry
 * for the preview overlay (former roadmap item 23). Pure and bundled by the
 * webview. One segment per (slave, master) pair of every linear constraint, in
 * the VTK legacy `[2, a, b]` line layout over a local point table; a node a
 * constraint names that the mesh lacks drops that segment, never the whole row.
 */
import type { ConstraintBlock } from "./constraintsParser";
import type { MdpaModel } from "./types";

export interface ConstraintLinks {
  /** Interleaved xyz of the distinct nodes the links touch. */
  points: Float32Array;
  /** Legacy line cells `[2, i, j, 2, i, j, …]` into `points`. */
  lines: Uint32Array;
  /** Constraint id per segment, so a pick or a table can map back. */
  constraintIds: Int32Array;
  segments: number;
  /** Segments dropped because a node is not in the mesh. */
  missing: number;
}

/** Variables present, for a caller that wants to offer a filter. */
export function constraintVariables(blocks?: readonly ConstraintBlock[]): string[] {
  const out = new Set<string>();
  for (const b of blocks ?? []) for (const v of b.variables) out.add(v);
  return [...out];
}

export function buildConstraintLinks(model: MdpaModel, opts: { variable?: string; limit?: number } = {}): ConstraintLinks {
  const index = new Map<number, number>();
  for (let i = 0; i < model.nodeCount; i++) index.set(model.nodeIds[i], i);
  const limit = opts.limit ?? 500_000;
  const local = new Map<number, number>();
  const pts: number[] = [];
  const lines: number[] = [];
  const ids: number[] = [];
  let missing = 0;
  const at = (node: number): number | undefined => {
    const hit = local.get(node);
    if (hit !== undefined) return hit;
    const i = index.get(node);
    if (i === undefined) return undefined;
    const n = pts.length / 3;
    pts.push(model.coords[i * 3], model.coords[i * 3 + 1], model.coords[i * 3 + 2]);
    local.set(node, n);
    return n;
  };
  outer: for (const b of model.constraints ?? []) {
    if (opts.variable && !b.variables.includes(opts.variable)) continue;
    for (const r of b.rows) {
      if (r.kind !== "linear") continue;
      for (const s of r.slaveIds) {
        for (const m of r.masterIds) {
          if (ids.length >= limit) break outer;
          const a = at(s);
          const c = at(m);
          if (a === undefined || c === undefined) {
            missing++;
            continue;
          }
          lines.push(2, a, c);
          ids.push(r.id);
        }
      }
    }
  }
  return { points: Float32Array.from(pts), lines: Uint32Array.from(lines), constraintIds: Int32Array.from(ids), segments: ids.length, missing };
}
