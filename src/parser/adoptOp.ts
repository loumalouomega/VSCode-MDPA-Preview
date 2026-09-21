/**
 * The shared preamble/postamble for an operation that ADOPTS meshio++'s result
 * as the new mesh (roadmap Tier 2: repair, decimation, surface/volume
 * remeshing, ...), the counterpart of `meshioAdapter.ts`'s oracle helpers.
 *
 * Carry -> run -> adopt -> tidy:
 *  1. convert with carriers on (`mdpa:id`, `kratos:kind`, property ids, and the
 *     `kratos:smp/` regions), so ids, kinds, Properties and SubModelParts can
 *     be recovered from the result;
 *  2. run the caller's wasm call;
 *  3. let the caller patch the result's carriers (e.g. give cells the operation
 *     created a kind, which upstream fills with 0 = Elements);
 *  4. `adoptMeshioMesh`, optionally recovering block names from the per-block
 *     `Cell` regions;
 *  5. tidy: drop upstream's provenance arrays (their names carry a colon, which
 *     `mdpaWriter` would emit verbatim as an illegal Kratos variable), drop
 *     non-finite rows so a gap stays a gap instead of becoming 0, and — for an
 *     operation whose result has no cell/point correspondence with its input —
 *     spatially remap the base's fields onto the new mesh.
 *
 * Pure module (no vscode / DOM): Node-testable with the real wasm.
 */

import { MdpaDiagnostic, FieldData, MdpaModel } from "./types";
import { modelToMeshio, MeshioMesh } from "./meshioConvert";
import { loadMeshio, MeshioModule } from "./meshio";
import { adoptMeshioMesh, FidelityReport } from "./meshioFidelity";
import { remapFieldsOntoRemesh, RemapFieldsResult } from "./remeshFields";

export interface AdoptingOpOptions<R extends { mesh: MeshioMesh }> {
  dim?: 2 | 3;
  /** Recover each block's display name from the result's per-block `Cell` regions. */
  recoverBlockNames?: boolean;
  /** Adjust the wasm result's carriers before it is adopted. */
  patchResult?: (result: R, base: MdpaModel) => void;
  /**
   * For an op whose result shares no cell/point correspondence with its input
   * (it drops point_data/cell_data/regions upstream): carry the base's fields
   * across by containing-cell lookup once the mesh is adopted.
   */
  remapFields?: boolean;
}

export interface AdoptingOpResult<R> {
  model: MdpaModel;
  report: FidelityReport;
  /** The raw wasm result, for the op's own statistics. */
  result: R;
  /** Present only when `remapFields` ran. */
  remap?: RemapFieldsResult;
  /** Names of upstream provenance arrays that were dropped rather than kept as fields. */
  provenanceDropped: string[];
  /** Fields that lost rows because their value was not finite (a gap, never 0). */
  sparsened: { name: string; rows: number }[];
}

/** A field with every non-finite ROW removed; `undefined` when nothing changed. */
function dropNonFiniteRows(f: FieldData): { field: FieldData; rows: number } | undefined {
  const c = Math.max(1, f.components);
  const keep: number[] = [];
  for (let i = 0; i < f.ids.length; i++) {
    let ok = true;
    for (let k = 0; k < c; k++) if (!Number.isFinite(f.values[i * c + k])) ok = false;
    if (ok) keep.push(i);
  }
  if (keep.length === f.ids.length) return undefined;
  const ids = new Int32Array(keep.length);
  const values = new Float64Array(keep.length * c);
  const fixed = f.fixed ? new Uint8Array(keep.length) : undefined;
  keep.forEach((src, dst) => {
    ids[dst] = f.ids[src];
    for (let k = 0; k < c; k++) values[dst * c + k] = f.values[src * c + k];
    if (fixed && f.fixed) fixed[dst] = f.fixed[src];
  });
  return { field: { ...f, ids, values, fixed }, rows: f.ids.length - keep.length };
}

/** Upstream's namespaced provenance/bookkeeping arrays (`repair:hole`, `decimate:...`) are not user fields. */
export function isProvenanceName(name: string): boolean {
  return name.includes(":");
}

export function tidyAdoptedFields(model: MdpaModel): {
  model: MdpaModel;
  provenanceDropped: string[];
  sparsened: { name: string; rows: number }[];
} {
  const provenanceDropped: string[] = [];
  const sparsened: { name: string; rows: number }[] = [];
  const fields: FieldData[] = [];
  for (const f of model.fields) {
    if (isProvenanceName(f.variable)) {
      if (!provenanceDropped.includes(f.variable)) provenanceDropped.push(f.variable);
      continue;
    }
    const d = dropNonFiniteRows(f);
    if (d) {
      sparsened.push({ name: `${f.kind}:${f.variable}`, rows: d.rows });
      if (d.field.ids.length > 0) fields.push(d.field);
      continue;
    }
    fields.push(f);
  }
  // A cell field can arrive split per recovered kind with nothing left after
  // sparsening; an empty FieldData is noise in every picker.
  return { model: { ...model, fields }, provenanceDropped, sparsened };
}

/**
 * Runs one adopting operation. Returns `undefined` for "nothing to operate on"
 * (no nodes, or no cells after conversion), which every caller reports as its
 * own noop.
 */
export async function runAdoptingOp<R extends { mesh: MeshioMesh }>(
  model: MdpaModel,
  diagnostics: MdpaDiagnostic[],
  op: string,
  call: (m: MeshioModule, mesh: MeshioMesh) => R,
  opts: AdoptingOpOptions<R> = {}
): Promise<AdoptingOpResult<R> | undefined> {
  if (model.nodeCount === 0) return undefined;
  const mesh = modelToMeshio(model, diagnostics, { dim: opts.dim ?? 3, carriers: true });
  if (mesh.cells.length === 0) return undefined;
  const m = await loadMeshio();
  const result = call(m, mesh);
  opts.patchResult?.(result, model);
  const adopted = adoptMeshioMesh(model, result.mesh, diagnostics, { op, recoverBlockNames: opts.recoverBlockNames });
  const tidy = tidyAdoptedFields(adopted.model);
  let out = tidy.model;
  let remap: RemapFieldsResult | undefined;
  if (opts.remapFields && model.fields.length > 0) {
    remap = await remapFieldsOntoRemesh(out, model, diagnostics);
    out = remap.model;
  }
  return {
    model: out,
    report: adopted.report,
    result,
    remap,
    provenanceDropped: tidy.provenanceDropped,
    sparsened: tidy.sparsened,
  };
}

/**
 * One or two sentences on what the adoption kept and could not keep, for an
 * op's outcome message. Names only what is actionable — a generated-id count
 * and every LOST slot — and never the boilerplate about slots that were kept.
 */
export function describeFidelity(r: Pick<AdoptingOpResult<unknown>, "report" | "remap" | "sparsened">): string {
  const parts: string[] = [];
  const g = r.report.generated;
  const fresh: string[] = [];
  if (g.nodes) fresh.push(`${g.nodes} node(s)`);
  if (g.elements) fresh.push(`${g.elements} element(s)`);
  if (g.conditions) fresh.push(`${g.conditions} condition(s)`);
  if (g.geometries) fresh.push(`${g.geometries} geometr${g.geometries === 1 ? "y" : "ies"}`);
  if (fresh.length) parts.push(`New ids assigned to ${fresh.join(", ")}.`);
  for (const l of r.report.lost) {
    if (l.slot === "nodeIds" || l.slot === "entityIds") continue; // said above
    if (l.slot === "fieldFixedFlags") continue;
    parts.push(`Not retained: ${l.slot} (${l.reason})`);
  }
  if (r.remap) {
    if (r.remap.transferred.length) {
      parts.push(`Mapped ${r.remap.transferred.length} field(s) (${r.remap.transferred.map((t) => t.name).join(", ")}).`);
    }
    for (const d of r.remap.dropped) parts.push(`Dropped ${d.name} (${d.reason}).`);
  }
  for (const s of r.sparsened) parts.push(`${s.name} is undefined on ${s.rows} row(s) (left as a gap).`);
  return parts.join(" ");
}
