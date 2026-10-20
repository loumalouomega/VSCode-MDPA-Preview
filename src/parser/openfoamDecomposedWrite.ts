/**
 * Native decomposed OpenFOAM writer (roadmap item 13, increment D).
 *
 * The WASM binding exposes no decomposed write — upstream's
 * `foam_write_decomposed` is C++-core-only — so a topology edit on a
 * decomposed case is rewritten here, natively, following that function's
 * recipe per processor: the processor's faces (internal first, then the real
 * patches in global order, then one `processor` patch per neighbour), points
 * in global ascending order, owner/neighbour, the four addressing lists, and
 * zones on every processor (empty where it has no member).
 *
 * Parities and divergences, all measured against upstream's
 * `foam_write_decomposed` and OpenFOAM's `decomposePar` layout:
 * - Face order, `procBoundary{proc}to{other}` names, the processor extras
 *   block, signed 1-based `faceProcAddressing` (negative = written from the
 *   neighbour side), global-order points, and `-1` for processor patches in
 *   `boundaryProcAddressing` all mirror upstream.
 * - `flipMap` is omitted from faceZones exactly like upstream (its reader
 *   never reads it).
 * - Zero-face global patches are replicated empty in every processor,
 *   upstream parity.
 * - Real-patch types and dictionaries are KEPT from the case (upstream clears
 *   extras); a type without its dictionaries still downgrades, the
 *   single-region rule.
 *
 * Pure (no fs): takes the edited model and per-processor owned global cells.
 * Everything is addressed by entity id, never by position, so no mesh order
 * is assumed beyond the global enumerations built here. Throws with a
 * refusal-ready message when the model cannot be decomposed (surface
 * elements, unmappable conditions); the planner turns the throw into a
 * refusal.
 */

import { FACETS } from "./meshioRegions";
import { MESHIO_TO_VTK_ORDER, VTK_TO_MESHIO_TYPE } from "./meshioFormats";
import { volumeCellIdsInWriteOrder } from "./openfoamFieldWrite";
import { leafPatchParts } from "./openfoamWrite";
import type { MdpaDiagnostic, MdpaModel, SubModelPart } from "./types";
import { buildCellLayout, cellCategory, type CellLayout } from "./writers/writerCommon";

/** One global face with its adjacency and owner-oriented ring. */
export interface DecomposedFace {
  owner: number;
  neighbour?: number;
  /** Global point indices, oriented outward from the owner. */
  ring: number[];
}

const keyOf = (nodes: readonly number[]): string => [...nodes].sort((a, b) => a - b).join(",");

/** Reverse a face ring the OpenFOAM way: the first point stays. */
function reverseRing(ring: number[]): number[] {
  return [ring[0], ...ring.slice(1).reverse()];
}

/** `procBoundary{proc}to{other}`, upstream's processor-patch name. */
export function processorPatchName(proc: number, other: number): string {
  return `procBoundary${proc}to${other}`;
}

const PROCESSOR_EXTRA = (proc: number, other: number): string =>
  "        inGroups        List<word> 1(processor);\n" +
  "        matchTolerance  0.0001;\n" +
  "        transform       unknown;\n" +
  `        myProcNo        ${proc};\n` +
  `        neighbProcNo    ${other};\n`;

const headerFor = (cls: string, object: string): string =>
  "FoamFile\n{\n    version     2.0;\n    format      ascii;\n" +
  `    class       ${cls};\n    location    "constant/polyMesh";\n    object      ${object};\n}\n\n`;

const pointsText = (points: [number, number, number][]): string =>
  `${headerFor("vectorField", "points")}${points.length}\n(\n` +
  points.map((p) => `(${String(p[0])} ${String(p[1])} ${String(p[2])})`).join("\n") +
  (points.length > 0 ? "\n" : "") +
  ")\n";

const facesText = (rings: number[][]): string =>
  `${headerFor("faceList", "faces")}${rings.length}\n(\n` +
  rings.map((r) => `${r.length}(${r.join(" ")})`).join("\n") +
  (rings.length > 0 ? "\n" : "") +
  ")\n";

const labelsText = (cls: string, object: string, values: number[]): string =>
  `${headerFor(cls, object)}${values.length}\n(\n` +
  values.map((v) => `${v}`).join("\n") +
  (values.length > 0 ? "\n" : "") +
  ")\n";

const pad = (k: string): string => k.padEnd(16, " ");

interface BoundaryPatch {
  name: string;
  type: string;
  extra: string;
  nFaces: number;
  startFace: number;
}

const boundaryText = (patches: BoundaryPatch[]): string =>
  "FoamFile\n{\n    version     2.0;\n    format      ascii;\n" +
  '    class       polyBoundaryMesh;\n    location    "constant/polyMesh";\n    object      boundary;\n}\n\n' +
  `${patches.length}\n(\n` +
  patches
    .map(
      (p) =>
        `    ${p.name}\n    {\n        ${pad("type")}${p.type};\n${p.extra}` +
        `        ${pad("nFaces")}${p.nFaces};\n        ${pad("startFace")}${p.startFace};\n    }`
    )
    .join("\n") +
  (patches.length > 0 ? "\n" : "") +
  ")\n";

const zoneFileObject = (listClass: string): string =>
  listClass === "cellZoneList" ? "cellZones" : listClass === "faceZoneList" ? "faceZones" : "pointZones";

const zoneText = (
  listClass: string,
  zoneType: string,
  labelKey: string,
  zones: { name: string; ids: number[] }[]
): string => {
  let out =
    "FoamFile\n{\n    version     2.0;\n    format      ascii;\n" +
    `    class       ${listClass};\n    location    "constant/polyMesh";\n    object      ${zoneFileObject(listClass)};\n}\n\n` +
    `${zones.length}\n(\n`;
  for (const z of zones) {
    out +=
      `${z.name}\n{\n    type ${zoneType};\n` +
      `    ${labelKey} List<label>\n    ${z.ids.length}\n    (\n` +
      z.ids.map((id) => `    ${id}`).join("\n") +
      (z.ids.length > 0 ? "\n" : "") +
      "    );\n}\n";
  }
  return out + ")\n";
};

/**
 * The global volume order and faces of a model about to be decomposed.
 * Volume cells are the Elements cells of volume category, in layout order;
 * every face is keyed by sorted global point indices with its owner-oriented
 * ring. A face claimed by three or more cells is reported and owned by the
 * first two (OpenFOAM cannot represent it).
 */
export function decomposeGlobalFaces(
  model: MdpaModel,
  layout: CellLayout,
  diagnostics: MdpaDiagnostic[]
): { cells: number[]; globalOfEntity: Map<number, number>; faces: DecomposedFace[]; serialOfKey: Map<string, number> } {
  // Writer order, shared with the field rows (volumeCellIdsInWriteOrder):
  // the same helper and model, so rows and cells align by construction.
  // Layout-skipped cells (unknown type, dangling nodes) cannot be addressed
  // and would corrupt the decomposition, so they refuse loudly here.
  const order = volumeCellIdsInWriteOrder(model);
  const cells: number[] = [];
  const globalOfEntity = new Map<number, number>();
  order.forEach((id, g) => {
    const ci = layout.elementIdToCell.get(id);
    if (ci === undefined) throw new Error(`Cannot decompose element ${id}: it has no writable cell, so addressing would corrupt the case.`);
    globalOfEntity.set(id, g);
    cells.push(ci);
  });
  const faces: DecomposedFace[] = [];
  const serialOfKey = new Map<string, number>();
  const seenBy = new Map<string, number[]>();
  cells.forEach((ci, g) => {
    const cell = layout.cells[ci];
    const meshioType = VTK_TO_MESHIO_TYPE[cell.type];
    const table = meshioType ? FACETS[meshioType] : undefined;
    if (!table) throw new Error(`Cannot decompose cells of VTK type ${cell.type}: no facet table, so their faces are unwritable.`);
    const perm = meshioType ? MESHIO_TO_VTK_ORDER[meshioType] : undefined;
    for (const def of table) {
      const ring = def.nodes.map((p) => cell.nodes[perm ? perm[p] : p]);
      if (ring.some((n) => n === undefined)) throw new Error(`Cannot decompose cells of VTK type ${cell.type}: dangling node in a face.`);
      const key = keyOf(ring);
      const serial = serialOfKey.get(key);
      if (serial === undefined) {
        serialOfKey.set(key, faces.length);
        faces.push({ owner: g, ring });
        seenBy.set(key, [g]);
      } else {
        const owners = seenBy.get(key)!;
        if (owners.length === 1) {
          owners.push(g);
          faces[serial].neighbour = g;
        } else {
          diagnostics.push({ line: 0, message: "A face is shared by more than two cells; only the first two own it in the decomposed rewrite." });
        }
      }
    }
  });
  return { cells, globalOfEntity, faces, serialOfKey };
}

export interface DecomposedWriteOptions {
  /** Processor numbers, ascending; owned[i] belongs to processors[i]. */
  processors: number[];
  /** Owned global volume-cell indices per processor, any order. */
  owned: number[][];
  patchTypes: Record<string, string>;
  patchDictionaries: Record<string, string>;
}

interface LocalFace {
  serial: number;
  owner: number;
  neighbour?: number;
  ring: number[];
  flipped: boolean;
}

const KEYLESS_PATCH_TYPES = new Set(["patch", "wall", "empty", "symmetry", "symmetryPlane"]);

/**
 * Writes every processor's `constant/polyMesh` (points, faces, owner,
 * neighbour, boundary, the four addressing lists, zone files) for the
 * already-partitioned model. Returns the case-relative `processorN/...`
 * files plus `localCells`: each processor's local cell positions mapped to
 * global volume indices (writer order), so the planner slices field rows
 * without re-deriving any order.
 */
export function writeDecomposedProcessors(
  model: MdpaModel,
  opts: DecomposedWriteOptions,
  diagnostics: MdpaDiagnostic[]
): {
  files: { name: string; data: Uint8Array }[];
  /** Local cell positions to global volume indices, per processor. */
  localCells: number[][];
  /** Processor patch names with faces, per processor. */
  procPatches: string[][];
} {
  const layout = buildCellLayout(model, diagnostics);
  for (const b of model.blocks) {
    if (b.kind === "Elements" && b.count > 0 && cellCategory(b.vtkCellType) !== "volume") {
      throw new Error(`Surface element block "${b.name}" cannot be decomposed; use Export or Save As… instead.`);
    }
  }
  const { cells, globalOfEntity, faces } = decomposeGlobalFaces(model, layout, diagnostics);
  if (cells.length === 0) throw new Error("The mesh has no volume cells to decompose.");
  // Every global cell exactly once: ghosts and drops both corrupt addressing.
  const ownerOf = new Array<number>(cells.length).fill(-1);
  opts.owned.forEach((set, i) => {
    for (const g of set) {
      if (g < 0 || g >= cells.length || ownerOf[g] !== -1) {
        throw new Error("The re-partition does not cover the mesh exactly once; nothing was written.");
      }
      ownerOf[g] = i;
    }
  });
  if (ownerOf.some((o) => o === -1)) throw new Error("The re-partition leaves cells unowned; nothing was written.");

  // Conditions by node set, for matching global-boundary faces to patches.
  const condNodes = new Map<number, number[]>();
  for (const b of model.blocks) {
    if (b.kind !== "Conditions") continue;
    for (let c = 0; c < b.count; c++) {
      const flat = layout.conditionIdToCell.get(b.entityIds[c]);
      if (flat !== undefined) condNodes.set(b.entityIds[c], layout.cells[flat].nodes);
    }
  }
  const keySerial = new Map<string, number>();
  faces.forEach((f, s) => keySerial.set(keyOf(f.ring), s));
  const boundarySerials = new Set<number>();
  faces.forEach((f, s) => {
    if (f.neighbour === undefined) boundarySerials.add(s);
  });
  // Patch-qualified parts: named in patchTypes, or holding only
  // global-boundary faces (a face zone is recognized by an interior face —
  // the same rule as the single-region zone emission, so the upstream
  // inlet-style misassignment cannot zone a patch here either).
  const patchSerials = new Map<number, string>();
  const claimed = new Set<number>();
  const matchPart = (part: SubModelPart): number[] => {
    const serials: number[] = [];
    for (const id of part.conditionIds) {
      const nodes = condNodes.get(id);
      if (!nodes) continue;
      const serial = keySerial.get(keyOf(nodes));
      if (serial === undefined || !boundarySerials.has(serial) || claimed.has(serial)) continue;
      claimed.add(serial);
      serials.push(serial);
    }
    return serials;
  };
  const patchGroups: { name: string; serials: number[] }[] = [];
  const leafParts = leafPatchParts(model.subModelParts);
  for (const part of leafParts) {
    if (opts.patchTypes[part.path] === undefined && opts.patchTypes[part.name] === undefined) continue;
    const serials = matchPart(part);
    patchGroups.push({ name: part.name, serials });
  }
  for (const part of leafParts) {
    if (patchGroups.some((g) => g.name === part.name)) continue;
    if (part.conditionIds.length === 0) continue;
    const serials = matchPart(part);
    if (serials.length === 0) continue;
    patchGroups.push({ name: part.name, serials });
  }
  const patchOfSerial = new Map<number, string>();
  for (const g of patchGroups) for (const s of g.serials) patchOfSerial.set(s, g.name);
  // Global patch order: groups in part order, then patchTypes-only names
  // (a patch with no faces replicates empty in every processor).
  const globalPatchNames: string[] = [...patchGroups.map((g) => g.name)];
  for (const name of Object.keys(opts.patchTypes)) {
    if (!globalPatchNames.includes(name)) globalPatchNames.push(name);
  }

  // Zone classification, same three rules as the single-region zone emission:
  // element parts (no children) -> cell zones, node-only parts -> point
  // zones, condition parts with an interior face -> face zones. Patch-named
  // parts never zone.
  interface ZoneDef {
    name: string;
    kind: "cell" | "point" | "face";
    cells?: number[];
    points?: number[];
    serials?: number[];
  }
  const zones: ZoneDef[] = [];
  const nodeIndex = new Map<number, number>();
  model.nodeIds.forEach((id, i) => nodeIndex.set(id, i));
  const walkZones = (part: SubModelPart): void => {
    if (part.children.length > 0) {
      if (part.elementIds.length > 0 || part.conditionIds.length > 0 || part.nodeIds.length > 0) {
        diagnostics.push({
          line: 0,
          message: `SubModelPart "${part.path}" has children; only its children are considered for OpenFOAM zones.`,
        });
      }
      for (const c of part.children) walkZones(c);
      return;
    }
    // Dotted like the kernel path, so nested names survive the same way;
    // the multi-region merge strips the wrapper's own prefix on the way
    // back in (see mergeMesh.ts), which is what fixpoints the round trip.
    const zoneName = part.path.replace(/\//g, ".");
    if (part.elementIds.length > 0) {
      const members: number[] = [];
      for (const id of part.elementIds) {
        const g = globalOfEntity.get(id);
        if (g !== undefined) members.push(g);
      }
      if (members.length > 0) zones.push({ name: zoneName, kind: "cell", cells: members });
      return;
    }
    if (part.conditionIds.length === 0) {
      const members: number[] = [];
      for (const id of part.nodeIds) {
        const i = nodeIndex.get(id);
        if (i !== undefined) members.push(i);
      }
      if (members.length > 0) zones.push({ name: zoneName, kind: "point", points: members });
      return;
    }
    if (opts.patchTypes[part.path] !== undefined || opts.patchTypes[part.name] !== undefined) return;
    const serials: number[] = [];
    let interior = false;
    for (const id of part.conditionIds) {
      const nodes = condNodes.get(id);
      if (!nodes) continue;
      const serial = keySerial.get(keyOf(nodes));
      if (serial === undefined) continue;
      serials.push(serial);
      if (!boundarySerials.has(serial)) interior = true;
    }
    if (interior && serials.length > 0) zones.push({ name: zoneName, kind: "face", serials });
  };
  for (const p of model.subModelParts) walkZones(p);
  const hasZoneKind = (kind: ZoneDef["kind"]): boolean => zones.some((z) => z.kind === kind);

  const enc = new TextEncoder();
  const out: { name: string; data: Uint8Array }[] = [];
  const localCells: number[][] = [];
  const procPatches: string[][] = [];
  const emit = (proc: number, base: string, text: string): void => {
    out.push({ name: `processor${proc}/constant/polyMesh/${base}`, data: enc.encode(text) });
  };
  const patchEntry = (name: string): { type: string; extra: string } => {
    const t = opts.patchTypes[name];
    if (!t) return { type: "patch", extra: "" };
    if (KEYLESS_PATCH_TYPES.has(t)) return { type: t, extra: "" };
    const extra = opts.patchDictionaries[name];
    if (extra === undefined) {
      diagnostics.push({ line: 0, message: `OpenFOAM: patch "${name}" (${t}) has no dictionary to keep, so its type downgraded to "patch".` });
      return { type: "patch", extra: "" };
    }
    const partner = /\bneighbourPatch\s+("?)([^\s";]+)\1\s*;/.exec(extra)?.[2];
    if (partner !== undefined && !globalPatchNames.includes(partner)) {
      diagnostics.push({ line: 0, message: `OpenFOAM: patch "${name}" (${t}: neighbourPatch "${partner}" is not in the output), so its type downgraded to "patch".` });
      return { type: "patch", extra: "" };
    }
    const extraText = extra
      .split("\n")
      .map((st) => `        ${st}\n`)
      .join("");
    return { type: t, extra: extraText };
  };

  opts.processors.forEach((proc, pi) => {
    const owned = new Set(opts.owned[pi]);
    const localOfCell = new Map<number, number>();
    const cellAddr: number[] = [];
    cells.forEach((_, g) => {
      if (owned.has(g)) {
        localOfCell.set(g, cellAddr.length);
        cellAddr.push(g);
      }
    });
    localCells.push([...cellAddr]);
    // Faces with exactly one local cell: global-boundary ones keep their
    // patch, interface ones become processor patches.
    const internal: LocalFace[] = [];
    const boundary: LocalFace[] = [];
    faces.forEach((f, s) => {
      const oLocal = localOfCell.has(f.owner);
      const nLocal = f.neighbour !== undefined && localOfCell.has(f.neighbour);
      if (oLocal && nLocal) {
        internal.push({
          serial: s,
          owner: localOfCell.get(f.owner)!,
          neighbour: localOfCell.get(f.neighbour!)!,
          ring: f.ring,
          flipped: false,
        });
      } else if (oLocal || nLocal) {
        const fromOwner = oLocal;
        boundary.push({
          serial: s,
          owner: localOfCell.get(fromOwner ? f.owner : f.neighbour!)!,
          ring: fromOwner ? f.ring : reverseRing(f.ring),
          flipped: !fromOwner,
        });
      }
    });
    // Points used, in global ascending order (upstream parity).
    const used = new Set<number>();
    for (const lf of [...internal, ...boundary]) for (const n of lf.ring) used.add(n);
    const pointAddr: number[] = [...used].sort((a, b) => a - b);
    const localOfPoint = new Map<number, number>();
    pointAddr.forEach((g, l) => localOfPoint.set(g, l));
    const localRing = (lf: LocalFace): number[] => lf.ring.map((g) => localOfPoint.get(g)!);
    const allFaces = [...internal, ...boundary];

    // Boundary regroup: real patches in global order (even empty, upstream
    // parity), processor patches by ascending neighbour, the rest default.
    const byPatch = new Map<string, LocalFace[]>();
    const byProc = new Map<number, LocalFace[]>();
    const defaulted: LocalFace[] = [];
    for (const lf of boundary) {
      const patch = patchOfSerial.get(lf.serial);
      if (patch !== undefined) {
        const list = byPatch.get(patch) ?? [];
        list.push(lf);
        byPatch.set(patch, list);
        continue;
      }
      const f = faces[lf.serial];
      if (f.neighbour === undefined) {
        defaulted.push(lf);
        continue;
      }
      const other = ownerOf[f.owner] === pi ? ownerOf[f.neighbour] : ownerOf[f.owner];
      const list = byProc.get(other) ?? [];
      list.push(lf);
      byProc.set(other, list);
    }
    interface OutPatch {
      name: string;
      type: string;
      extra: string;
      faces: LocalFace[];
      global?: number;
    }
    const outPatches: OutPatch[] = [];
    procPatches.push(
      [...byProc.keys()].sort((a, b) => a - b).map((o) => processorPatchName(proc, opts.processors[o]))
    );
    for (const name of globalPatchNames) {
      const faces = [...(byPatch.get(name) ?? [])];
      // Unmatched boundary faces join the global defaultFaces when it
      // exists, instead of a second entry corrupting the patch ranges.
      if (name === "defaultFaces") faces.push(...defaulted);
      outPatches.push({ name, ...patchEntry(name), faces, global: globalPatchNames.indexOf(name) });
    }
    if (defaulted.length > 0 && !globalPatchNames.includes("defaultFaces")) {
      outPatches.push({ name: "defaultFaces", type: "patch", extra: "", faces: defaulted });
    }
    const boundaryAddr: number[] = [];
    let start = internal.length;
    const finalPatches: BoundaryPatch[] = [];
    for (const p of outPatches) {
      finalPatches.push({ name: p.name, type: p.type, extra: p.extra, nFaces: p.faces.length, startFace: start });
      start += p.faces.length;
      boundaryAddr.push(p.global ?? -1);
    }
    for (const other of [...byProc.keys()].sort((a, b) => a - b)) {
      const name = processorPatchName(proc, opts.processors[other]);
      finalPatches.push({
        name,
        type: "processor",
        extra: PROCESSOR_EXTRA(proc, opts.processors[other]),
        nFaces: byProc.get(other)!.length,
        startFace: start,
      });
      start += byProc.get(other)!.length;
      boundaryAddr.push(-1);
    }
    // Faces file order follows the boundary regroup: internal, then patches.
    const orderedFaces: LocalFace[] = [
      ...internal,
      ...outPatches.flatMap((p) => p.faces),
      ...[...byProc.keys()].sort((a, b) => a - b).flatMap((o) => byProc.get(o)!),
    ];
    emit(proc, "points", pointsText(pointAddr.map((g) => [model.coords[3 * g], model.coords[3 * g + 1], model.coords[3 * g + 2]])));
    emit(proc, "faces", facesText(orderedFaces.map(localRing)));
    emit(
      proc,
      "owner",
      labelsText("labelList", "owner", orderedFaces.map((lf) => lf.owner))
    );
    // neighbour covers the internal run only (OpenFOAM convention).
    const internalOrdered = orderedFaces.slice(0, internal.length);
    emit(
      proc,
      "neighbour",
      labelsText("labelList", "neighbour", internalOrdered.map((lf) => lf.neighbour!))
    );
    emit(proc, "boundary", boundaryText(finalPatches));
    emit(proc, "pointProcAddressing", labelsText("labelList", "pointProcAddressing", pointAddr));
    emit(proc, "cellProcAddressing", labelsText("labelList", "cellProcAddressing", cellAddr));
    emit(
      proc,
      "faceProcAddressing",
      labelsText(
        "labelList",
        "faceProcAddressing",
        orderedFaces.map((lf) => (lf.flipped ? -(lf.serial + 1) : lf.serial + 1))
      )
    );
    emit(proc, "boundaryProcAddressing", labelsText("labelList", "boundaryProcAddressing", boundaryAddr));
    // Zones on every processor (empty where it has none), upstream parity;
    // a kind the model has nowhere is not emitted at all.
    const localFaceOfSerial = new Map<number, number>();
    orderedFaces.forEach((lf, l) => localFaceOfSerial.set(lf.serial, l));
    if (hasZoneKind("cell")) {
      emit(
        proc,
        "cellZones",
        zoneText(
          "cellZoneList",
          "cellZone",
          "cellLabels",
          zones
            .filter((z) => z.kind === "cell")
            .map((z) => ({ name: z.name, ids: z.cells!.filter((g) => localOfCell.has(g)).map((g) => localOfCell.get(g)!) }))
        )
      );
    }
    if (hasZoneKind("point")) {
      emit(
        proc,
        "pointZones",
        zoneText(
          "pointZoneList",
          "pointZone",
          "pointLabels",
          zones
            .filter((z) => z.kind === "point")
            .map((z) => ({ name: z.name, ids: z.points!.filter((g) => localOfPoint.has(g)).map((g) => localOfPoint.get(g)!) }))
        )
      );
    }
    if (hasZoneKind("face")) {
      emit(
        proc,
        "faceZones",
        zoneText(
          "faceZoneList",
          "faceZone",
          "faceLabels",
          zones
            .filter((z) => z.kind === "face")
            .map((z) => ({
              name: z.name,
              ids: z.serials!.filter((s) => localFaceOfSerial.has(s)).map((s) => localFaceOfSerial.get(s)!),
            }))
        )
      );
    }
  });
  return { files: out.map((f) => ({ name: f.name, data: f.data })), localCells, procPatches };
}
