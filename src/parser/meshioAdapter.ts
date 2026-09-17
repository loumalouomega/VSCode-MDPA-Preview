/**
 * The shared meshio++ integration/dispatch layer used by every "oracle"
 * operation (smoothMesh, reorderMesh, partitionMesh, gradientField,
 * hessianField, errorEstimate, sdfField, transferField, fieldIntegrate,
 * watertight): the load-mesh preamble, the block/entity correspondence guard,
 * the BigInt64Array-safe flattener, and the "attach a field, replacing my own
 * previous output" postamble that all ten of those modules used to hand-roll
 * independently.
 *
 * Pure module: no vscode / DOM imports so it stays Node-testable.
 *
 * ## Why this exists
 *
 * Every oracle module follows the same five-beat shape: convert the model
 * with `modelToMeshio(model, diagnostics, { dim: 3 })`, short-circuit on no
 * cells, `await loadMeshio()`, call one wasm operation, then verify the
 * result's shape before trusting it. That preamble was duplicated
 * byte-for-byte across all ten call sites, and the shape-verification guards
 * had drifted into FIVE different spellings of the same BigInt64Array
 * conversion and TWO independent copies of the block-order 1:1 guard —
 * `partitionMesh.ts` and `errorEstimate.ts` had it, `transferField.ts` used
 * `meshioBlockOrder` WITHOUT it, which is exactly the hole that guard exists
 * to close (a model with two same-named blocks fuses in `modelToMeshio`, and
 * a plain length check on the flattened result cannot see that: fusion moves
 * cells between blocks without losing any).
 *
 * This module does not change what any oracle computes or returns — it is a
 * pure refactor. Every existing test (`oracleOps.test.ts`, `meshio.test.ts`)
 * must pass unedited against it, with one deliberate exception:
 * `transferField.ts` now gets the same 1:1 guard as its siblings.
 */

import { EntityBlock, MdpaDiagnostic, FieldData, MdpaModel } from "./types";
import { modelToMeshio, meshioBlockOrder, meshioDataToNumbers, MeshioDataArray } from "./meshioConvert";
import { loadMeshio, MeshioModule } from "./meshio";

/** A model converted to meshio++'s shape, loaded and ready to operate on. */
export interface PreparedMeshioOp {
  m: MeshioModule;
  mesh: ReturnType<typeof modelToMeshio>;
}

/**
 * Convert + load the wasm module for a one-mesh operation. Returns
 * `undefined` when there is nothing to operate on (no nodes, or the
 * conversion produced no cells) — every oracle's own "noop" result is
 * returned by the caller in that case, so this stays agnostic of that shape.
 */
export async function prepareMeshioOp(
  model: MdpaModel,
  diagnostics: MdpaDiagnostic[],
  opts: { dim?: 2 | 3; exodusAttributes?: boolean } = {}
): Promise<PreparedMeshioOp | undefined> {
  if (model.nodeCount === 0) return undefined;
  const mesh = modelToMeshio(model, diagnostics, { dim: opts.dim ?? 3, exodusAttributes: opts.exodusAttributes });
  if (mesh.cells.length === 0) return undefined;
  const m = await loadMeshio();
  return { m, mesh };
}

/**
 * The block-order 1:1 guard: `meshioBlockOrder(model)` must correspond
 * exactly, one meshio cell block per `EntityBlock`, to `mesh.cells` — the
 * correspondence `partitionMesh.ts` and `errorEstimate.ts` verified
 * independently and `transferField.ts` did not, silently mislabelling cells
 * on a model whose blocks fuse. Throws with one consistent message rather
 * than returning a value the caller could mistakenly trust.
 */
export function meshioCorrespondence(
  model: MdpaModel,
  mesh: { cells: readonly unknown[] },
  opName: string
): { blocks: EntityBlock[]; cellCount: number } {
  const blocks = meshioBlockOrder(model);
  if (mesh.cells.length !== blocks.length) {
    throw new Error(
      `${opName} saw ${mesh.cells.length} meshio block(s) for ${blocks.length} mesh ` +
        `block(s); the result was discarded.`
    );
  }
  let cellCount = 0;
  for (const b of blocks) cellCount += b.count;
  return { blocks, cellCount };
}

/** Entity ids laid out in meshio block order — the `b.entityIds[c]` walk, once. */
export function entityIdsInBlockOrder(blocks: readonly EntityBlock[], cellCount: number): Int32Array {
  const ids = new Int32Array(cellCount);
  let c = 0;
  for (const b of blocks) for (let i = 0; i < b.count; i++) ids[c++] = b.entityIds[i];
  return ids;
}

/** This model's node ids, in `nodeIds` order — the per-node counterpart of `entityIdsInBlockOrder`. */
export function nodeIdsOf(model: MdpaModel): Int32Array {
  const ids = new Int32Array(model.nodeCount);
  for (let i = 0; i < model.nodeCount; i++) ids[i] = model.nodeIds[i];
  return ids;
}

/**
 * Flatten a run of meshio `cell_data` block arrays (or a single array) into
 * one array of plain numbers, converting any `BigInt64Array`/`BigUint64Array`
 * element along the way. The single BigInt-safe flattener replacing five
 * different spellings: an inline `Number(arr[i])` loop (partitionMesh.ts), a
 * local `flatten` over `ArrayLike<number | bigint>` (errorEstimate.ts), a
 * local `flatten` over `ArrayLike<number>` combined with a separate
 * `.map(meshioDataToNumbers)` (transferField.ts), and two call sites with no
 * conversion at all because their arrays happened to already be numeric
 * (smoothMesh.ts, reorderMesh.ts, sdfField.ts).
 */
export function flattenMeshioData(
  arrays: readonly ArrayLike<number | bigint>[] | undefined
): number[] {
  const out: number[] = [];
  for (const a of arrays ?? []) {
    const nums = meshioDataToNumbers(a as MeshioDataArray);
    for (let i = 0; i < nums.length; i++) out.push(nums[i]);
  }
  return out;
}

/**
 * The per-node / per-cell count guard every oracle applies before trusting a
 * returned array: the whole design of these modules rests on one tuple per
 * node (or cell), in the input's own order, so a mismatched count means order
 * cannot be trusted and the result must be discarded rather than scattered
 * onto the wrong entities.
 */
export function expectCount(opName: string, what: "node" | "cell", got: number, want: number): void {
  if (got !== want) {
    throw new Error(
      `${opName} returned ${got} value(s) for ${want} ${what}(s); ${what} order ` +
        `cannot be trusted, so the result was discarded.`
    );
  }
}

/**
 * The 15-line "build the nodal field and replace my own previous output"
 * postamble duplicated byte-for-byte between gradientField.ts and
 * hessianField.ts and near-identically in sdfField.ts: re-running an op
 * replaces its own output rather than stacking a second field of the same
 * name, the rule every field-producing oracle follows.
 */
export function attachNodalField(
  model: MdpaModel,
  spec: { variable: string; components: number; ids: Int32Array; values: ArrayLike<number> | MeshioDataArray }
): { model: MdpaModel; field: FieldData } {
  const values =
    spec.values instanceof Float64Array
      ? spec.values
      : Float64Array.from(meshioDataToNumbers(spec.values as MeshioDataArray));
  const field: FieldData = {
    kind: "Nodal",
    variable: spec.variable,
    components: spec.components,
    ids: spec.ids,
    values,
  };
  const fields = model.fields.filter((f) => !(f.kind === "Nodal" && f.variable === spec.variable));
  fields.push(field);
  return { model: { ...model, fields }, field };
}

/**
 * The Elemental/Conditional counterpart of `attachNodalField`, with an
 * optional list of sibling variables to evict at the same time (errorEstimate
 * replaces both its indicator and its marking field together).
 */
export function attachCellField(
  model: MdpaModel,
  spec: {
    kind: "Elemental" | "Conditional";
    variable: string;
    components: number;
    ids: Int32Array;
    values: ArrayLike<number>;
    alsoReplace?: string[];
  }
): { model: MdpaModel; field: FieldData } {
  const field: FieldData = {
    kind: spec.kind,
    variable: spec.variable,
    components: spec.components,
    ids: spec.ids,
    values: Float64Array.from(spec.values),
  };
  const evict = new Set([spec.variable, ...(spec.alsoReplace ?? [])]);
  const fields = model.fields.filter((f) => !(f.kind === spec.kind && evict.has(f.variable)));
  fields.push(field);
  return { model: { ...model, fields }, field };
}

/**
 * The 15-line "not a Nodal field" error duplicated byte-for-byte between
 * gradientField.ts and hessianField.ts (and reworded once more in
 * errorEstimate.ts): an Elemental/Conditional field is piecewise constant and
 * has no derivative, which is a different message from "no such field" and
 * points at the Average field operation as the way forward.
 */
export function requireNodalSource(model: MdpaModel, variable: string, verb: "differentiate" | "estimate"): FieldData {
  const source = model.fields.find((f) => f.kind === "Nodal" && f.variable === variable);
  if (source) return source;
  const elsewhere = model.fields.find((f) => f.variable === variable);
  if (elsewhere) {
    const noDerivativeClause =
      verb === "differentiate"
        ? "which is piecewise constant and has no derivative"
        : "which is piecewise constant and has no gradient to recover";
    throw new Error(
      `"${variable}" is a ${elsewhere.kind} field, ${noDerivativeClause}. Move it to ` +
        `the nodes first with the Average field operation, then ${verb === "differentiate" ? "differentiate" : "estimate"}.`
    );
  }
  throw new Error(`No nodal field named "${variable}".`);
}
