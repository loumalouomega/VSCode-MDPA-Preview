/**
 * MdpaModel → VTK XML multiblock (`.vtm`), the inverse of
 * vtkMultiblock.ts's `parseVtm`.
 *
 * A `.vtm` is an index file plus one `.vtu` per dataset, so this returns the
 * index text plus the datasets as companions — the same
 * `MeshWriteResult` shape the XDMF/GiD writers use, and every caller of
 * `writeMeshFileAsync` already writes companions beside the destination.
 *
 * Partition rule: one dataset per TOP-LEVEL SubModelPart (its whole subtree,
 * sliced via `extractSubModelPart`), plus one for geometry claimed by no part.
 * The index mirrors each part's own slash path as nested `<Block>`s, so a
 * re-parse reproduces the same SubModelPart paths `parseVtm` produced — which
 * round-trips exactly for the flat part lists `parseVtm` itself emits.
 *
 * Two fidelity notes, both reported as diagnostics rather than hidden:
 *  - A `.vtu` carries no grouping, so NESTED children of a top-level part
 *    collapse into that part's dataset (their cells are all there; only the
 *    inner grouping is lost).
 *  - Constraints/Properties never survive: `writeVtu` writes points, cells
 *    and fields only, like every other non-`.mdpa` export.
 *
 * Pure module: no vscode / DOM / fs imports.
 */

import { EntityKind, MdpaDiagnostic, MdpaModel, SubModelPart } from "../types";
import {
  extractSubModelPart,
  rebuildNodeArrays,
  sliceBlock,
  sliceField,
} from "../subModelPartExtract";
import { writeVtu } from "./vtkXmlWriter";

const encoder = new TextEncoder();

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** One child dataset: its path in the index tree and its `.vtu` bytes. */
export interface VtmDataset {
  /** Slash-joined block path, e.g. `"Solids/Left"` — mirrors `VtmDataSet.path`. */
  path: string;
  /** Flat companion filename beside the `.vtm`, e.g. `"case_Solids_Left.vtu"`. */
  file: string;
  data: Uint8Array;
}

export interface VtmWriteResult {
  /** The `.vtm` index text (the `data` half of `MeshWriteResult`). */
  index: string;
  datasets: VtmDataset[];
}

/** Filename-safe: path separators flattened, the rest kept. */
function sanitizeStem(s: string): string {
  return s.replace(/[^\w.-]+/g, "_");
}

/** Recursively unions a part list's (subtree-included) ids per entity kind. */
function collectClaimed(parts: SubModelPart[]): {
  elements: Set<number>;
  conditions: Set<number>;
  geometries: Set<number>;
  nodes: Set<number>;
} {
  const claimed = {
    elements: new Set<number>(),
    conditions: new Set<number>(),
    geometries: new Set<number>(),
    nodes: new Set<number>(),
  };
  const walk = (p: SubModelPart): void => {
    for (const id of p.elementIds) claimed.elements.add(id);
    for (const id of p.conditionIds) claimed.conditions.add(id);
    for (const id of p.geometryIds) claimed.geometries.add(id);
    for (const id of p.nodeIds) claimed.nodes.add(id);
    for (const c of p.children) walk(c);
  };
  for (const p of parts) walk(p);
  return claimed;
}

function claimedForKind(
  claimed: ReturnType<typeof collectClaimed>,
  kind: EntityKind
): Set<number> {
  return kind === "Elements"
    ? claimed.elements
    : kind === "Conditions"
      ? claimed.conditions
      : claimed.geometries;
}

/**
 * The geometry no top-level part claims, as a standalone model — or undefined
 * when every block row belongs to some part and every node is listed by one.
 * Mirrors `extractSubModelPart`'s slicing (same helpers, same id-preserving
 * shape) so the leftover dataset is built by the same rules as the per-part
 * ones. Carries no SubModelParts of its own: the READER creates the dataset's
 * part on parse, so writing one here would nest it.
 */
function extractUnclaimed(model: MdpaModel): MdpaModel | undefined {
  const claimed = collectClaimed(model.subModelParts);
  const blocks: MdpaModel["blocks"] = [];
  for (const block of model.blocks) {
    const keep = new Set<number>();
    const taken = claimedForKind(claimed, block.kind);
    for (let i = 0; i < block.count; i++) {
      if (!taken.has(block.entityIds[i])) keep.add(block.entityIds[i]);
    }
    if (keep.size === 0) continue;
    const sliced = sliceBlock(block, keep);
    if (sliced) blocks.push(sliced);
  }
  // Nodes the unclaimed cells reference, plus nodes no part lists at all.
  const keptNodes = new Set<number>();
  for (const block of blocks) {
    for (const id of block.connectivity) keptNodes.add(id);
  }
  for (let i = 0; i < model.nodeCount; i++) {
    if (!claimed.nodes.has(model.nodeIds[i])) keptNodes.add(model.nodeIds[i]);
  }
  if (blocks.length === 0 && keptNodes.size === 0) return undefined;

  const { nodeIds, coords, bounds } = rebuildNodeArrays(model, keptNodes);
  // A field row survives exactly when its entity does: nodal rows follow the
  // kept nodes, cell rows follow the kept blocks' (already unclaimed) ids.
  const keptByKind = new Map<EntityKind, Set<number>>();
  for (const block of blocks) {
    let set = keptByKind.get(block.kind);
    if (!set) {
      set = new Set<number>();
      keptByKind.set(block.kind, set);
    }
    for (const id of block.entityIds) set.add(id);
  }
  const fields: MdpaModel["fields"] = [];
  for (const field of model.fields) {
    const keep =
      field.kind === "Nodal"
        ? keptNodes
        : field.kind === "Elemental"
          ? (keptByKind.get("Elements") ?? new Set<number>())
          : (keptByKind.get("Conditions") ?? new Set<number>());
    const sliced = sliceField(field, keep);
    if (sliced) fields.push(sliced);
  }
  return {
    nodeCount: nodeIds.length,
    nodeIds,
    coords,
    blocks,
    subModelParts: [],
    meta: [],
    properties: model.properties,
    fields,
    diagnostics: [],
    is3D: model.is3D,
    bounds,
  };
}

interface IndexNode {
  blocks: Map<string, IndexNode>;
  datasets: { name: string; file: string }[];
}

/** Nests dataset entries by their slash path for the index XML. */
function buildIndex(entries: { path: string; file: string }[]): string {
  const root: IndexNode = { blocks: new Map(), datasets: [] };
  for (const e of entries) {
    const segs = e.path.split("/");
    let node = root;
    for (const s of segs.slice(0, -1)) {
      let child = node.blocks.get(s);
      if (!child) {
        child = { blocks: new Map(), datasets: [] };
        node.blocks.set(s, child);
      }
      node = child;
    }
    node.datasets.push({ name: segs[segs.length - 1], file: e.file });
  }
  const lines = [
    `<?xml version="1.0"?>`,
    `<VTKFile type="vtkMultiBlockDataSet" version="1.0" byte_order="LittleEndian">`,
    `  <vtkMultiBlockDataSet>`,
  ];
  const emit = (node: IndexNode, indent: string): void => {
    let index = 0;
    for (const [name, child] of node.blocks) {
      lines.push(`${indent}<Block name="${escapeXml(name)}" index="${index++}">`);
      emit(child, `${indent}  `);
      lines.push(`${indent}</Block>`);
    }
    for (const d of node.datasets) {
      lines.push(
        `${indent}<DataSet index="${index++}" name="${escapeXml(d.name)}" file="${escapeXml(d.file)}"/>`
      );
    }
  };
  emit(root, "    ");
  lines.push(`  </vtkMultiBlockDataSet>`, `</VTKFile>`);
  return lines.join("\n") + "\n";
}

/**
 * Splits `model` into `.vtu` datasets plus the `.vtm` index referencing them.
 * `stem` is the destination stem (no extension); child files sit flat beside
 * the index as `<stem>_<path>.vtu` (`<stem>.vtu` for a part-less model).
 */
export function writeVtm(
  model: MdpaModel,
  stem: string,
  diagnostics: MdpaDiagnostic[] = []
): VtmWriteResult {
  const base = stem.length > 0 ? stem : "out";
  const usedFiles = new Set<string>();
  const usedPaths = new Set<string>();
  const datasets: VtmDataset[] = [];

  const claimFile = (stemmed: string): string => {
    let candidate = stemmed;
    for (let n = 2; usedFiles.has(candidate); n++) {
      candidate = stemmed.replace(/\.vtu$/, `_${n}.vtu`);
    }
    usedFiles.add(candidate);
    return candidate;
  };

  const pushDataset = (sub: MdpaModel, path: string): void => {
    let unique = path;
    for (let n = 2; usedPaths.has(unique); n++) unique = `${path}_${n}`;
    usedPaths.add(unique);
    const file =
      model.subModelParts.length === 0 && datasets.length === 0
        ? claimFile(`${base}.vtu`)
        : claimFile(`${base}_${sanitizeStem(unique)}.vtu`);
    datasets.push({ path: unique, file, data: encoder.encode(writeVtu(sub)) });
  };

  for (const part of model.subModelParts) {
    const sub = extractSubModelPart(model, part.path);
    if (!sub) {
      diagnostics.push({
        line: 0,
        message: `SubModelPart "${part.path}" could not be sliced; skipped in the .vtm.`,
      });
      continue;
    }
    if (part.children.length > 0) {
      diagnostics.push({
        line: 0,
        message:
          `SubModelPart "${part.path}" has ${part.children.length} nested subpart(s); ` +
          `a .vtu carries no grouping, so they collapse into this dataset's cells.`,
      });
    }
    pushDataset(sub, part.path);
  }

  const rest = extractUnclaimed(model);
  if (rest) {
    let path = "Base";
    if (usedPaths.has(path)) {
      diagnostics.push({
        line: 0,
        message: `A SubModelPart is already named "Base"; the unclaimed geometry is written as "Base_2".`,
      });
    }
    for (let n = 2; usedPaths.has(path); n++) path = `Base_${n}`;
    pushDataset(rest, path);
  }

  if (datasets.length === 0) {
    // An empty model: still a valid single-dataset .vtm rather than an error.
    pushDataset(model, base);
    datasets[0].path = base;
  }

  return {
    index: buildIndex(datasets),
    datasets,
  };
}
