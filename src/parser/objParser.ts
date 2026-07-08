/**
 * Wavefront OBJ parser (ASCII) → MdpaModel.
 *
 * Supports v/f/l/p statements and g/o grouping; vt/vn/mtllib/usemtl/s are
 * ignored.  Faces are staged as POLYGON / POLY_LINE / POLY_VERTEX cells and
 * normalized to drawable types by modelBuilder (tri/quad/fan, line segments,
 * vertices).  Pure module: no vscode/DOM/vtk imports.
 */

import { EntityBlock, MdpaDiagnostic, MdpaModel } from "./types";
import { buildBlocksFromOffsets, finalizeModel } from "./modelBuilder";

const POLY_VERTEX = 2;
const POLY_LINE = 4;
const POLYGON = 7;

interface StagingGroup {
  name: string;
  types: number[];
  offsets: number[];
  connectivity: number[]; // 0-based
}

export function parseObj(text: string): MdpaModel {
  const diagnostics: MdpaDiagnostic[] = [];
  const coords: number[] = [];
  const groups: StagingGroup[] = [];
  const groupByName = new Map<string, StagingGroup>();
  let current: StagingGroup | null = null;
  let lineNum = 0;

  const groupFor = (name: string): StagingGroup => {
    let g = groupByName.get(name);
    if (!g) {
      g = { name, types: [], offsets: [], connectivity: [] };
      groupByName.set(name, g);
      groups.push(g);
    }
    return g;
  };

  /** OBJ index token ("7", "7/1", "7//2", "-1") → 0-based vertex index or -1. */
  const resolveIndex = (tok: string): number => {
    const slash = tok.indexOf("/");
    const raw = parseInt(slash >= 0 ? tok.slice(0, slash) : tok, 10);
    if (isNaN(raw) || raw === 0) return -1;
    const nVerts = coords.length / 3;
    const idx = raw > 0 ? raw - 1 : nVerts + raw;
    return idx >= 0 && idx < nVerts ? idx : -1;
  };

  const addCell = (cellType: number, toks: string[]): void => {
    const indices: number[] = [];
    for (const tok of toks) {
      const idx = resolveIndex(tok);
      if (idx < 0) {
        diagnostics.push({
          line: lineNum,
          message: `Invalid vertex reference "${tok}"; statement skipped.`,
        });
        return;
      }
      indices.push(idx);
    }
    if (indices.length === 0) return;
    const g = current ?? (current = groupFor("default"));
    g.types.push(cellType);
    for (const i of indices) g.connectivity.push(i);
    g.offsets.push(g.connectivity.length);
  };

  for (const raw of text.split(/\r?\n/)) {
    lineNum++;
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const toks = line.split(/\s+/);
    const kw = toks[0];

    if (kw === "v") {
      // "v x y z [w]" — w ignored
      coords.push(Number(toks[1]) || 0, Number(toks[2]) || 0, Number(toks[3]) || 0);
    } else if (kw === "f") {
      addCell(POLYGON, toks.slice(1));
    } else if (kw === "l") {
      addCell(POLY_LINE, toks.slice(1));
    } else if (kw === "p") {
      addCell(POLY_VERTEX, toks.slice(1));
    } else if (kw === "g" || kw === "o") {
      current = groupFor(toks.slice(1).join(" ") || "default");
    }
    // vt / vn / mtllib / usemtl / s — ignored
  }

  // Build one set of blocks per group, keeping entity ids globally sequential
  const blocks: EntityBlock[] = [];
  let nextId = 1;
  for (const g of groups) {
    const result = buildBlocksFromOffsets(
      g.types,
      g.offsets,
      g.connectivity,
      diagnostics,
      nextId
    );
    nextId = result.nextEntityId;
    for (const blk of result.blocks) {
      blocks.push({
        ...blk,
        name: result.blocks.length === 1 ? g.name : `${g.name}/${blk.name}`,
      });
    }
  }

  return finalizeModel({
    nodeCount: coords.length / 3,
    coords: new Float32Array(coords),
    blocks,
    fields: [],
    diagnostics,
  });
}
