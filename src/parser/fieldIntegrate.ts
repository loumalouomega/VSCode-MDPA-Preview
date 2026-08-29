/**
 * Field integration — the cell-measure-weighted total and mean of a per-cell
 * field, for the whole mesh and per named region. Backed by meshio++'s
 * `dataIntegrate` (>= 10.8.0).
 *
 * Pure module: no vscode / DOM imports so it stays Node-testable. READ-ONLY —
 * the mesh is never modified, so this is not an OpRecord and leaves no entry in
 * the operation history. It belongs with meshQuality.ts and meshSize.ts, the
 * other "measure the mesh, change nothing" modules.
 *
 * ## Why the per-region breakdown comes for free
 *
 * `modelToMeshio`'s `buildRegions` already emits one `Cell` region per
 * EntityBlock and one per SubModelPart (walking children recursively). Upstream
 * reports every integral independently per named `Cell` region, so asking the
 * question at all yields the per-SubModelPart answer — total mass per part,
 * total flux per boundary — with no extra work here.
 *
 * Regions are NOT a partition: a cell that belongs to two of them contributes
 * fully to both, so the region totals need not sum to the domain total. That is
 * upstream's stated behaviour and is correct for overlapping groups, but it
 * would look like an arithmetic bug to anyone who assumed otherwise.
 *
 * ## Why a non-finite value is excluded rather than treated as zero
 *
 * A cell whose measure is not computable, or a component whose value is
 * non-finite, is dropped from that component's numerator AND denominator — it
 * never gets a fallback weight of 1. That is why `domainMeasurePerComponent`
 * can legitimately differ between two components of the same array, and why the
 * mean stays meaningful on a partly-NaN field instead of being dragged toward
 * zero by cells that carry no information.
 */

import { modelToMeshio, sanitizeVariable } from "./meshioConvert";
import { loadMeshio, MeshioFieldIntegral } from "./meshio";
import { MdpaDiagnostic, MdpaModel } from "./types";

export interface IntegralTotals {
  numCells: number;
  numSkipped: number;
  total: number[];
  mean: number[];
  measure: number[];
}

export interface FieldIntegral {
  variable: string;
  components: number;
  domain: IntegralTotals;
  /** One entry per named Cell region — the per-block / per-SubModelPart split. */
  regions: (IntegralTotals & { name: string })[];
}

function totals(t: {
  numCells: number;
  numSkipped: number;
  totalPerComponent: number[];
  meanPerComponent: number[];
  domainMeasurePerComponent: number[];
}): IntegralTotals {
  return {
    numCells: t.numCells,
    numSkipped: t.numSkipped,
    total: [...t.totalPerComponent],
    mean: [...t.meanPerComponent],
    measure: [...t.domainMeasurePerComponent],
  };
}

/**
 * Integrates the named Elemental/Conditional fields, or every one the mesh
 * carries when `variables` is empty. A NODAL name is refused by name, pointing
 * at the extension's own averaging op rather than upstream's internal one.
 */
export async function integrateFields(
  model: MdpaModel,
  variables: string[] = [],
  diagnostics: MdpaDiagnostic[] = []
): Promise<FieldIntegral[]> {
  const wanted = variables.map((v) => v.trim()).filter((v) => v.length > 0);
  for (const v of wanted) {
    const f = model.fields.find((x) => x.variable === v);
    if (f && f.kind === "Nodal") {
      throw new Error(
        `"${v}" is a Nodal field. Integration is cell-measure weighted, so move ` +
          `it to the cells first with the Average field operation ` +
          `(nodalToElemental), then integrate.`
      );
    }
  }

  const mesh = modelToMeshio(model, diagnostics, { dim: 3 });
  if (mesh.cells.length === 0) return [];
  // modelToMeshio sanitizes names on the way out, so ask for what it emitted.
  const names = wanted.map((v) => sanitizeVariable(v));

  const m = await loadMeshio();
  const rows: MeshioFieldIntegral[] = m.dataIntegrate(mesh, names);
  return rows.map((r) => ({
    variable: r.name,
    components: r.numComponents,
    domain: totals(r.domain),
    regions: (r.regions ?? []).map((g) => ({ ...totals(g), name: g.name })),
  }));
}
