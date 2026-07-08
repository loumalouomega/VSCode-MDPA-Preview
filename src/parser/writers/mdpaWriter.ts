/**
 * MdpaModel → Kratos .mdpa serializer (the inverse of mdpaParser.ts).
 *
 * Node ids and connectivity are written directly (MDPA is id-based, not
 * index-based).  Because the model keeps only a line-count for Properties /
 * ModelPartData / Table blocks (their text is not retained), a lossless Save
 * copies those blocks verbatim from the original source text when provided.
 *
 * Pure module: no vscode / DOM / vtk.js imports.
 */

import { FieldData, MdpaModel, SubModelPart } from "../types";
import { num } from "./writerCommon";

export interface MdpaWriteOptions {
  /** Original .mdpa text — its Properties/ModelPartData/Table blocks are kept. */
  sourceText?: string;
}

const FIELD_BLOCK: Record<FieldData["kind"], string> = {
  Nodal: "NodalData",
  Elemental: "ElementalData",
  Conditional: "ConditionalData",
};

/** Top-level meta blocks copied verbatim from the source on a same-format Save. */
const VERBATIM_BLOCKS = ["ModelPartData", "Properties", "Table"];

/** Extracts `Begin <type> …\n…\nEnd <type>` spans (any header args) from text. */
function extractBlocks(sourceText: string, types: string[]): string[] {
  const lines = sourceText.split(/\r?\n/);
  const out: string[] = [];
  let depth = 0;
  let buf: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    const begin = /^Begin\s+(\w+)/.exec(t);
    if (depth === 0) {
      if (begin && types.includes(begin[1])) {
        depth = 1;
        buf = [line];
      }
      continue;
    }
    buf.push(line);
    if (/^Begin\s+\w+/.test(t)) depth++;
    else if (/^End\b/.test(t)) {
      depth--;
      if (depth === 0) {
        out.push(buf.join("\n"));
        buf = [];
      }
    }
  }
  return out;
}

function writeNodes(model: MdpaModel, lines: string[]): void {
  lines.push("Begin Nodes");
  for (let i = 0; i < model.nodeCount; i++) {
    lines.push(
      `  ${model.nodeIds[i]} ${num(model.coords[i * 3])} ${num(model.coords[i * 3 + 1])} ${num(
        model.coords[i * 3 + 2]
      )}`
    );
  }
  lines.push("End Nodes", "");
}

function writeBlocks(model: MdpaModel, lines: string[]): void {
  for (const block of model.blocks) {
    lines.push(`Begin ${block.kind} ${block.name}`);
    const geom = block.kind === "Geometries";
    for (let c = 0; c < block.count; c++) {
      const conn: number[] = [];
      for (let k = 0; k < block.stride; k++) conn.push(block.connectivity[c * block.stride + k]);
      const id = block.entityIds[c];
      if (geom) {
        lines.push(`  ${id} ${conn.join(" ")}`);
      } else {
        const propId = block.propertyIds ? block.propertyIds[c] : 0;
        lines.push(`  ${id} ${propId} ${conn.join(" ")}`);
      }
    }
    lines.push(`End ${block.kind}`, "");
  }
}

function writeField(field: FieldData, lines: string[]): void {
  const block = FIELD_BLOCK[field.kind];
  const isNodal = field.kind === "Nodal";
  lines.push(`Begin ${block} ${field.variable}`);
  for (let i = 0; i < field.ids.length; i++) {
    const id = field.ids[i];
    if (field.components === 1) {
      const v = num(field.values[i]);
      if (isNodal) {
        const fixed = field.fixed ? field.fixed[i] : 0;
        lines.push(`  ${id} ${fixed} ${v}`);
      } else {
        lines.push(`  ${id} ${v}`);
      }
    } else {
      const comps: string[] = [];
      for (let k = 0; k < field.components; k++) comps.push(num(field.values[i * field.components + k]));
      const vec = `(${comps.join(",")})`;
      if (isNodal) {
        const fixed = field.fixed ? field.fixed[i] : 0;
        lines.push(`  ${id} ${fixed} ${vec}`);
      } else {
        lines.push(`  ${id} ${vec}`);
      }
    }
  }
  lines.push(`End ${block}`, "");
}

function writeSubModelPart(part: SubModelPart, lines: string[], indent: string): void {
  lines.push(`${indent}Begin SubModelPart ${part.name}`);
  const inner = indent + "  ";
  const list = (tag: string, ids: Int32Array): void => {
    if (ids.length === 0) return;
    lines.push(`${inner}Begin ${tag}`);
    for (const id of ids) lines.push(`${inner}  ${id}`);
    lines.push(`${inner}End ${tag}`);
  };
  list("SubModelPartNodes", part.nodeIds);
  list("SubModelPartElements", part.elementIds);
  list("SubModelPartConditions", part.conditionIds);
  list("SubModelPartGeometries", part.geometryIds);
  list("SubModelPartConstraints", part.constraintIds);
  for (const child of part.children) writeSubModelPart(child, lines, inner);
  lines.push(`${indent}End SubModelPart`);
}

/** Serialises an MdpaModel to Kratos .mdpa text. */
export function writeMdpa(model: MdpaModel, opts: MdpaWriteOptions = {}): string {
  const lines: string[] = [];

  const preserved = opts.sourceText
    ? extractBlocks(opts.sourceText, VERBATIM_BLOCKS)
    : [];
  if (preserved.length > 0) {
    for (const b of preserved) lines.push(b, "");
  } else {
    lines.push("Begin Properties 0", "End Properties", "");
  }

  writeNodes(model, lines);
  writeBlocks(model, lines);
  for (const field of model.fields) writeField(field, lines);
  for (const part of model.subModelParts) {
    writeSubModelPart(part, lines, "");
    lines.push("");
  }

  return lines.join("\n") + "\n";
}
