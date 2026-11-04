/**
 * The connectivity graph of a mesh (meshio++ 18.1.0 `adjacency` / `writeGraph`),
 * for partitioners and reordering tools. Pure module (no vscode / DOM); the wasm
 * is loaded through `loadMeshio`.
 *
 * `node`: nodes joined by a cell edge; `clique`: nodes sharing a cell (the FEM
 * sparsity pattern); `cell`: cells sharing a facet, numbered BLOCK-MAJOR in the
 * order the blocks are stored. Vertices are 0-based positions in the stored node
 * (or cell) order, NOT Kratos ids; METIS / Scotch files are 1-based by format.
 */

import type { MdpaDiagnostic, MdpaModel } from "./types";
import { modelToMeshio } from "./meshioConvert";
import { loadMeshio } from "./meshio";

export const GRAPH_KINDS = ["node", "clique", "cell"] as const;
export type GraphKind = (typeof GRAPH_KINDS)[number];
export const GRAPH_FORMATS = ["metis", "scotch"] as const;
export type GraphFormat = (typeof GRAPH_FORMATS)[number];

export interface MeshGraphResult {
  kind: GraphKind;
  vertices: number;
  /** Undirected edges (each stored both ways in the CSR). */
  edges: number;
  minDegree: number;
  maxDegree: number;
  meanDegree: number;
  /** Largest |i - j| over an edge: the bandwidth of the current numbering. */
  bandwidth: number;
  indptr: Int32Array;
  indices: Int32Array;
  /** The METIS / Scotch file, when a format was asked for. */
  file?: { format: GraphFormat; data: Uint8Array };
}

/** `.graph` is METIS, `.grf` is Scotch; anything else is undecided. */
export function graphFormatOf(ext: string): GraphFormat | undefined {
  const e = ext.toLowerCase();
  return e === ".graph" ? "metis" : e === ".grf" ? "scotch" : undefined;
}

export async function meshGraph(model: MdpaModel, kind: GraphKind = "node", format?: GraphFormat, diagnostics: MdpaDiagnostic[] = []): Promise<MeshGraphResult> {
  if (!(GRAPH_KINDS as readonly string[]).includes(kind)) throw new Error(`kind must be one of ${GRAPH_KINDS.join(", ")}.`);
  if (model.blocks.every((b) => b.count === 0)) throw new Error("The mesh has no cells, so it has no graph.");
  const m = await loadMeshio();
  const mesh = modelToMeshio(model, diagnostics, { dim: 3 });
  mesh.point_data = {}; mesh.cell_data = {}; mesh.regions = [];
  const { indptr, indices } = m.adjacency(mesh, kind);
  const n = indptr.length - 1;
  let min = Infinity, max = 0, band = 0;
  for (let i = 0; i < n; i++) {
    const d = indptr[i + 1] - indptr[i];
    if (d < min) min = d;
    if (d > max) max = d;
    for (let k = indptr[i]; k < indptr[i + 1]; k++) band = Math.max(band, Math.abs(indices[k] - i));
  }
  const result: MeshGraphResult = {
    kind, vertices: n, edges: indices.length / 2, minDegree: n ? min : 0, maxDegree: max, meanDegree: n ? indices.length / n : 0, bandwidth: band, indptr, indices,
  };
  if (format) {
    const p = `/mio_graph${format === "metis" ? ".graph" : ".grf"}`;
    m.writeGraph(mesh, p, kind, format);
    result.file = { format, data: Uint8Array.from(m.FS.readFile(p) as Uint8Array) };
    try { m.FS.unlink?.(p); } catch { /* scratch */ }
  }
  return result;
}
