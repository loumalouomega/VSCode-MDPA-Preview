/**
 * MdpaModel → Kratos .mdpa serializer (the inverse of mdpaParser.ts).
 *
 * Node ids and connectivity are written directly (MDPA is id-based, not
 * index-based).  Because the model keeps only a line-count for Properties /
 * ModelPartData / Table / Constraints blocks (their text is not retained), a
 * lossless Save copies those blocks verbatim from the original source text when
 * provided.
 *
 * The verbatim blocks fall into TWO groups, and the split is load-bearing
 * rather than cosmetic: Properties / ModelPartData / Table are emitted BEFORE
 * `Begin Nodes`, while `Constraints` must be emitted AFTER the nodes and the
 * entity blocks, because Kratos' `ModelPartIO::ReadConstraintsBlock` resolves a
 * constraint's master/slave ids against nodes it has already read.  Putting
 * `Constraints` in the leading group would write a file Kratos cannot read.
 *
 * Pure module: no vscode / DOM / vtk.js imports.
 */

import { FieldData, MdpaModel, SubModelPart } from "../types";
import { num } from "./writerCommon";

export interface MdpaWriteOptions {
  /**
   * Original .mdpa text — its Properties / ModelPartData / Table / Constraints
   * blocks are copied into the output verbatim.
   */
  sourceText?: string;
  /**
   * Called with an advisory message when the output is written but something
   * about it cannot be guaranteed — today, only when `Constraints` blocks are
   * copied verbatim onto a model whose node ids have changed since the source
   * was read.  Never a reason to fail the write: the file is still strictly
   * better than the one that silently omitted the constraints entirely.
   */
  onWarning?: (message: string) => void;
}

const FIELD_BLOCK: Record<FieldData["kind"], string> = {
  Nodal: "NodalData",
  Elemental: "ElementalData",
  Conditional: "ConditionalData",
};

/**
 * Top-level meta blocks copied verbatim from the source on a same-format Save,
 * emitted BEFORE `Begin Nodes`.
 */
const VERBATIM_BLOCKS = ["ModelPartData", "Properties", "Table"];

/**
 * Verbatim blocks that must follow the nodes and the entity blocks — see the
 * module docblock.  `Constraints` (Kratos master/slave constraints, e.g.
 * `Begin Constraints LinearMasterSlaveConstraint DISPLACEMENT_X`) is parsed
 * only as a `MetaBlock` label + line count, so the source text is the only
 * place its contents survive.
 */
const TRAILING_VERBATIM_BLOCKS = ["Constraints"];

/**
 * The node ids declared by the source text's own `Begin Nodes` block.
 *
 * Used to decide whether a verbatim `Constraints` block is still trustworthy: a
 * constraint references node ids, and an operation that renumbers or removes
 * nodes leaves the copied text pointing at ids the written mesh no longer has.
 * Comparing the two node-id SETS is deliberately preferred over parsing the
 * constraint lines themselves, whose token layout varies by constraint type and
 * is not something this writer should have to know.
 */
function sourceNodeIds(sourceText: string): Set<number> {
  const ids = new Set<number>();
  let inNodes = false;
  for (const line of sourceText.split(/\r?\n/)) {
    const t = line.trim();
    if (!inNodes) {
      if (/^Begin\s+Nodes\b/i.test(t)) inNodes = true;
      continue;
    }
    if (/^End\s+Nodes\b/i.test(t)) break;
    const id = parseInt(t, 10);
    if (Number.isFinite(id)) ids.add(id);
  }
  return ids;
}

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

  // Constraints go here — after the nodes and the entity blocks, which is both
  // where Kratos needs them and where real files put them (between
  // `End Conditions` and the first `Begin NodalData`).
  const trailing = opts.sourceText
    ? extractBlocks(opts.sourceText, TRAILING_VERBATIM_BLOCKS)
    : [];
  for (const b of trailing) lines.push(b, "");

  for (const field of model.fields) writeField(field, lines);
  for (const part of model.subModelParts) {
    writeSubModelPart(part, lines, "");
    lines.push("");
  }

  if (trailing.length > 0 && opts.onWarning && opts.sourceText) {
    warnIfNodesMissing(model, opts.sourceText, trailing.length, opts.onWarning);
  }

  return lines.join("\n") + "\n";
}

/**
 * A verbatim `Constraints` block references node ids.  If ids the source
 * declared are no longer in the model, the copied text points at nodes the
 * written file does not contain — so say so rather than writing a quietly wrong
 * file.  The scan runs only when constraints were actually copied AND a
 * listener is attached, so an ordinary Save pays nothing for it.
 *
 * Deliberately a test of the id SET, and deliberately one-sided:
 *
 *  - Nodes ADDED (`refine`, `linearToQuadratic`) do not invalidate anything —
 *    every id a constraint names is still there — so they are not reported.
 *  - Coordinates are NOT compared, even though they would be a sharper signal
 *    for some operations: a constraint references ids, not positions, so
 *    `translate` / `scale` / `rotate` / `smooth` move every node and invalidate
 *    nothing.  Comparing them would fire on the one class of edit that is
 *    provably safe.
 *
 * The gap this leaves is a pure PERMUTATION — `reorder` then `renumber` keeps
 * the id set `{1..N}` while handing each id to a different node — which no test
 * available here can see, because telling those apart needs the identity of a
 * node and this layer has only ids and coordinates.  `renumberModel` reports it
 * instead, at the point where the knowledge exists.  Both are stopgaps for
 * parsing constraints into real entities.
 */
function warnIfNodesMissing(
  model: MdpaModel,
  sourceText: string,
  blockCount: number,
  onWarning: (message: string) => void
): void {
  const before = sourceNodeIds(sourceText);
  if (before.size === 0) return;

  const after = new Set<number>();
  for (let i = 0; i < model.nodeCount; i++) after.add(model.nodeIds[i]);

  let missing = 0;
  for (const id of before) if (!after.has(id)) missing++;
  if (missing === 0) return;

  onWarning(
    `${blockCount} Constraints block(s) were copied verbatim from the original file, ` +
      `but ${missing} of the node ids it was written against are no longer in the mesh. ` +
      `The copied constraints may reference nodes that are not in the written file.`
  );
}
