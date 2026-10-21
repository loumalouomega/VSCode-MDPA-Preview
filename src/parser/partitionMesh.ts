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
 * ## Which partitioner
 *
 * `"sfc"` (the default, and what a recipe recorded before KaHIP existed gets) is
 * a Hilbert space-filling-curve cut — cells sorted along the curve and sliced
 * into contiguous ranges. Parts are balanced by CELL COUNT (to within one cell),
 * and locality is good, but there is no edge-cut minimization.
 *
 * `"kahip"` (meshio++ >= 17.9.0) is the quality partitioner. It is linked into
 * the FULL artifact only, so it is loaded lazily for exactly this call
 * (`loadMeshioForPartition`). Measured on 17.10.0: 40-47% fewer cut edges than
 * the curve on a 40x40 triangle grid split into 3 or 7 parts, equal where the
 * curve is already optimal (4 parts of a square), at the cost of a small
 * imbalance (up to ~2.4% here, against the curve's exact balance).
 *
 * `"auto"` means the best partitioner this install has: KaHIP when the full
 * artifact is installed, the curve otherwise. The shipped typings say `auto`
 * resolves to the curve; that is true of the lean build only (measured: on the
 * full one it returns KaHIP's labels exactly). The result reports the RESOLVED
 * method so the outcome never claims a quality cut that was not made.
 */

import { FieldData, MdpaModel, MdpaDiagnostic, SubModelPart } from "./types";
import { prepareMeshioOp, meshioCorrespondence, flattenMeshioData } from "./meshioAdapter";
import { loadMeshioForPartition, resolvePartitionMethod, PartitionMethodRequest } from "./meshio";

/** See the module docblock; `auto` resolves against the install. */
export type PartitionMethod = PartitionMethodRequest;

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
  /** The partitioner that actually ran (`auto` resolved); absent when nothing was partitioned. */
  method?: "sfc" | "kahip";
}

export async function partitionModel(
  model: MdpaModel,
  params: PartitionParams,
  diagnostics: MdpaDiagnostic[] = []
): Promise<PartitionResult> {
  const unchanged: PartitionResult = { model, assigned: 0, sizes: [] };
  const nparts = Math.floor(params.nparts);
  if (!(nparts >= 1)) return unchanged;

  const method = resolvePartitionMethod(params.method);
  const prepared = await prepareMeshioOp(model, diagnostics, {
    dim: 3,
    loader: () => loadMeshioForPartition(method),
  });
  if (!prepared) return unchanged;
  const { m, mesh } = prepared;
  // Passes the RESOLVED method, never "auto": on the full artifact upstream's
  // own "auto" is KaHIP, and what we report must be what ran. A missing full
  // artifact fails loudly in loadMeshioFull rather than downgrading to the curve.
  const labels = m.partitionLabels(mesh, nparts, method);

  // Flatten the per-block label arrays in meshio block order, then hand them
  // back out over our blocks in the same order. Labels arrive as BigInt64Array
  // since meshio++ 11.2.0, converted by the shared flattener.
  const flat = flattenMeshioData(labels);

  // The walk and modelToMeshio must agree 1:1. They did not when two
  // same-named blocks fused, and a plain length check on `flat` cannot see
  // that: fusion moves cells between blocks without losing any.
  const { blocks, cellCount: total } = meshioCorrespondence(model, mesh, "partition");
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
    method,
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
