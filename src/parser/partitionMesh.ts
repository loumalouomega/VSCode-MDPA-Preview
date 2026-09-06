/**
 * Domain decomposition — splits the mesh into N balanced parts for an MPI run.
 * Backed by meshio++'s `partitionLabels`, used strictly as an oracle.
 *
 * Pure module: no vscode / DOM imports so it stays Node-testable. The input is
 * never mutated; a fresh MdpaModel is returned.
 *
 * ## Labels, not meshes
 *
 * meshio++ also offers `partition`, which returns N separate meshes. That is the
 * wrong shape here twice over: adopting those meshes would round-trip through
 * meshioConvert and destroy every SubModelPart, and a viewer wants ONE mesh it
 * can colour by part, not N documents. `partitionLabels` returns just the part
 * index per cell, block-aligned, which is exactly what we attach as an Elemental
 * field — so the mesh itself is untouched and the assignment is inspectable,
 * exportable and undoable like any other field.
 *
 * `PARTITION_INDEX` is a real Kratos variable, so a `.mdpa` export carries the
 * decomposition into Kratos rather than into a private convention.
 *
 * ## The one caveat worth stating loudly
 *
 * The WASM build has **no KaHIP**, so the quality partitioner is unavailable:
 * `"kahip"` throws by name and `"auto"` resolves to `"sfc"`. What you get is a
 * Hilbert space-filling-curve cut — cells sorted along the curve and sliced into
 * contiguous ranges. Parts are balanced by CELL COUNT (to within one cell), and
 * locality is good, but there is no edge-cut minimization: the interface between
 * parts is whatever the curve happens to produce, not an optimized surface.
 * Honest for previewing and for a quick run; not a substitute for METIS.
 */

import { EntityBlock, FieldData, MdpaModel, MdpaDiagnostic, SubModelPart } from "./types";
import { modelToMeshio, meshioBlockOrder } from "./meshioConvert";
import { loadMeshio } from "./meshio";

/** Only `sfc` is reachable in the WASM build; see the module docblock. */
export type PartitionMethod = "sfc" | "kahip" | "auto";

export const PARTITION_VARIABLE = "PARTITION_INDEX";

export interface PartitionParams {
  nparts: number;
  method?: PartitionMethod;
  /** Also create one SubModelPart per part, holding that part's elements. */
  createParts?: boolean;
}

export interface PartitionResult {
  model: MdpaModel;
  /** Cells assigned a part. */
  assigned: number;
  /** Cell count per part, in part order. */
  sizes: number[];
}

export async function partitionModel(
  model: MdpaModel,
  params: PartitionParams,
  diagnostics: MdpaDiagnostic[] = []
): Promise<PartitionResult> {
  const unchanged: PartitionResult = { model, assigned: 0, sizes: [] };
  const nparts = Math.floor(params.nparts);
  if (!(nparts >= 1)) return unchanged;

  const mesh = modelToMeshio(model, diagnostics, { dim: 3 });
  if (mesh.cells.length === 0) return unchanged;

  const m = await loadMeshio();
  // Throws by name for "kahip" — surfaced rather than silently downgraded, so a
  // user asking for quality partitioning learns the build cannot do it.
  const labels = m.partitionLabels(mesh, nparts, params.method ?? "sfc");

  // Flatten the per-block label arrays in meshio block order, then hand them
  // back out over our blocks in the same order.
  const flat: number[] = [];
  for (const arr of labels) for (const v of arr) flat.push(v);

  const blocks = meshioBlockOrder(model);
  // The walk and modelToMeshio must agree 1:1. They did not when two
  // same-named blocks fused, and the length check below cannot see that:
  // fusion moves cells between blocks without losing any.
  if (mesh.cells.length !== blocks.length) {
    throw new Error(
      `partition saw ${mesh.cells.length} meshio block(s) for ${blocks.length} mesh block(s); the result was discarded.`
    );
  }
  let total = 0;
  for (const b of blocks) total += b.count;
  if (flat.length !== total) {
    throw new Error(
      `partition returned ${flat.length} labels for ${total} cells; the result was discarded.`
    );
  }

  const ids: number[] = [];
  const values: number[] = [];
  const sizes = new Array<number>(nparts).fill(0);
  let cursor = 0;
  for (const b of blocks) {
    for (let c = 0; c < b.count; c++) {
      const part = flat[cursor++];
      ids.push(b.entityIds[c]);
      values.push(part);
      if (part >= 0 && part < nparts) sizes[part]++;
    }
  }

  const field: FieldData = {
    kind: "Elemental",
    variable: PARTITION_VARIABLE,
    components: 1,
    ids: Int32Array.from(ids),
    values: Float64Array.from(values),
  };

  const subModelParts = params.createParts
    ? [...model.subModelParts, ...partsFor(ids, values, nparts)]
    : model.subModelParts;

  return {
    model: {
      ...model,
      fields: [
        ...model.fields.filter(
          (f) => !(f.kind === "Elemental" && f.variable === PARTITION_VARIABLE)
        ),
        field,
      ],
      subModelParts,
    },
    assigned: ids.length,
    sizes,
  };
}

/** One top-level SubModelPart per part, holding that part's entity ids. */
function partsFor(ids: number[], values: number[], nparts: number): SubModelPart[] {
  const buckets: number[][] = Array.from({ length: nparts }, () => []);
  for (let i = 0; i < ids.length; i++) {
    const p = values[i];
    if (p >= 0 && p < nparts) buckets[p].push(ids[i]);
  }
  return buckets.map((elementIds, p) => {
    const name = `Partition_${p}`;
    return {
      name,
      path: name,
      nodeIds: new Int32Array(0),
      elementIds: Int32Array.from(elementIds),
      conditionIds: new Int32Array(0),
      geometryIds: new Int32Array(0),
      constraintIds: new Int32Array(0),
      children: [],
    };
  });
}
