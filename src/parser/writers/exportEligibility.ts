/**
 * Pre-write eligibility checks for the three formats whose meshio++ writer
 * imposes a real geometric constraint the extension does not otherwise
 * enforce: DOLFIN (`.xml`, simplicial only), TetGen (`.ele`+`.node`,
 * tetrahedra only) and EnSight (`.case`+`.geo`, geometry only, one keyword
 * per cell type). Each was excluded from MESHIO_WRITE_FORMAT entirely until
 * this module existed — the exclusion was really "no eligibility check
 * exists to refuse cleanly", not "the format cannot be written" (companions
 * were already handled by writeMeshioBytes for other multi-file formats).
 *
 * A refusal here is a `{ok: false}` BEFORE the wasm ever runs, so the
 * message names the actual reason rather than a generic upstream RAISE.
 * Warnings ride alongside an `ok: true` result the same way every other
 * writer's `onWarning` does — the write still happens.
 *
 * Pure (no vscode/DOM/wasm) so both the extension host and MCP `writeModel`
 * can call it before `writeMeshFileAsync`.
 */

import { EntityBlock, MdpaModel } from "../types";
import { VtkCellType as C } from "../geometryMap";

export interface ExportEligibility {
  ok: boolean;
  /** Set when `ok` is false — the one reason nothing was written. */
  reason?: string;
  /** Advisory; the write proceeds despite these when `ok` is true. */
  warnings: string[];
}

function blockCellCount(b: EntityBlock): number {
  return b.count;
}

function totalCellCount(model: MdpaModel): number {
  return model.blocks.reduce((sum, b) => sum + blockCellCount(b), 0);
}

/**
 * DOLFIN XML (meshio++ writer: `formats/dolfin.cpp`) raises on anything but
 * triangles or tetrahedra — correct by format, since DOLFIN XML is a
 * simplicial-mesh container with no other cell vocabulary. Quadratic
 * simplices are excluded too: the writer's own simplicial check is on the
 * linear corner count, and a mid-side node would silently be dropped from
 * connectivity rather than degrade to a linear cell.
 *
 * Each written array becomes its own `<stem>_<name>.xml` companion
 * (meshio++ >= 9.9.0); a mixed-cell-type mesh's dropped blocks are named so
 * the loss is not silent.
 */
export function dolfinEligibility(model: MdpaModel): ExportEligibility {
  const warnings: string[] = [];
  const kept = model.blocks.filter(
    (b) => b.vtkCellType === C.TRIANGLE || b.vtkCellType === C.TETRA
  );
  const dropped = model.blocks.filter((b) => !kept.includes(b));
  if (kept.length === 0) {
    return {
      ok: false,
      warnings,
      reason:
        "DOLFIN XML only writes triangles or tetrahedra, and this mesh has none " +
        "(Simplexify converts hex/wedge/pyramid/quad cells to them).",
    };
  }
  if (dropped.length > 0) {
    warnings.push(
      `DOLFIN XML is simplicial-only: ${dropped.map((b) => b.name).join(", ")} ` +
        "will not be written (Simplexify first to keep them)."
    );
  }
  if (model.fields.length > 0) {
    warnings.push(
      "Each field is written as its own \"<name>_<field>.xml\" companion file " +
        "next to the geometry."
    );
  }
  return { ok: true, warnings };
}

/**
 * TetGen (`formats/tetgen.cpp`) writes only 3D points and only `tetra`
 * cells into `.ele`; every other cell type is silently skipped upstream
 * (measured — the writer has no diagnostic for it), so this checks the same
 * thing DOLFIN does but refuses a 2D mesh outright too, since a TetGen
 * `.node`/`.ele` pair with 2D points is not a valid TetGen input for
 * anything downstream.
 */
export function tetgenEligibility(model: MdpaModel): ExportEligibility {
  const warnings: string[] = [];
  if (!model.is3D) {
    return {
      ok: false,
      warnings,
      reason: "TetGen needs 3D points; this mesh is planar (every z is 0).",
    };
  }
  const kept = model.blocks.filter((b) => b.vtkCellType === C.TETRA);
  const dropped = model.blocks.filter((b) => !kept.includes(b));
  if (kept.length === 0) {
    return {
      ok: false,
      warnings,
      reason:
        "TetGen's .ele only writes tetrahedra, and this mesh has none " +
        "(Simplexify converts hex/wedge/pyramid cells to them).",
    };
  }
  if (dropped.length > 0) {
    warnings.push(
      `TetGen writes tetrahedra only: ${dropped.map((b) => b.name).join(", ")} ` +
        "will not be written."
    );
  }
  if (model.fields.length > 0) {
    warnings.push("Point data is written as TetGen node attributes; cell data is not written.");
  }
  return { ok: true, warnings };
}

/**
 * EnSight Gold (`formats/ensight.cpp`) needs an EnSight keyword for every
 * cell type (point/bar2/tria3/quad4/tetra4/pyramid5/penta6/hexa8 and their
 * quadratic counterparts) and the mesh must fit in 32-bit indices
 * (`ensight.cpp:1186`). The keyword table itself is not duplicated here:
 * every VtkCellType this extension can EMIT already has a meshio++ type
 * name via MESHIO_TO_VTK_TYPE, and that table is deliberately the subset
 * EnSight (and every other basic-cell writer) already supports, so the only
 * check worth doing ahead of the wasm is the size guard and the
 * fields-are-dropped warning; an unexpected upstream RAISE still surfaces
 * as an ordinary write error rather than this function's refusal.
 */
export function ensightEligibility(model: MdpaModel): ExportEligibility {
  const warnings: string[] = [];
  const cells = totalCellCount(model);
  if (cells > 0x7fffffff) {
    return {
      ok: false,
      warnings,
      reason: `EnSight Gold indices are 32-bit; this mesh has ${cells} cells.`,
    };
  }
  if (model.fields.length > 0) {
    warnings.push("Only geometry is written; no point or cell data crosses to EnSight Gold.");
  }
  return { ok: true, warnings };
}

/** Dispatches on the write extension; `undefined` for every other format (nothing to check here). */
export function exportEligibility(model: MdpaModel, ext: string): ExportEligibility | undefined {
  switch (ext.toLowerCase()) {
    case ".xml":
      return dolfinEligibility(model);
    case ".ele":
    case ".node":
      return tetgenEligibility(model);
    case ".case":
    case ".geo":
      return ensightEligibility(model);
    default:
      return undefined;
  }
}
