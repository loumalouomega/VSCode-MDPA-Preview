/**
 * PLY parser (ascii / binary_little_endian / binary_big_endian) → MdpaModel.
 *
 * Vertex x/y/z become node coordinates; every other numeric scalar vertex
 * property becomes a Nodal FieldData (so it shows up in the field panel).
 * Face list properties become POLYGON cells (normalized by modelBuilder to
 * triangles/quads/fans); edge elements become LINE cells.  Unknown elements
 * are consumed and ignored.  Pure module: no vscode/DOM/vtk imports.
 */

import { FieldData, MdpaDiagnostic, MdpaModel } from "./types";
import {
  buildBlocksFromOffsets,
  fieldFromTuples,
  finalizeModel,
} from "./modelBuilder";
import { binaryType, BinaryType } from "./binaryTypes";

const LINE = 3;
const POLYGON = 7;

interface PlyProperty {
  name: string;
  isList: boolean;
  countType?: BinaryType;
  valueType: BinaryType;
}

interface PlyElement {
  name: string;
  count: number;
  props: PlyProperty[];
}

/** Sequential value source abstracting ascii tokens vs binary bytes. */
interface ValueSource {
  next(t: BinaryType): number;
}

/**
 * The PLY header: format, element declarations and where the body starts.
 * Split out of `parsePly` so `meshSummary.ts` can answer "what is in this file"
 * from the header alone — PLY declares `element vertex N` up front, so the
 * counts need none of the body. `parsePly` calls it unchanged, which is what
 * keeps the summary and the parse from ever disagreeing.
 *
 * Returns `undefined` for a header this parser cannot use, having pushed the
 * reason as a diagnostic — the same failure shape `parsePly` already had.
 */
export function parsePlyHeader(
  buf: Buffer,
  diagnostics: MdpaDiagnostic[]
): { format: "ascii" | "little" | "big"; elements: PlyElement[]; bodyStart: number } | undefined {
  const headerEndMark = buf.indexOf("end_header");
  if (!buf.subarray(0, 4).toString("latin1").startsWith("ply") || headerEndMark < 0) {
    diagnostics.push({ line: 0, message: "Not a PLY file (missing magic or end_header)." });
    return undefined;
  }
  let bodyStart = buf.indexOf(0x0a, headerEndMark);
  bodyStart = bodyStart < 0 ? buf.length : bodyStart + 1;

  const headerText = buf.subarray(0, headerEndMark).toString("latin1");
  let format: "ascii" | "little" | "big" | null = null;
  const elements: PlyElement[] = [];
  let currentEl: PlyElement | null = null;
  let lineNum = 0;

  for (const raw of headerText.split(/\r?\n/)) {
    lineNum++;
    const toks = raw.trim().split(/\s+/);
    const kw = toks[0];
    if (kw === "format") {
      if (toks[1] === "ascii") format = "ascii";
      else if (toks[1] === "binary_little_endian") format = "little";
      else if (toks[1] === "binary_big_endian") format = "big";
    } else if (kw === "element") {
      currentEl = { name: toks[1] ?? "", count: parseInt(toks[2], 10) || 0, props: [] };
      elements.push(currentEl);
    } else if (kw === "property" && currentEl) {
      if (toks[1] === "list") {
        const countType = binaryType(toks[2] ?? "");
        const valueType = binaryType(toks[3] ?? "");
        if (!countType || !valueType) {
          diagnostics.push({ line: lineNum, message: `Unknown list property types: ${raw.trim()}` });
          return undefined;
        }
        currentEl.props.push({ name: toks[4] ?? "", isList: true, countType, valueType });
      } else {
        const valueType = binaryType(toks[1] ?? "");
        if (!valueType) {
          diagnostics.push({ line: lineNum, message: `Unknown property type: ${raw.trim()}` });
          return undefined;
        }
        currentEl.props.push({ name: toks[2] ?? "", isList: false, valueType });
      }
    }
    // ply / comment / obj_info — ignored
  }

  if (!format) {
    diagnostics.push({ line: 0, message: "PLY header has no valid format line." });
    return undefined;
  }
  return { format, elements, bodyStart };
}

export function parsePly(buf: Buffer): MdpaModel {
  const diagnostics: MdpaDiagnostic[] = [];
  const empty = () =>
    finalizeModel({
      nodeCount: 0,
      coords: new Float32Array(0),
      blocks: [],
      fields: [],
      diagnostics,
    });

  // ---- Header ------------------------------------------------------------------
  const header = parsePlyHeader(buf, diagnostics);
  if (!header) return empty();
  const { format, elements, bodyStart } = header;

  // ---- Value source ---------------------------------------------------------------
  let source: ValueSource;
  if (format === "ascii") {
    const tokens = buf.subarray(bodyStart).toString("latin1").split(/\s+/).filter((t) => t);
    let pos = 0;
    source = { next: () => Number(tokens[pos++]) };
  } else {
    const view = new DataView(buf.buffer, buf.byteOffset + bodyStart, buf.length - bodyStart);
    const le = format === "little";
    let pos = 0;
    source = {
      next: (t) => {
        if (pos + t.size > view.byteLength) {
          throw new Error("Unexpected end of PLY binary data.");
        }
        const v = t.read(view, pos, le);
        pos += t.size;
        return v;
      },
    };
  }

  // ---- Element data -----------------------------------------------------------------
  const coords: number[] = [];
  const fieldValues = new Map<string, number[]>(); // extra vertex props
  const cellTypes: number[] = [];
  const cellOffsets: number[] = [];
  const cellConn: number[] = []; // 0-based
  let vertexCount = 0;

  try {
    for (const el of elements) {
      if (el.name === "vertex") {
        vertexCount = el.count;
        const extras = el.props.filter(
          (p) => !p.isList && p.name !== "x" && p.name !== "y" && p.name !== "z"
        );
        for (const p of extras) fieldValues.set(p.name, []);
        for (let i = 0; i < el.count; i++) {
          let x = 0, y = 0, z = 0;
          for (const p of el.props) {
            if (p.isList) {
              const n = source.next(p.countType!);
              for (let k = 0; k < n; k++) source.next(p.valueType);
              continue;
            }
            const v = source.next(p.valueType);
            if (p.name === "x") x = v;
            else if (p.name === "y") y = v;
            else if (p.name === "z") z = v;
            else fieldValues.get(p.name)!.push(v);
          }
          coords.push(x, y, z);
        }
      } else if (el.name === "face") {
        for (let i = 0; i < el.count; i++) {
          let indices: number[] | null = null;
          for (const p of el.props) {
            if (p.isList) {
              const n = source.next(p.countType!);
              const list: number[] = [];
              for (let k = 0; k < n; k++) list.push(source.next(p.valueType));
              if (indices === null) indices = list; // first list property = the face
            } else {
              source.next(p.valueType);
            }
          }
          if (!indices) continue;
          if (indices.some((ix) => ix < 0 || ix >= vertexCount)) {
            diagnostics.push({
              line: 0,
              message: `Face ${i + 1} references a vertex outside 0..${vertexCount - 1}; skipped.`,
            });
            continue;
          }
          cellTypes.push(POLYGON);
          for (const ix of indices) cellConn.push(ix);
          cellOffsets.push(cellConn.length);
        }
      } else if (el.name === "edge") {
        const i1 = el.props.findIndex((p) => !p.isList && p.name === "vertex1");
        const i2 = el.props.findIndex((p) => !p.isList && p.name === "vertex2");
        for (let i = 0; i < el.count; i++) {
          let v1 = -1, v2 = -1;
          for (let pi = 0; pi < el.props.length; pi++) {
            const p = el.props[pi];
            if (p.isList) {
              const n = source.next(p.countType!);
              for (let k = 0; k < n; k++) source.next(p.valueType);
              continue;
            }
            const v = source.next(p.valueType);
            if (pi === i1) v1 = v;
            else if (pi === i2) v2 = v;
          }
          if (v1 >= 0 && v1 < vertexCount && v2 >= 0 && v2 < vertexCount) {
            cellTypes.push(LINE);
            cellConn.push(v1, v2);
            cellOffsets.push(cellConn.length);
          } else {
            diagnostics.push({ line: 0, message: `Edge ${i + 1} has invalid vertex refs; skipped.` });
          }
        }
      } else {
        // Unknown element — consume its data
        for (let i = 0; i < el.count; i++) {
          for (const p of el.props) {
            if (p.isList) {
              const n = source.next(p.countType!);
              for (let k = 0; k < n; k++) source.next(p.valueType);
            } else {
              source.next(p.valueType);
            }
          }
        }
      }
    }
  } catch (err) {
    diagnostics.push({
      line: 0,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const { blocks } = buildBlocksFromOffsets(cellTypes, cellOffsets, cellConn, diagnostics);

  const fields: FieldData[] = [];
  for (const [name, values] of fieldValues) {
    if (values.length === coords.length / 3) {
      fields.push(fieldFromTuples("Nodal", name, 1, values));
    }
  }

  return finalizeModel({
    nodeCount: coords.length / 3,
    coords: new Float32Array(coords),
    blocks,
    fields,
    diagnostics,
  });
}
