/**
 * MdpaModel → VTK XML (`.vtu` UnstructuredGrid / `.vtp` PolyData), the inverse
 * of vtkXmlParser.ts.  All DataArrays are written as inline ASCII (no base64 /
 * compression) so the file re-parses without any binary dependency.
 *
 * Pure module: no vscode / DOM / vtk.js imports.
 */

import { FieldData, MdpaDiagnostic, MdpaModel } from "../types";
import {
  buildCellLayout,
  CellLayout,
  cellCategory,
  cellFieldArray,
  cornerCount,
  nodeIndexMap,
  num,
  pointFieldArray,
} from "./writerCommon";

function escapeName(name: string): string {
  return name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function dataArray(
  name: string | null,
  type: string,
  values: ArrayLike<number>,
  comps: number,
  indent: string
): string[] {
  const attrs = [
    `type="${type}"`,
    name ? `Name="${escapeName(name)}"` : "",
    comps > 1 ? `NumberOfComponents="${comps}"` : "",
    `format="ascii"`,
  ]
    .filter(Boolean)
    .join(" ");
  const nums: string[] = [];
  for (let i = 0; i < values.length; i++) nums.push(num(values[i]));
  return [
    `${indent}<DataArray ${attrs}>`,
    `${indent}  ${nums.join(" ")}`,
    `${indent}</DataArray>`,
  ];
}

function pointsBlock(model: MdpaModel, indent: string): string[] {
  return [
    `${indent}<Points>`,
    ...dataArray(null, "Float32", model.coords, 3, indent + "  "),
    `${indent}</Points>`,
  ];
}

function pointDataBlock(model: MdpaModel, indent: string): string[] {
  const nodal = model.fields.filter((f) => f.kind === "Nodal");
  if (nodal.length === 0 || model.nodeCount === 0) return [];
  const out = [`${indent}<PointData>`];
  for (const f of nodal) {
    out.push(...dataArray(f.variable, "Float32", pointFieldArray(f, model), f.components, indent + "  "));
  }
  out.push(`${indent}</PointData>`);
  return out;
}

function cellDataBlock(fields: FieldData[], layout: CellLayout, indent: string): string[] {
  const cellFields = fields.filter((f) => f.kind !== "Nodal");
  if (cellFields.length === 0 || layout.cells.length === 0) return [];
  const out = [`${indent}<CellData>`];
  for (const f of cellFields) {
    out.push(...dataArray(f.variable, "Float32", cellFieldArray(f, layout), f.components, indent + "  "));
  }
  out.push(`${indent}</CellData>`);
  return out;
}

// ---- .vtu (UnstructuredGrid) -------------------------------------------------

export function writeVtu(model: MdpaModel): string {
  const diagnostics: MdpaDiagnostic[] = [];
  const layout = buildCellLayout(model, diagnostics);

  const connectivity: number[] = [];
  const offsets: number[] = [];
  const types: number[] = [];
  for (const cell of layout.cells) {
    for (const n of cell.nodes) connectivity.push(n);
    offsets.push(connectivity.length);
    types.push(cell.type);
  }

  const lines: string[] = [
    `<?xml version="1.0"?>`,
    `<VTKFile type="UnstructuredGrid" version="1.0" byte_order="LittleEndian">`,
    `  <UnstructuredGrid>`,
    `    <Piece NumberOfPoints="${model.nodeCount}" NumberOfCells="${layout.cells.length}">`,
    ...pointsBlock(model, "      "),
    `      <Cells>`,
    ...dataArray("connectivity", "Int32", connectivity, 1, "        "),
    ...dataArray("offsets", "Int32", offsets, 1, "        "),
    ...dataArray("types", "UInt8", types, 1, "        "),
    `      </Cells>`,
    ...pointDataBlock(model, "      "),
    ...cellDataBlock(model.fields, layout, "      "),
    `    </Piece>`,
    `  </UnstructuredGrid>`,
    `</VTKFile>`,
  ];
  return lines.join("\n") + "\n";
}

// ---- .vtp (PolyData) ---------------------------------------------------------

/**
 * Routes cells into PolyData sections by category.  Verts/Lines/Polys are
 * emitted in the parser's expected tuple order (verts → lines → polys), and
 * volume cells are dropped (a .vtp is a surface format) with a diagnostic.
 */
export function writeVtp(model: MdpaModel): string {
  const idToIndex = nodeIndexMap(model);
  const sections = {
    Verts: { conn: [] as number[], offs: [] as number[] },
    Lines: { conn: [] as number[], offs: [] as number[] },
    Polys: { conn: [] as number[], offs: [] as number[] },
  };
  let droppedVolume = 0;

  const emit = (sec: { conn: number[]; offs: number[] }, nodes: number[]): void => {
    for (const n of nodes) sec.conn.push(n);
    sec.offs.push(sec.conn.length);
  };

  for (const block of model.blocks) {
    const cat = cellCategory(block.vtkCellType);
    const corners = Math.min(cornerCount(block.vtkCellType) || block.stride, block.stride);
    for (let c = 0; c < block.count; c++) {
      const nodes: number[] = [];
      let ok = true;
      for (let k = 0; k < corners; k++) {
        const idx = idToIndex.get(block.connectivity[c * block.stride + k]);
        if (idx === undefined) {
          ok = false;
          break;
        }
        nodes.push(idx);
      }
      if (!ok) continue;
      if (cat === "point") emit(sections.Verts, nodes);
      else if (cat === "line") emit(sections.Lines, nodes);
      else if (cat === "surface") emit(sections.Polys, nodes);
      else droppedVolume++;
    }
  }

  const sectionXml = (
    tag: keyof typeof sections,
    indent: string
  ): string[] => {
    const s = sections[tag];
    return [
      `${indent}<${tag}>`,
      ...dataArray("connectivity", "Int32", s.conn, 1, indent + "  "),
      ...dataArray("offsets", "Int32", s.offs, 1, indent + "  "),
      `${indent}</${tag}>`,
    ];
  };

  const nVerts = sections.Verts.offs.length;
  const nLines = sections.Lines.offs.length;
  const nPolys = sections.Polys.offs.length;

  const lines: string[] = [
    `<?xml version="1.0"?>`,
    `<VTKFile type="PolyData" version="1.0" byte_order="LittleEndian">`,
    `  <PolyData>`,
    `    <Piece NumberOfPoints="${model.nodeCount}" NumberOfVerts="${nVerts}" NumberOfLines="${nLines}" NumberOfStrips="0" NumberOfPolys="${nPolys}">`,
    ...pointsBlock(model, "      "),
    ...pointDataBlock(model, "      "),
    ...sectionXml("Verts", "      "),
    ...sectionXml("Lines", "      "),
    ...sectionXml("Polys", "      "),
    `    </Piece>`,
    `  </PolyData>`,
    `</VTKFile>`,
  ];
  void droppedVolume; // volume cells are intentionally not representable in .vtp
  return lines.join("\n") + "\n";
}
