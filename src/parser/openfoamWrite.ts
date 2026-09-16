/**
 * Post-write patch recovery for OpenFOAM export.
 *
 * meshio++'s generic registry writer takes no `OpenFoamInfo` side channel, so
 * every case it writes carries a single synthesized `defaultFaces` patch and
 * patch names never round-trip (see `meshioFormats.ts`). This module repairs
 * that locally, right after the write: it re-derives the patches from the
 * model's own leaf SubModelParts and rewrites the `boundary` companion (plus
 * the `faces`/`owner` order it indexes) to name them.
 *
 * How it works:
 *  - Only leaf SubModelParts holding `conditionIds` become patches, in
 *    depth-first tree order. A parent's ids are the union of its children by
 *    construction (`subModelPartTree.ts`), so letting a parent claim would
 *    starve every child; leaves are the finest grouping the tree offers, and
 *    are exactly what `applyOpenFoamPatches` produces on read.
 *  - Written faces are matched to model faces by COORDINATES, never by index:
 *    the writer renumbers points and `modelToMeshio` drops every original id,
 *    so there is no index correspondence to trust. Keys quantize to six
 *    decimals, the precision `seriesSubparts.ts` and the STL welder use.
 *  - Faces are regrouped so each patch's faces are contiguous (OpenFOAM
 *    patches are `startFace`/`nFaces` ranges, so contiguity is mandatory, not
 *    cosmetic). Internal faces keep their positions, so `neighbour` is
 *    untouched; `owner` is reordered alongside `faces`. Unmatched boundary
 *    faces keep a trailing `defaultFaces` remainder, which is exactly today's
 *    output for a mesh with no patch information at all.
 *  - Patch `type`s do not survive on the model (`applyOpenFoamPatches` keeps
 *    names and ids only), so every recovered patch is written as
 *    `type patch;` and the diagnostic says so — guessing `wall`/`empty`
 *    would change the physics (`empty` means 2D).
 *
 * Pure (no vscode/DOM/fs/wasm): companions in, companions out. Anything it
 * cannot parse or match degrades to the writer's own output plus a diagnostic,
 * never a throw and never a half-rewritten case.
 */

import type { MdpaDiagnostic, MdpaModel, SubModelPart } from "./types";
import type { MeshioCompanionFile } from "./meshio";
import { parseOpenFoamBoundary } from "./openfoamCase";

const POLYMESH = "constant/polyMesh";

/** A parsed `<count> ( ... )` OpenFOAM list plus the verbatim header above it. */
interface FoamList {
  /** Everything before the count line, kept to re-emit byte-identical headers. */
  head: string;
  count: number;
  body: string;
}

/**
 * Splits `text` into header / declared count / parenthesised body. The body is
 * sliced from the first `(` after the count line to the LAST `)` in the file,
 * which is the outer close even when entries nest (`4(0 1 2 3)`).
 */
function splitFoamList(text: string): FoamList | undefined {
  const m = /(?:^|\n)(\d+)\r?\n\(\r?\n?/.exec(text);
  if (!m) return undefined;
  const count = parseInt(m[1], 10);
  if (!Number.isInteger(count) || count < 0) return undefined;
  const head = text.slice(0, m.index + (m[0][0] === "\n" ? 1 : 0));
  const bodyStart = m.index + m[0].length;
  const bodyEnd = text.lastIndexOf(")");
  // `>=`: an empty list (`0\n(\n)`) has zero body length, which is valid.
  if (!(bodyEnd >= bodyStart)) return undefined;
  return { head, count, body: text.slice(bodyStart, bodyEnd) };
}

/** Parses a `labelList` body; undefined unless it holds exactly `count` ints. */
function parseLabelList(body: string, count: number): number[] | undefined {
  const toks = body.trim().split(/\s+/).filter((t) => t.length > 0);
  if (toks.length !== count) return undefined;
  const out = toks.map(Number);
  if (out.some((n) => !Number.isInteger(n))) return undefined;
  return out;
}

/** Parses a `faceList` body (`n(i j …)` per face); undefined on any mismatch. */
function parseFaceList(body: string, count: number): number[][] | undefined {
  const rows: number[][] = [];
  const re = /(\d+)\s*\(([^()]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const nums = m[2].trim().split(/\s+/).filter((t) => t.length > 0).map(Number);
    if (nums.length !== parseInt(m[1], 10) || nums.some((n) => !Number.isInteger(n))) {
      return undefined;
    }
    rows.push(nums);
  }
  return rows.length === count ? rows : undefined;
}

/** Parses a `vectorField` body (`(x y z)` per point); undefined on mismatch. */
function parsePointList(body: string, count: number): Array<[number, number, number]> | undefined {
  const rows: Array<[number, number, number]> = [];
  const re = /\(([^()]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const nums = m[1].trim().split(/\s+/).filter((t) => t.length > 0).map(Number);
    if (nums.length !== 3 || nums.some((n) => !Number.isFinite(n))) return undefined;
    rows.push([nums[0], nums[1], nums[2]]);
  }
  return rows.length === count ? rows : undefined;
}

/**
 * Quantizes one coordinate for map keys. The `+ 0` normalizes `-0` to `"0"`:
 * without it two coincident nodes can key differently and the same face never
 * matches itself.
 */
function qc(v: number): string {
  return String(Math.round(v * 1e6) / 1e6 + 0);
}

/** Collects the leaf parts holding conditions, depth-first (tree order). */
function leafPatchParts(parts: SubModelPart[], out: SubModelPart[] = []): SubModelPart[] {
  for (const p of parts) {
    if (p.children.length === 0) {
      if (p.conditionIds.length > 0) out.push(p);
    } else {
      leafPatchParts(p.children, out);
    }
  }
  return out;
}

export interface OpenFoamRewriteResult {
  companions: MeshioCompanionFile[];
  diagnostics: MdpaDiagnostic[];
}

/**
 * Rewrites the `boundary` companion (and the `faces`/`owner` order it
 * indexes) so the model's patch names survive the export. Returns the
 * writer's own companions untouched — plus a diagnostic saying why — whenever
 * there is nothing to recover or anything fails to parse.
 */
export function rewriteOpenFoamPatches(
  companions: MeshioCompanionFile[],
  model: MdpaModel
): OpenFoamRewriteResult {
  const diagnostics: MdpaDiagnostic[] = [];
  const keep = (message: string): OpenFoamRewriteResult => {
    if (message) diagnostics.push({ line: 0, message });
    return { companions, diagnostics };
  };

  const parts = leafPatchParts(model.subModelParts);
  if (parts.length === 0) return { companions, diagnostics };

  const byName = new Map(companions.map((c) => [c.name, c]));
  const textOf = (base: string): string | undefined => {
    const c = byName.get(`${POLYMESH}/${base}`);
    return c ? Buffer.from(c.data).toString("utf8") : undefined;
  };
  const pointsText = textOf("points");
  const facesText = textOf("faces");
  const ownerText = textOf("owner");
  const neighbourText = textOf("neighbour");
  const boundaryText = textOf("boundary");
  if (!pointsText || !facesText || !ownerText || !neighbourText || !boundaryText) {
    return keep(
      "OpenFOAM: a constant/polyMesh companion is missing, so patch names were " +
        'not recovered; a single "defaultFaces" patch was kept.'
    );
  }
  // The one file this rewrite never parses is still gated on encoding: a
  // non-ascii case means a writer whose output shape is unknown here.
  for (const [base, text] of [
    ["points", pointsText],
    ["faces", facesText],
    ["owner", ownerText],
    ["neighbour", neighbourText],
  ] as Array<[string, string]>) {
    if (!/format\s+ascii\s*;/i.test(text)) {
      return keep(
        `OpenFOAM: constant/polyMesh/${base} is not ascii, so patch names were ` +
          'not recovered; a single "defaultFaces" patch was kept.'
      );
    }
  }

  // If a future writer emits real patches, there is nothing to recover — and
  // clobbering them with a coordinate-matched rewrite could only lose data.
  const oldPatches = parseOpenFoamBoundary(boundaryText, []);
  if (oldPatches.filter((p) => !p.synthesized).length > 1) {
    return { companions, diagnostics };
  }

  const points = splitFoamList(pointsText);
  const faces = splitFoamList(facesText);
  const owner = splitFoamList(ownerText);
  const neighbour = splitFoamList(neighbourText);
  const pointRows = points && parsePointList(points.body, points.count);
  const faceRows = faces && parseFaceList(faces.body, faces.count);
  const ownerRows = owner && parseLabelList(owner.body, owner.count);
  const neighbourRows = neighbour && parseLabelList(neighbour.body, neighbour.count);
  if (!points || !faces || !owner || !neighbour || !pointRows || !faceRows || !ownerRows || !neighbourRows) {
    return keep(
      "OpenFOAM: a constant/polyMesh list failed to parse, so patch names were " +
        'not recovered; a single "defaultFaces" patch was kept.'
    );
  }
  if (ownerRows.length !== faceRows.length || neighbourRows.length > faceRows.length) {
    return keep(
      "OpenFOAM: owner/neighbour do not align with faces, so patch names were " +
        'not recovered; a single "defaultFaces" patch was kept.'
    );
  }
  if (faceRows.length === neighbourRows.length) return { companions, diagnostics };

  // Internal faces come first (OpenFOAM convention); only the trailing
  // boundary run is regrouped, so `neighbour` is never touched.
  const internal = neighbourRows.length;
  const claimed = new Set<number>();
  const faceKey = new Map<string, number>();
  for (let f = internal; f < faceRows.length; f++) {
    const pts: string[] = [];
    let ok = true;
    for (const pi of faceRows[f]) {
      const p = pointRows[pi];
      if (!p) {
        ok = false;
        break;
      }
      pts.push(`${qc(p[0])},${qc(p[1])},${qc(p[2])}`);
    }
    if (!ok) continue;
    const key = pts.sort().join("|");
    if (!faceKey.has(key)) faceKey.set(key, f);
  }

  const nodeCoord = new Map<number, [number, number, number]>();
  for (let i = 0; i < model.nodeIds.length; i++) {
    nodeCoord.set(model.nodeIds[i], [
      model.coords[i * 3],
      model.coords[i * 3 + 1],
      model.coords[i * 3 + 2],
    ]);
  }
  const condConn = new Map<number, Int32Array>();
  for (const b of model.blocks) {
    if (b.kind !== "Conditions") continue;
    for (let c = 0; c < b.count; c++) {
      condConn.set(b.entityIds[c], b.connectivity.subarray(c * b.stride, (c + 1) * b.stride));
    }
  }
  const modelKey = (conn: Int32Array): string | undefined => {
    const pts: string[] = [];
    for (const id of conn) {
      const p = nodeCoord.get(id);
      if (!p) return undefined;
      pts.push(`${qc(p[0])},${qc(p[1])},${qc(p[2])}`);
    }
    return pts.sort().join("|");
  };

  const groups: Array<{ part: SubModelPart; faces: number[] }> = [];
  for (const part of parts) {
    const group: number[] = [];
    for (const cid of part.conditionIds) {
      const conn = condConn.get(cid);
      const key = conn === undefined ? undefined : modelKey(conn);
      const idx = key === undefined ? undefined : faceKey.get(key);
      if (idx === undefined || claimed.has(idx)) continue;
      claimed.add(idx);
      group.push(idx);
    }
    if (group.length === 0) {
      diagnostics.push({
        line: 0,
        message:
          `OpenFOAM: SubModelPart "${part.path}" claims ${part.conditionIds.length} ` +
          `condition(s) but none matched a boundary face; skipped.`,
      });
      continue;
    }
    groups.push({ part, faces: group });
  }
  if (groups.length === 0) return { companions, diagnostics };

  const rest: number[] = [];
  for (let f = internal; f < faceRows.length; f++) if (!claimed.has(f)) rest.push(f);
  const order = [...Array(internal).keys(), ...groups.flatMap((g) => g.faces), ...rest];
  const newFaces = order.map((f) => faceRows[f]);
  const newOwner = order.map((f) => ownerRows[f]);

  const entry = (pts: number[]): string => `${pts.length}(${pts.join(" ")})`;
  const facesOut = `${faces.head}${newFaces.length}\n(\n${newFaces.map(entry).join("\n")}\n)\n`;
  const ownerOut = `${owner.head}${newOwner.length}\n(\n${newOwner.join("\n")}\n)\n`;

  const pad = (k: string): string => k.padEnd(16, " ");
  const patches: string[] = [];
  let start = internal;
  for (const g of groups) {
    patches.push(
      `    ${g.part.name}\n    {\n        ${pad("type")}patch;\n        ${pad("nFaces")}${g.faces.length};\n        ${pad("startFace")}${start};\n    }`
    );
    start += g.faces.length;
  }
  if (rest.length > 0) {
    patches.push(
      `    defaultFaces\n    {\n        ${pad("type")}patch;\n        ${pad("nFaces")}${rest.length};\n        ${pad("startFace")}${start};\n    }`
    );
  }
  const boundaryOut =
    "FoamFile\n{\n    version     2.0;\n    format      ascii;\n    class       polyBoundaryMesh;\n" +
    `    location    "${POLYMESH}";\n    object      boundary;\n}\n` +
    `${patches.length}\n(\n${patches.join("\n")}\n)\n`;

  const names = groups.map((g) => g.part.name).join(", ");
  diagnostics.push({
    line: 0,
    message:
      `OpenFOAM: ${groups.length} patch(es) written with recovered names (${names}); ` +
      'patch types defaulted to "patch".',
  });

  const enc = new TextEncoder();
  const replace = (base: string, text: string): MeshioCompanionFile => ({
    name: `${POLYMESH}/${base}`,
    data: enc.encode(text),
  });
  return {
    companions: companions.map((c) => {
      if (c.name === `${POLYMESH}/faces`) return replace("faces", facesOut);
      if (c.name === `${POLYMESH}/owner`) return replace("owner", ownerOut);
      if (c.name === `${POLYMESH}/boundary`) return replace("boundary", boundaryOut);
      return c;
    }),
    diagnostics,
  };
}
