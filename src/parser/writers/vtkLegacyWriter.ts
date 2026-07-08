/**
 * MdpaModel → legacy ASCII VTK (`DATASET UNSTRUCTURED_GRID`), the inverse of
 * vtkLegacyParser.ts.  Connectivity node-ids are remapped to 0-based point
 * indices; field data is written positionally (POINT_DATA / CELL_DATA) via the
 * shared FIELD block that the parser reads.
 *
 * Pure module: no vscode / DOM / vtk.js imports.
 */

import { MdpaDiagnostic, MdpaModel } from "../types";
import {
  buildCellLayout,
  cellFieldArray,
  num,
  pointFieldArray,
} from "./writerCommon";

export function writeVtkLegacy(model: MdpaModel): string {
  const diagnostics: MdpaDiagnostic[] = [];
  const layout = buildCellLayout(model, diagnostics);
  const lines: string[] = [
    "# vtk DataFile Version 3.0",
    "Exported by Kratos MDPA Preview",
    "ASCII",
    "DATASET UNSTRUCTURED_GRID",
  ];

  // Points
  lines.push(`POINTS ${model.nodeCount} float`);
  for (let i = 0; i < model.nodeCount; i++) {
    lines.push(
      `${num(model.coords[i * 3])} ${num(model.coords[i * 3 + 1])} ${num(model.coords[i * 3 + 2])}`
    );
  }

  // Cells
  const nCells = layout.cells.length;
  let intTotal = 0;
  for (const cell of layout.cells) intTotal += cell.nodes.length + 1;
  lines.push(`CELLS ${nCells} ${intTotal}`);
  for (const cell of layout.cells) {
    lines.push(`${cell.nodes.length} ${cell.nodes.join(" ")}`);
  }
  lines.push(`CELL_TYPES ${nCells}`);
  for (const cell of layout.cells) lines.push(String(cell.type));

  // Point data
  const nodalFields = model.fields.filter((f) => f.kind === "Nodal");
  if (nodalFields.length > 0 && model.nodeCount > 0) {
    lines.push(`POINT_DATA ${model.nodeCount}`);
    lines.push(`FIELD FieldData ${nodalFields.length}`);
    for (const f of nodalFields) {
      const arr = pointFieldArray(f, model);
      lines.push(`${sanitizeName(f.variable)} ${f.components} ${model.nodeCount} float`);
      lines.push(rowMajor(arr, f.components));
    }
  }

  // Cell data
  const cellFields = model.fields.filter((f) => f.kind !== "Nodal");
  if (cellFields.length > 0 && nCells > 0) {
    lines.push(`CELL_DATA ${nCells}`);
    lines.push(`FIELD FieldData ${cellFields.length}`);
    for (const f of cellFields) {
      const arr = cellFieldArray(f, layout);
      lines.push(`${sanitizeName(f.variable)} ${f.components} ${nCells} float`);
      lines.push(rowMajor(arr, f.components));
    }
  }

  return lines.join("\n") + "\n";
}

/** VTK array names must be a single token. */
function sanitizeName(name: string): string {
  return name.replace(/\s+/g, "_") || "field";
}

/** One line per tuple keeps the ASCII readable and unambiguous. */
function rowMajor(values: Float64Array, comp: number): string {
  const rows: string[] = [];
  for (let i = 0; i < values.length; i += comp) {
    const row: string[] = [];
    for (let k = 0; k < comp; k++) row.push(num(values[i + k]));
    rows.push(row.join(" "));
  }
  return rows.join("\n");
}
