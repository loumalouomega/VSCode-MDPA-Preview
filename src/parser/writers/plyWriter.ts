/**
 * MdpaModel → ASCII PLY.  Vertices carry x/y/z plus any scalar Nodal field as
 * an extra float property; the outer surface is written as triangular faces and
 * line cells become `edge` elements — the inverse of plyParser.ts.
 *
 * Pure module: no vscode / DOM / vtk.js imports.
 */

import { MdpaDiagnostic, MdpaModel } from "../types";
import {
  cellCategory,
  cornerCount,
  nodeIndexMap,
  num,
  pointFieldArray,
  surfaceTriangles,
} from "./writerCommon";

export function writePly(model: MdpaModel): string {
  const diagnostics: MdpaDiagnostic[] = [];
  const idToIndex = nodeIndexMap(model);

  // Scalar nodal fields → per-vertex float properties.
  const scalarFields = model.fields.filter((f) => f.kind === "Nodal" && f.components === 1);
  const fieldArrays = scalarFields.map((f) => ({
    name: sanitize(f.variable),
    values: pointFieldArray(f, model),
  }));

  // Surface triangles (surface cells + volume boundary).
  const tris = surfaceTriangles(model, diagnostics);

  // Line cells → edges.
  const edges: [number, number][] = [];
  for (const block of model.blocks) {
    if (cellCategory(block.vtkCellType) !== "line") continue;
    const corners = Math.min(cornerCount(block.vtkCellType) || block.stride, block.stride);
    for (let c = 0; c < block.count; c++) {
      const a = idToIndex.get(block.connectivity[c * block.stride]);
      const b = idToIndex.get(block.connectivity[c * block.stride + Math.min(1, corners - 1)]);
      if (a !== undefined && b !== undefined) edges.push([a, b]);
    }
  }

  const nFaces = tris.length / 3;
  const header: string[] = [
    "ply",
    "format ascii 1.0",
    "comment Exported by Kratos MDPA Preview",
    `element vertex ${model.nodeCount}`,
    "property float x",
    "property float y",
    "property float z",
  ];
  for (const f of fieldArrays) header.push(`property float ${f.name}`);
  header.push(`element face ${nFaces}`, "property list uchar int vertex_indices");
  if (edges.length > 0) {
    header.push(`element edge ${edges.length}`, "property int vertex1", "property int vertex2");
  }
  header.push("end_header");

  const body: string[] = [];
  for (let i = 0; i < model.nodeCount; i++) {
    const cols = [num(model.coords[i * 3]), num(model.coords[i * 3 + 1]), num(model.coords[i * 3 + 2])];
    for (const f of fieldArrays) cols.push(num(f.values[i]));
    body.push(cols.join(" "));
  }
  for (let t = 0; t < tris.length; t += 3) {
    body.push(`3 ${tris[t]} ${tris[t + 1]} ${tris[t + 2]}`);
  }
  for (const [a, b] of edges) body.push(`${a} ${b}`);

  return header.concat(body).join("\n") + "\n";
}

/** PLY property names must be a single token. */
function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_") || "field";
}
