/**
 * Region selection by geometry, data, connectivity or a grown patch, via
 * meshio++'s `selectRegion` (>= 18.0.0).
 *
 * Pure module (no vscode / DOM). An ORACLE: the kernel names which cells (or
 * points) of OUR mesh satisfy the criteria, and this module only translates its
 * global block-major cell indices back to entity ids through
 * `meshioCorrespondence`; meshio++'s returned mesh is never adopted.
 * `operations.ts` then turns the ids into a SubModelPart with the existing
 * `createSubModelPartFromSelection` path, so the node closure and the
 * parent/child subset rule are exactly the ones every other selection gets.
 *
 * What it adds over the extension's own seeds (`selectionCore.ts`): a plane or
 * sphere test, the k-th node-connected component, and a patch GROWN from a seed
 * point across facets whose dihedral angle stays under `featureAngle` (and,
 * optionally, within `normalTolerance` of the seed's normal) — the "select this
 * flat face of the CAD part" gesture.
 *
 * Measured on the live wasm: the region comes back appended to `mesh.regions`
 * under the requested name with `kind` as asked and `entries` as global cell
 * indices (block-major, ascending) or point indices; `numGrown` is -1 without a
 * seed and `numComponents` -1 without a component criterion. A `side` region
 * names (cell, local facet) pairs, which a SubModelPart cannot hold, so it is
 * refused by name rather than approximated.
 */

import type { EntityKind, MdpaDiagnostic, MdpaModel } from "./types";
import { prepareMeshioOp, meshioCorrespondence } from "./meshioAdapter";

export const SELECT_REGION_KINDS = ["cell", "point"] as const;
export const SELECT_REGION_MODES = ["all", "any", "centroid"] as const;
export type SelectRegionKind = (typeof SELECT_REGION_KINDS)[number];
export type SelectRegionMode = (typeof SELECT_REGION_MODES)[number];

export interface SelectRegionParams {
  /** Name of the SubModelPart that receives the selection (top level). */
  name: string;
  /** What the region groups: cells (default) or points. */
  kind?: SelectRegionKind;
  /** How a cell reduces its nodes for box, plane and sphere (default "all"). */
  mode?: SelectRegionMode;
  /** [xmin, ymin, zmin, xmax, ymax, zmax]. */
  box?: number[];
  /** [px, py, pz, nx, ny, nz]: inside is (p - point) . normal >= 0. */
  plane?: number[];
  /** [cx, cy, cz, r], the closed ball. */
  sphere?: number[];
  /** [array, op, value] on a nodal (points) or per-cell field. */
  where?: [string, string, number];
  /** [metric, op, value] on a mesh-quality metric; cells only. */
  quality?: [string, string, number];
  /** The k-th node-connected component, 0-based, largest first as `split` orders them. */
  component?: number;
  /** [x, y, z]: grow a patch from the facet nearest it. */
  seed?: number[];
  /** Largest dihedral angle, in degrees, the growth crosses (default 30). */
  featureAngle?: number;
  /** Largest angle, in degrees, to the seed's normal (default 0, off). */
  normalTolerance?: number;
}

export interface SelectRegionResult {
  /** Entity ids per kind (cell regions), or node ids (point regions). */
  kinds: Record<EntityKind, number[]>;
  nodes: number[];
  numCandidates: number;
  numSelected: number;
  numGrown: number;
  numComponents: number;
  /** Why nothing was selected / the request was refused. */
  message?: string;
}

const NONE: Record<EntityKind, number[]> = { Elements: [], Conditions: [], Geometries: [] };
const refuse = (message: string): SelectRegionResult => ({ kinds: { ...NONE }, nodes: [], numCandidates: 0, numSelected: 0, numGrown: -1, numComponents: -1, message });

/** The criteria a request names, in the kernel's own spelling; an empty object means none were given. */
export function selectRegionOptions(p: SelectRegionParams): Record<string, unknown> {
  const o: Record<string, unknown> = { kind: p.kind ?? "cell" };
  for (const k of ["mode", "box", "plane", "sphere", "where", "quality", "component", "seed", "featureAngle", "normalTolerance"] as const) {
    if (p[k] !== undefined && p[k] !== null) o[k] = p[k];
  }
  return o;
}

/** True when at least one selecting criterion is present (the kernel requires one). */
export function hasSelectRegionCriterion(p: SelectRegionParams): boolean {
  return ["box", "plane", "sphere", "where", "quality", "component", "seed"].some((k) => (p as unknown as Record<string, unknown>)[k] !== undefined);
}

export async function selectRegionModel(model: MdpaModel, params: SelectRegionParams, diagnostics: MdpaDiagnostic[] = []): Promise<SelectRegionResult> {
  if (!params.name || !params.name.trim()) return refuse("A selection needs a name for the SubModelPart that will hold it.");
  if (params.kind && !(SELECT_REGION_KINDS as readonly string[]).includes(params.kind)) {
    return refuse(`kind "${params.kind}" is not supported: a SubModelPart holds cells or points, not (cell, facet) pairs. Use "cell" or "point".`);
  }
  if (!hasSelectRegionCriterion(params)) return refuse("Give at least one criterion: box, plane, sphere, where, quality, component or seed.");
  const prepared = await prepareMeshioOp(model, diagnostics, { dim: 3 });
  if (!prepared) return refuse("The mesh has no cells to select from.");
  const { m, mesh } = prepared;

  const name = "kratos_select_region";
  const r = m.selectRegion(mesh, name, selectRegionOptions(params));
  const region = (r.mesh.regions ?? []).find((x) => x.name === name);
  const entries = region ? Array.from(region.entries as ArrayLike<number | bigint>, Number) : [];
  const base = { numCandidates: r.numCandidates, numSelected: r.numSelected, numGrown: r.numGrown, numComponents: r.numComponents };
  if (entries.length === 0) return { kinds: { ...NONE }, nodes: [], ...base, message: "No cell or point satisfied the criteria." };

  if ((params.kind ?? "cell") === "point") {
    const ids = entries.filter((i) => i >= 0 && i < model.nodeIds.length).map((i) => model.nodeIds[i]);
    return { kinds: { ...NONE }, nodes: ids.sort((a, b) => a - b), ...base };
  }

  const { blocks, cellCount } = meshioCorrespondence(model, mesh, "selectRegion");
  const kinds: Record<EntityKind, number[]> = { Elements: [], Conditions: [], Geometries: [] };
  const starts: number[] = [];
  let at = 0;
  for (const b of blocks) { starts.push(at); at += b.count; }
  let bi = 0;
  for (const e of entries) {
    if (e < 0 || e >= cellCount) throw new Error(`selectRegion returned cell ${e} for a mesh of ${cellCount} cell(s); the result was discarded.`);
    while (bi + 1 < blocks.length && e >= starts[bi + 1]) bi++;
    while (bi > 0 && e < starts[bi]) bi--;
    kinds[blocks[bi].kind].push(blocks[bi].entityIds[e - starts[bi]]);
  }
  for (const k of Object.keys(kinds) as EntityKind[]) kinds[k].sort((a, b) => a - b);
  return { kinds, nodes: [], ...base };
}

/** One sentence for the outcome / MCP reply. */
export function describeSelectRegion(name: string, r: SelectRegionResult): string {
  const n = r.kinds.Elements.length + r.kinds.Conditions.length + r.kinds.Geometries.length + r.nodes.length;
  const counts = [
    r.kinds.Elements.length ? `${r.kinds.Elements.length} element(s)` : "",
    r.kinds.Conditions.length ? `${r.kinds.Conditions.length} condition(s)` : "",
    r.kinds.Geometries.length ? `${r.kinds.Geometries.length} geometry(ies)` : "",
    r.nodes.length ? `${r.nodes.length} node(s)` : "",
  ].filter(Boolean).join(", ");
  const extra = [
    r.numGrown >= 0 ? `the grown patch has ${r.numGrown} facet(s)` : "",
    r.numComponents >= 0 ? `the mesh has ${r.numComponents} connected component(s)` : "",
  ].filter(Boolean).join("; ");
  return `Selected ${n} of ${r.numCandidates} candidate(s) (${counts}) into "${name}"${extra ? `; ${extra}` : ""}.`;
}
