/**
 * VTK XML multiblock (.vtm) support: parses the Block/DataSet index and
 * merges the referenced dataset files into one MdpaModel.  Each DataSet
 * becomes a SubModelPart (so the outline shows the block tree) and its
 * EntityBlocks are prefixed with the block path.
 *
 * The child-file parser is injected (the dispatcher passes parseMeshFile),
 * which keeps this module free of a circular import and lets children be any
 * supported VTK XML format.
 *
 * `mergeChildDatasets` (roadmap item 3) is the shared merge core `.pvd`
 * (pvdIndex.ts / meshFileParser.ts) also uses: same node/entity offsetting,
 * same field concatenation by (kind, variable), same path-escape guard —
 * factored out rather than duplicated, since a fix to one shape (say, the
 * inconsistent-component-count diagnostic) must not silently miss the other.
 * `.vtm`'s own behaviour and tests are unchanged by the factoring.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  EntityBlock,
  FieldBlockKind,
  FieldData,
  MdpaDiagnostic,
  MdpaModel,
  SubModelPart,
} from "./types";
import { finalizeModel } from "./modelBuilder";
import { findFirst, parseVtkXmlFile, XmlEl } from "./vtkXmlCore";

export interface VtmDataSet {
  /** Slash-joined block path, e.g. "Solids/Left". */
  path: string;
  /** File reference as written in the .vtm (relative to the .vtm directory). */
  file: string;
}

/** Parses the .vtm index: every <DataSet> with its Block-path. Pure. */
export function parseVtmIndex(buf: Buffer): VtmDataSet[] {
  const file = parseVtkXmlFile(buf);
  const rootBlock =
    findFirst(file.root, "vtkMultiBlockDataSet") ?? file.root;

  const out: VtmDataSet[] = [];
  const walk = (el: XmlEl, prefix: string[]): void => {
    for (const child of el.children) {
      if (child.tag === "Block") {
        const name = child.attrs.name ?? `Block_${child.attrs.index ?? prefix.length}`;
        walk(child, [...prefix, name]);
      } else if (child.tag === "DataSet") {
        if (!child.attrs.file) continue;
        const name = child.attrs.name ?? `DataSet_${child.attrs.index ?? out.length}`;
        out.push({ path: [...prefix, name].join("/"), file: child.attrs.file });
      }
    }
  };
  walk(rootBlock, []);
  return out;
}

interface StagingField {
  kind: FieldBlockKind;
  variable: string;
  components: number;
  ids: number[];
  values: number[];
}

export interface MergedDatasets {
  coords: number[];
  blocks: EntityBlock[];
  subModelParts: SubModelPart[];
  fields: FieldData[];
}

/**
 * One item to merge: a SubModelPart-tree `path` (may contain `/` for
 * nesting) and a `file` reference resolved relative to `baseDir`.
 */
export interface MergeInput {
  path: string;
  file: string;
}

/**
 * Merges N already-referenced dataset files into one set of nodes/blocks/
 * parts/fields, node- and entity-id offsetting each child in turn. An item
 * whose resolved path escapes `baseDir`, or that fails to parse, is skipped
 * with a diagnostic rather than aborting the whole merge — the same
 * tolerance `mergeMesh.ts` applies to an unreadable source file.
 */
export async function mergeChildDatasets(
  items: readonly MergeInput[],
  baseDir: string,
  parseChild: (childFsPath: string) => Promise<MdpaModel>,
  diagnostics: MdpaDiagnostic[]
): Promise<MergedDatasets> {
  const coords: number[] = [];
  const blocks: EntityBlock[] = [];
  const subModelParts: SubModelPart[] = [];
  const fieldMap = new Map<string, StagingField>();
  let nodeOffset = 0;
  let entityOffset = 0;

  for (const item of items) {
    const resolved = path.resolve(baseDir, item.file);
    const rel = path.relative(baseDir, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      diagnostics.push({
        line: 0,
        message: `"${item.path}" references a file outside the base directory (${item.file}); skipped.`,
      });
      continue;
    }

    let child: MdpaModel;
    try {
      child = await parseChild(resolved);
    } catch (err) {
      diagnostics.push({
        line: 0,
        message: `Could not parse "${item.path}" (${item.file}): ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    for (const d of child.diagnostics) {
      diagnostics.push({ line: d.line, message: `[${item.path}] ${d.message}` });
    }

    // Nodes
    for (let i = 0; i < child.coords.length; i++) coords.push(child.coords[i]);
    const nodeIds = new Int32Array(child.nodeCount);
    for (let i = 0; i < child.nodeCount; i++) nodeIds[i] = nodeOffset + i + 1;

    // Entity blocks, offset and prefixed with the item's path
    const elementIds: number[] = [];
    for (const blk of child.blocks) {
      const entityIds = new Int32Array(blk.entityIds.length);
      for (let i = 0; i < blk.entityIds.length; i++) {
        entityIds[i] = blk.entityIds[i] + entityOffset;
        elementIds.push(entityIds[i]);
      }
      const connectivity = new Int32Array(blk.connectivity.length);
      for (let i = 0; i < blk.connectivity.length; i++) {
        connectivity[i] = blk.connectivity[i] + nodeOffset;
      }
      blocks.push({ ...blk, name: `${item.path}/${blk.name}`, entityIds, connectivity });
    }

    // Fields: same (kind, variable) across items concatenate with offset ids
    for (const f of child.fields) {
      const key = `${f.kind}|${f.variable}`;
      let staged = fieldMap.get(key);
      if (!staged) {
        staged = {
          kind: f.kind,
          variable: f.variable,
          components: f.components,
          ids: [],
          values: [],
        };
        fieldMap.set(key, staged);
      }
      if (staged.components !== f.components) {
        diagnostics.push({
          line: 0,
          message: `Field "${f.variable}" has inconsistent component counts across blocks; "${item.path}" skipped.`,
        });
        continue;
      }
      const idOffset = f.kind === "Nodal" ? nodeOffset : entityOffset;
      for (let i = 0; i < f.ids.length; i++) staged.ids.push(f.ids[i] + idOffset);
      for (let i = 0; i < f.values.length; i++) staged.values.push(f.values[i]);
    }

    subModelParts.push({
      name: item.path.split("/").pop() ?? item.path,
      nodeIds,
      elementIds: new Int32Array(elementIds),
      conditionIds: new Int32Array(0),
      geometryIds: new Int32Array(0),
      constraintIds: new Int32Array(0),
      path: item.path,
      children: [],
    });

    nodeOffset += child.nodeCount;
    for (const blk of child.blocks) entityOffset += blk.count;
  }

  return {
    coords,
    blocks,
    subModelParts,
    fields: [...fieldMap.values()].map((f) => ({
      kind: f.kind,
      variable: f.variable,
      components: f.components,
      ids: new Int32Array(f.ids),
      values: new Float64Array(f.values),
    })),
  };
}

/**
 * Parses a .vtm and merges every referenced dataset.  Children that fail to
 * parse (or whose resolved path escapes the .vtm's directory tree) are
 * skipped with a diagnostic.
 */
export async function parseVtm(
  fsPath: string,
  parseChild: (childFsPath: string) => Promise<MdpaModel>
): Promise<MdpaModel> {
  const diagnostics: MdpaDiagnostic[] = [];
  const vtmDir = path.dirname(fsPath);
  const buf = await fs.promises.readFile(fsPath);
  const dataSets = parseVtmIndex(buf);
  const merged = await mergeChildDatasets(dataSets, vtmDir, parseChild, diagnostics);

  return finalizeModel({
    nodeCount: merged.coords.length / 3,
    coords: new Float32Array(merged.coords),
    blocks: merged.blocks,
    fields: merged.fields,
    diagnostics,
    subModelParts: merged.subModelParts,
  });
}
