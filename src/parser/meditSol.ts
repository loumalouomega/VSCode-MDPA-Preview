// Medit solution files (.sol ASCII) read as nodal fields of their mesh
// (roadmap item 75).
//
// A .sol file has values and no geometry, so it is never a mesh on its own: it
// pairs with a .mesh/.meshb that has the same stem and the same vertex count.
// MMG reads and writes its sizing metrics and level sets this way, so the
// pairing lets a metric computed elsewhere be inspected before a remesh.
//
// Grammar (ASCII): `MeshVersionFormatted v`, `Dimension d`, then
// `SolAtVertices`, the vertex count, `nfields t1 … tn` (1 scalar, 2 vector of
// d components, 3 symmetric tensor of d(d+1)/2 components) and one record per
// vertex holding every field's values in order, ended by `End`. Keywords are
// case-insensitive and `#` starts a comment. Binary .solb is not read here.
//
// Pure: no fs, no vscode, no wasm.

import { FieldData, MdpaDiagnostic } from "./types";

export interface MeditSolResult {
  fields: FieldData[];
  diagnostics: MdpaDiagnostic[];
  /** Vertex count the file declares (0 when it declares none). */
  vertexCount: number;
}

/** Candidate companion file names for a mesh file name, in preference order. */
export function meditSolCompanionNames(meshFileName: string): string[] {
  const m = /^(.*)\.(meshb?)$/i.exec(meshFileName);
  if (!m) return [];
  return m[2].toLowerCase() === "meshb" ? [`${m[1]}.solb`, `${m[1]}.sol`] : [`${m[1]}.sol`, `${m[1]}.solb`];
}

/** Candidate mesh names for a .sol/.solb file name. */
export function meditMeshForSolNames(solFileName: string): string[] {
  const m = /^(.*)\.(solb?)$/i.exec(solFileName);
  if (!m) return [];
  return [`${m[1]}.mesh`, `${m[1]}.meshb`];
}

const TYPE_NAMES: Record<number, string> = { 1: "scalar", 2: "vector", 3: "tensor" };

function componentsOf(type: number, dim: number): number {
  if (type === 1) return 1;
  if (type === 2) return dim;
  if (type === 3) return (dim * (dim + 1)) / 2;
  return 0;
}

/**
 * Parse an ASCII .sol against a mesh with `nodeIds` (storage order — the order
 * the mesh lists its vertices in). A vertex-count mismatch, a binary file or a
 * malformed record yields NO fields and one named diagnostic, never a
 * half-filled field.
 */
export function parseMeditSol(text: string, nodeIds: ArrayLike<number>, fileLabel = "solution file"): MeditSolResult {
  const out: MeditSolResult = { fields: [], diagnostics: [], vertexCount: 0 };
  const warn = (message: string): MeditSolResult => {
    out.diagnostics.push({ line: 0, message: `${fileLabel}: ${message}` });
    out.fields = [];
    return out;
  };
  if (text.includes("\u0000")) return warn("binary Medit solution files are not read; export the .sol as ASCII.");

  // Tokenise: strip comments, split on whitespace, keep keywords case-insensitive.
  const tokens: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const clean = line.replace(/#.*$/, "").trim();
    if (clean) tokens.push(...clean.split(/\s+/));
  }
  let pos = 0;
  let dim = 3;
  let found = false;
  while (pos < tokens.length) {
    const key = tokens[pos++].toLowerCase();
    if (key === "dimension") {
      dim = Number(tokens[pos++]);
      if (dim !== 2 && dim !== 3) return warn(`unsupported Dimension ${dim}.`);
    } else if (key === "solatvertices") {
      found = true;
      break;
    } else if (key === "meshversionformatted") {
      pos++;
    } else if (key === "end") {
      break;
    }
  }
  if (!found) return warn("no SolAtVertices section.");

  const count = Number(tokens[pos++]);
  const nFields = Number(tokens[pos++]);
  if (!Number.isInteger(count) || count < 0 || !Number.isInteger(nFields) || nFields < 1) return warn("malformed SolAtVertices header.");
  out.vertexCount = count;
  const types: number[] = [];
  for (let f = 0; f < nFields; f++) types.push(Number(tokens[pos++]));
  const widths = types.map((t) => componentsOf(t, dim));
  if (widths.some((w) => w === 0)) return warn(`unknown solution type ${types.find((_, i) => widths[i] === 0)}.`);

  if (count !== nodeIds.length) {
    return warn(`declares ${count} vertices but the mesh has ${nodeIds.length}; the solution is ignored.`);
  }
  const perVertex = widths.reduce((a, b) => a + b, 0);
  if (tokens.length - pos < count * perVertex) return warn("fewer values than the header declares.");

  const buffers = widths.map((w) => new Float64Array(count * w));
  for (let v = 0; v < count; v++) {
    for (let f = 0; f < nFields; f++) {
      for (let c = 0; c < widths[f]; c++) {
        const x = Number(tokens[pos++]);
        if (!Number.isFinite(x)) return warn(`non-numeric value at vertex ${v + 1}.`);
        buffers[f][v * widths[f] + c] = x;
      }
    }
  }
  const ids = Int32Array.from(nodeIds as ArrayLike<number>);
  for (let f = 0; f < nFields; f++) {
    out.fields.push({
      kind: "Nodal",
      variable: nFields === 1 ? "SOL" : `SOL_${f + 1}`,
      components: widths[f],
      ids: ids.slice(),
      values: buffers[f],
    });
  }
  out.diagnostics.push({
    line: 0,
    message: `${fileLabel}: read ${nFields} nodal field(s) (${types.map((t) => TYPE_NAMES[t]).join(", ")}); Medit stores no names, so they are called ${out.fields.map((f) => f.variable).join(", ")}.`,
  });
  return out;
}
