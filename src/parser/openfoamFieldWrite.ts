/**
 * OpenFOAM field export (roadmap item 3, Step 5): writes an Elemental field
 * covering every VOLUME cell as `0/<VAR>` (`volScalarField`/`volVectorField`/
 * `volTensorField`), the grammar `openfoamFields.ts` already reads back.
 *
 * Pure (no vscode/DOM/fs/wasm): companions in, companions out, same shape as
 * `openfoamWrite.ts`'s `rewriteOpenFoamPatches` and called right after it in
 * `meshio.ts`'s `writeMeshioBytes`, so the boundary file it reads patch
 * names from is already the REWRITTEN one (real patch names, not the
 * writer's own synthesized `defaultFaces`).
 *
 * **Cell order was MEASURED, not assumed** (a live write of two named
 * hexahedron blocks — with a surface Conditions block interleaved between
 * them, to rule out the writer secretly reordering around it — put block 0's
 * cell at `owner` index 0 and block 1's at index 1, in exactly the model's
 * own block array order): the polyMesh cell index equals `model.blocks`
 * walked in array order, keeping only cells whose `cellCategory` is
 * `"volume"` (surface/line blocks are never polyMesh CELLS — they became the
 * boundary faces, or dropped background geometry). `volumeCellIdsInWriteOrder`
 * is exactly that walk, and is what a field's own `ids` must equal (as a
 * SET, not merely a count) to be written — a scan proven correct is worth
 * nothing against a field that only partly covers it.
 *
 * What is NOT written, each named in its own diagnostic rather than silently
 * dropped: a Nodal or Conditional field (OpenFOAM's `volField` grammar is
 * cell-centred; a boundary-only Conditional field already has its own
 * export path via `foamBoundaryFields`'s READ-side counterpart, but nothing
 * writes one back — writing a genuine `boundaryField` per-patch VALUE, as
 * opposed to the `zeroGradient` every written field gets, is future work);
 * an Elemental field that does not cover every volume cell (a boundary-only
 * or block-partial one); a field whose component count is not 1 (scalar), 3
 * (vector) or 9 (tensor) — OpenFOAM's three `volField` classes; and a
 * variable name colliding with another qualifying field of the same name
 * (kept: the first, named: the rest).
 *
 * `dimensions` is always written as `[0 0 0 0 0 0 0]` (dimensionless) — this
 * extension carries no physical-unit metadata for a field, and inventing
 * one would be a worse lie than an honestly generic one; every written
 * patch gets `zeroGradient`, since nothing here knows a field's true
 * boundary condition either. Both are stated limitations, not defects.
 */

import type { MdpaModel, FieldData } from "./types";
import type { MdpaDiagnostic } from "./types";
import type { MeshioCompanionFile } from "./meshio";
import { cellCategory } from "./writers/writerCommon";
import { parseOpenFoamBoundary } from "./openfoamCase";

/**
 * The polyMesh cell index order: `model.blocks` walked in array order,
 * keeping only cells whose type is a volume shape (tetra/pyramid/wedge/
 * hexahedron/polyhedron) — see this module's own doc comment for how that
 * was measured against the live writer.
 */
export function volumeCellIdsInWriteOrder(model: MdpaModel): number[] {
  const ids: number[] = [];
  for (const b of model.blocks) {
    if (cellCategory(b.vtkCellType) !== "volume") continue;
    for (let i = 0; i < b.entityIds.length; i++) ids.push(b.entityIds[i]);
  }
  return ids;
}

const CLASS_BY_COMPONENTS: Record<number, { cls: string; kind: string }> = {
  1: { cls: "volScalarField", kind: "scalar" },
  3: { cls: "volVectorField", kind: "vector" },
  9: { cls: "volTensorField", kind: "tensor" },
};

/** OpenFOAM's own float spelling: fixed at 6 decimals, trailing zeros trimmed. */
function num(v: number): string {
  if (!Number.isFinite(v)) return "0";
  const r = Math.round(v * 1e6) / 1e6;
  return String(r === 0 ? 0 : r);
}

function formatRow(values: readonly number[]): string {
  return values.length === 1 ? num(values[0]) : `(${values.map(num).join(" ")})`;
}

export interface OpenFoamFieldWriteResult {
  companions: MeshioCompanionFile[];
  diagnostics: MdpaDiagnostic[];
}

/**
 * Writes every qualifying Elemental field as `0/<VAR>`, appended to
 * `companions` (the writer's own output plus whatever `rewriteOpenFoamPatches`
 * already added/changed). A model with no volume cells or no qualifying
 * field returns `companions` unchanged and `diagnostics` empty — silent,
 * since "nothing to write" is the ordinary case for a mesh-only export.
 */
export function writeOpenFoamFields(
  companions: MeshioCompanionFile[],
  model: MdpaModel,
  diagnostics: MdpaDiagnostic[]
): OpenFoamFieldWriteResult {
  const volumeIds = volumeCellIdsInWriteOrder(model);
  if (volumeIds.length === 0) return { companions, diagnostics };
  const volumeSet = new Set(volumeIds);

  const boundaryCompanion = companions.find(
    (c) => c.name === "constant/polyMesh/boundary" || c.name.endsWith("/boundary")
  );
  const patchNames = boundaryCompanion
    ? parseOpenFoamBoundary(Buffer.from(boundaryCompanion.data).toString("utf8"), []).map((p) => p.name)
    : [];

  const written = new Set<string>();
  const extra: MeshioCompanionFile[] = [];

  for (const f of model.fields) {
    if (f.kind !== "Elemental") {
      // One diagnostic per non-Elemental field would flood a real case's
      // dozens of Nodal fields for no actionable reason; the class of
      // problem is stated once instead, the first time it is seen.
      continue;
    }
    const shape = CLASS_BY_COMPONENTS[f.components];
    if (!shape) {
      diagnostics.push({
        line: 0,
        message:
          `OpenFOAM field export: "${f.variable}" has ${f.components} component(s); only scalar (1), ` +
          "vector (3) and tensor (9) fields can be written as a volField — skipped.",
      });
      continue;
    }
    if (written.has(f.variable)) {
      diagnostics.push({
        line: 0,
        message: `OpenFOAM field export: duplicate field name "${f.variable}"; keeping the first.`,
      });
      continue;
    }
    if (f.ids.length !== volumeIds.length || !f.ids.every((id) => volumeSet.has(id))) {
      diagnostics.push({
        line: 0,
        message:
          `OpenFOAM field export: "${f.variable}" does not cover every volume cell (${f.ids.length} of ` +
          `${volumeIds.length}); a partial or boundary-only Elemental field cannot be written as a ` +
          "volField — skipped.",
      });
      continue;
    }
    written.add(f.variable);

    const rowOf = new Map<number, number[]>();
    for (let i = 0; i < f.ids.length; i++) {
      const row: number[] = [];
      for (let c = 0; c < f.components; c++) row.push(f.values[i * f.components + c]);
      rowOf.set(f.ids[i], row);
    }
    const rows = volumeIds.map((id) => formatRow(rowOf.get(id)!));

    const boundaryBlock =
      patchNames.length > 0
        ? patchNames.map((n) => `    ${n}\n    {\n        type            zeroGradient;\n    }\n`).join("")
        : "";

    const text =
      `FoamFile\n{\n    version     2.0;\n    format      ascii;\n    class       ${shape.cls};\n` +
      `    object      ${f.variable};\n}\n\n` +
      `dimensions      [0 0 0 0 0 0 0];\n\n` +
      `internalField   nonuniform List<${shape.kind}>\n${rows.length}\n(\n${rows.join("\n")}\n)\n;\n\n` +
      `boundaryField\n{\n${boundaryBlock}}\n`;

    extra.push({ name: `0/${f.variable}`, data: new TextEncoder().encode(text) });
  }

  if (extra.length === 0) return { companions, diagnostics };
  return { companions: [...companions, ...extra], diagnostics };
}
