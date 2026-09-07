/**
 * STL parser (ASCII and binary) → MdpaModel.
 *
 * STL repeats every vertex per facet, so vertices are welded through a
 * 6-decimal coordinate key (the same tolerance the VTK subpart merging uses)
 * to recover a shared node list.  Pure module: no vscode/DOM/vtk imports.
 */

import { EntityBlock, MdpaDiagnostic, MdpaModel } from "./types";
import { finalizeModel } from "./modelBuilder";

const TRIANGLE = 5;

class VertexWelder {
  private readonly byKey = new Map<string, number>();
  readonly coords: number[] = [];

  /** Returns the 0-based node index for (x,y,z), welding duplicates. */
  index(x: number, y: number, z: number): number {
    const key = `${x.toFixed(6)},${y.toFixed(6)},${z.toFixed(6)}`;
    let idx = this.byKey.get(key);
    if (idx === undefined) {
      idx = this.coords.length / 3;
      this.byKey.set(key, idx);
      this.coords.push(x, y, z);
    }
    return idx;
  }

  get count(): number {
    return this.coords.length / 3;
  }
}

interface StagingSolid {
  name: string;
  entityIds: number[];
  connectivity: number[]; // 1-based
}

/** Parse an STL file (auto-detects ASCII vs binary) into an MdpaModel. */
export function parseStl(buf: Buffer): MdpaModel {
  const diagnostics: MdpaDiagnostic[] = [];

  if (buf.length === 0) {
    diagnostics.push({ line: 0, message: "Empty STL file." });
    return finalizeModel({
      nodeCount: 0,
      coords: new Float32Array(0),
      blocks: [],
      fields: [],
      diagnostics,
    });
  }

  if (isBinaryStl(buf)) {
    return parseBinary(buf, diagnostics);
  }
  return parseAscii(buf.toString("utf8"), diagnostics);
}

/**
 * Binary detection: the 84-byte header + 50 bytes/facet size equation is
 * checked first because a binary header may legitimately start with "solid".
 * Exported for `meshSummary.ts`, whose binary path reads the same facet
 * count out of the same header rather than re-deriving the test.
 */
export function isBinaryStl(buf: Buffer): boolean {
  if (buf.length >= 84) {
    const count = buf.readUInt32LE(80);
    if (84 + count * 50 === buf.length) return true;
  }
  const head = buf.subarray(0, 1024).toString("latin1");
  if (/^\s*solid\b/.test(head)) return false;
  return true;
}

// ---- ASCII ---------------------------------------------------------------------

function parseAscii(text: string, diagnostics: MdpaDiagnostic[]): MdpaModel {
  const welder = new VertexWelder();
  const solids: StagingSolid[] = [];
  let current: StagingSolid | null = null;
  let facetVerts: number[] = []; // welded 0-based indices of the open facet
  let inFacet = false;
  let gid = 1;
  let lineNum = 0;

  for (const raw of text.split(/\r?\n/)) {
    lineNum++;
    const line = raw.trim();
    if (!line) continue;
    const lower = line.toLowerCase();

    if (lower.startsWith("solid")) {
      const name = line.slice(5).trim();
      current = {
        name: name || `Solid_${solids.length + 1}`,
        entityIds: [],
        connectivity: [],
      };
      solids.push(current);
    } else if (lower.startsWith("endsolid")) {
      current = null;
    } else if (lower.startsWith("facet")) {
      inFacet = true;
      facetVerts = [];
    } else if (lower.startsWith("endfacet")) {
      if (current && facetVerts.length === 3) {
        current.entityIds.push(gid++);
        for (const v of facetVerts) current.connectivity.push(v + 1);
      } else if (facetVerts.length !== 3) {
        diagnostics.push({
          line: lineNum,
          message: `Facet with ${facetVerts.length} vertices skipped (expected 3).`,
        });
      }
      inFacet = false;
      facetVerts = [];
    } else if (lower.startsWith("vertex")) {
      if (inFacet) {
        const parts = line.split(/\s+/);
        const x = Number(parts[1]);
        const y = Number(parts[2]);
        const z = Number(parts[3]);
        if (isNaN(x) || isNaN(y) || isNaN(z)) {
          diagnostics.push({ line: lineNum, message: `Malformed vertex line: ${line}` });
        } else {
          facetVerts.push(welder.index(x, y, z));
        }
      }
    }
    // "outer loop"/"endloop"/normals are structural noise — ignored
  }

  return buildStlModel(welder, solids, diagnostics);
}

// ---- Binary --------------------------------------------------------------------

function parseBinary(buf: Buffer, diagnostics: MdpaDiagnostic[]): MdpaModel {
  const welder = new VertexWelder();
  const declared = buf.length >= 84 ? buf.readUInt32LE(80) : 0;
  const fits = Math.floor(Math.max(buf.length - 84, 0) / 50);
  const nFacets = Math.min(declared, fits);
  if (declared !== fits) {
    diagnostics.push({
      line: 0,
      message: `Binary STL declares ${declared} facet(s) but the file holds ${fits}; using ${nFacets}.`,
    });
  }

  const solid: StagingSolid = { name: "Facets", entityIds: [], connectivity: [] };
  let off = 84;
  for (let f = 0; f < nFacets; f++) {
    off += 12; // skip normal
    const verts: number[] = [];
    for (let v = 0; v < 3; v++) {
      const x = buf.readFloatLE(off);
      const y = buf.readFloatLE(off + 4);
      const z = buf.readFloatLE(off + 8);
      off += 12;
      verts.push(welder.index(x, y, z));
    }
    off += 2; // attribute byte count
    solid.entityIds.push(f + 1);
    for (const v of verts) solid.connectivity.push(v + 1);
  }

  return buildStlModel(welder, nFacets > 0 ? [solid] : [], diagnostics);
}

// ---- Assembly ------------------------------------------------------------------

function buildStlModel(
  welder: VertexWelder,
  solids: StagingSolid[],
  diagnostics: MdpaDiagnostic[]
): MdpaModel {
  const blocks: EntityBlock[] = solids
    .filter((s) => s.entityIds.length > 0)
    .map((s) => ({
      kind: "Elements" as const,
      name: s.name,
      vtkCellType: TRIANGLE,
      count: s.entityIds.length,
      stride: 3,
      entityIds: new Int32Array(s.entityIds),
      propertyIds: undefined,
      connectivity: new Int32Array(s.connectivity),
    }));

  return finalizeModel({
    nodeCount: welder.count,
    coords: new Float32Array(welder.coords),
    blocks,
    fields: [],
    diagnostics,
  });
}
