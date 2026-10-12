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
 * `dimensions` is written from the field's own recorded exponents (former roadmap item 12) and
 * is `[0 0 0 0 0 0 0]` only for a field whose dimensions are UNKNOWN — inventing
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

/** Full double precision: for the in-place save, where 1e-6 rounding would corrupt small values. */
function numPrecise(v: number): string {
  return Number.isFinite(v) ? String(v === 0 ? 0 : v) : "0";
}

function formatRow(values: readonly number[], precise = false): string {
  const f = precise ? numPrecise : num;
  return values.length === 1 ? f(values[0]) : `(${values.map(f).join(" ")})`;
}

/** One Elemental field that covers every volume cell, ready to be written. */
export interface QualifyingVolumeField {
  field: FieldData;
  cls: string;
  kind: string;
  /** One formatted value per volume cell, in polyMesh cell order. */
  rows: string[];
}

/**
 * The fields `writeOpenFoamFields` would write, with their rows formatted.
 * Shared with the in-place save (`openfoamOwnership.ts`), which writes them
 * into the displayed time directory instead of `0/`. Skips (with the same
 * diagnostics as before) anything that is not a full-coverage scalar/vector/
 * tensor Elemental field.
 */
export function qualifyingVolumeFields(
  model: MdpaModel,
  diagnostics: MdpaDiagnostic[],
  precise = false
): QualifyingVolumeField[] {
  const volumeIds = volumeCellIdsInWriteOrder(model);
  if (volumeIds.length === 0) return [];
  const volumeSet = new Set(volumeIds);
  const written = new Set<string>();
  const out: QualifyingVolumeField[] = [];
  for (const f of model.fields) {
    if (f.kind !== "Elemental") continue;
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
    out.push({
      field: f,
      cls: shape.cls,
      kind: shape.kind,
      rows: volumeIds.map((id) => formatRow(rowOf.get(id)!, precise)),
    });
  }
  return out;
}

/**
 * Replaces the `internalField` entry of an existing ASCII field file with a
 * `nonuniform List<kind>` of `rows`, leaving the header, `dimensions` and the
 * whole `boundaryField` byte-for-byte as they were. Returns `undefined` when
 * the entry cannot be located safely (no `internalField`, an unterminated
 * list, a binary file, or a class that does not match `cls`) — the caller then
 * leaves the file alone and says so. The in-place save's answer to "an
 * existing field file is never overwritten wholesale" (roadmap item 13).
 */
export function replaceInternalField(
  text: string,
  cls: string,
  kind: string,
  rows: readonly string[]
): string | undefined {
  if (/\bformat\s+binary\s*;/.test(text)) return undefined;
  const classOf = /\bclass\s+(\w+)\s*;/.exec(text)?.[1];
  if (classOf !== cls) return undefined;
  const key = /\binternalField\b/.exec(text);
  if (!key) return undefined;
  let depth = 0;
  let end = -1;
  for (let i = key.index + key[0].length; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === ";" && depth === 0) {
      end = i + 1;
      break;
    }
    if (depth < 0) return undefined;
  }
  if (end < 0) return undefined;
  const entry = `internalField   nonuniform List<${kind}>\n${rows.length}\n(\n${rows.join("\n")}\n)\n;`;
  return text.slice(0, key.index) + entry + text.slice(end);
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
  if (volumeCellIdsInWriteOrder(model).length === 0) return { companions, diagnostics };

  const boundaryCompanion = companions.find(
    (c) => c.name === "constant/polyMesh/boundary" || c.name.endsWith("/boundary")
  );
  const patchNames = boundaryCompanion
    ? parseOpenFoamBoundary(Buffer.from(boundaryCompanion.data).toString("utf8"), []).map((p) => p.name)
    : [];

  const extra: MeshioCompanionFile[] = [];
  for (const q of qualifyingVolumeFields(model, diagnostics)) {
    const f = q.field;
    const boundaryBlock =
      patchNames.length > 0
        ? patchNames.map((n) => `    ${n}\n    {\n        type            zeroGradient;\n    }\n`).join("")
        : "";

    const text =
      `FoamFile\n{\n    version     2.0;\n    format      ascii;\n    class       ${q.cls};\n` +
      `    object      ${f.variable};\n}\n\n` +
      `dimensions      [${(f.dimensions?.exponents ?? [0, 0, 0, 0, 0, 0, 0]).join(" ")}];\n\n` +
      `internalField   nonuniform List<${q.kind}>\n${q.rows.length}\n(\n${q.rows.join("\n")}\n)\n;\n\n` +
      `boundaryField\n{\n${boundaryBlock}}\n`;

    extra.push({ name: `0/${f.variable}`, data: new TextEncoder().encode(text) });
  }

  if (extra.length === 0) return { companions, diagnostics };
  return { companions: [...companions, ...extra], diagnostics };
}
