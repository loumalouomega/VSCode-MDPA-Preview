/**
 * MdpaModel → Kratos .mdpa serializer (the inverse of mdpaParser.ts).
 *
 * Node ids and connectivity are written directly (MDPA is id-based, not
 * index-based).  Because the model keeps only a line-count for ModelPartData /
 * Table blocks (their text is not retained), a lossless Save copies those
 * blocks verbatim from the original source text when provided.
 *
 * `Constraints` used to be a verbatim block, copied through after the nodes.
 * It is now emitted from `model.constraints` (see `constraintsParser.ts`),
 * which is what lets an edit maintain it instead of leaving copied text keyed
 * to node ids the written mesh no longer has.  `Properties` has since made the
 * same move (see `propertiesParser.ts`): parsed on read, emitted from
 * `model.properties`, which is what lets a merged-in file's property sets
 * reach the output instead of being stranded behind the base file's verbatim
 * copy.  The ORDERING rule those splits survive unchanged and is load-bearing
 * rather than cosmetic: Properties / ModelPartData / Table are emitted BEFORE
 * `Begin Nodes`, while `Constraints` must be emitted AFTER the nodes and the
 * entity blocks, because Kratos' `ModelPartIO::ReadConstraintsBlock` resolves
 * a constraint's master/slave ids against nodes it has already read.  Emitting
 * `Constraints` early would write a file Kratos cannot read.
 *
 * Pure module: no vscode / DOM / vtk.js imports.
 */

import { FieldData, MdpaModel, SubModelPart } from "../types";
import {
  countConstraints,
  formatConstraintRow,
  undefinedConstraintIds,
} from "../constraintsParser";
import { formatPropertyTable, formatPropertyValue } from "../propertiesParser";
import { num } from "./writerCommon";

export interface MdpaWriteOptions {
  /**
   * Original .mdpa text — its ModelPartData / Table blocks are copied into the
   * output verbatim.  Properties are NOT copied: they are emitted from
   * `model.properties` instead.
   */
  sourceText?: string;
  /**
   * Called with an advisory message when the output is written but something
   * about it cannot be guaranteed.  Never a reason to fail the write.  Today:
   * constraints or Properties the source declared that the model being written
   * no longer carries, and SubModelPart constraint ids no block defines.
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
 * emitted BEFORE `Begin Nodes`.  Properties is deliberately absent: it is
 * emitted from `model.properties` (see `writeProperties`), so merged-in sets
 * survive instead of being stranded behind the base file's copy.
 */
const VERBATIM_BLOCKS = ["ModelPartData", "Table"];

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

/**
 * Emits `model.constraints`, one block per parsed block, rows indented two
 * spaces like every other row this writer produces.  A row that could not be
 * parsed is re-emitted as its own source text, so an unrecognised constraint
 * shape still round-trips.
 */
function writeConstraints(model: MdpaModel, lines: string[]): void {
  for (const block of model.constraints ?? []) {
    const header = ["Begin Constraints", block.name, ...block.variables]
      .filter((t) => t.length > 0)
      .join(" ");
    lines.push(header);
    for (const row of block.rows) lines.push(`  ${formatConstraintRow(row)}`);
    lines.push("End Constraints", "");
  }
}

/**
 * Emits `model.properties`, one `Begin Properties <id>` block per set, with
 * each variable on its own line and nested Tables inline — the inverse of
 * `parsePropertiesBlock`.  Variable order follows insertion order (the file's
 * own order); a `string`-kind value is emitted verbatim, so an unrecognised
 * line (e.g. a `CONSTITUTIVE_LAW` name) round-trips byte-for-byte.
 */
function writeProperties(model: MdpaModel, lines: string[]): void {
  for (const set of model.properties ?? []) {
    lines.push(`Begin Properties ${set.id}`);
    for (const name of Object.keys(set.variables)) {
      const v = set.variables[name];
      if (v === undefined) continue;
      lines.push(`  ${name} ${formatPropertyValue(v)}`.trimEnd());
    }
    for (const t of set.tables) {
      for (const l of formatPropertyTable(t)) lines.push(`  ${l}`);
    }
    lines.push("End Properties", "");
  }
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
  for (const b of preserved) lines.push(b, "");
  if (model.properties && model.properties.length > 0) {
    writeProperties(model, lines);
  } else {
    lines.push("Begin Properties 0", "End Properties", "");
  }

  writeNodes(model, lines);
  writeBlocks(model, lines);

  // Constraints go here — after the nodes and the entity blocks, which is both
  // where Kratos needs them and where real files put them (between
  // `End Conditions` and the first `Begin NodalData`).
  writeConstraints(model, lines);

  for (const field of model.fields) writeField(field, lines);
  for (const part of model.subModelParts) {
    writeSubModelPart(part, lines, "");
    lines.push("");
  }

  if (opts.onWarning) {
    warnAboutConstraints(model, opts.sourceText, opts.onWarning);
    warnAboutProperties(model, opts.sourceText, opts.onWarning);
  }

  return lines.join("\n") + "\n";
}

/**
 * Two advisory checks on the constraints, both computed from the model.
 *
 * The first is the one case where the source knows something the model does
 * not: the file declared constraints and the model carries none, i.e. an
 * operation dropped them (a remesh, a level-set split, a foreign-format round
 * trip).  They are **omitted rather than copied verbatim** — the copied text
 * would be keyed to node ids that operation has just replaced, which is exactly
 * the failure the parsed representation exists to end — so the write says what
 * it left out instead of writing something provably wrong.
 *
 * The second needs no source text at all and is the original defect class: a
 * `SubModelPartConstraints` list naming a constraint the file does not define.
 * Before constraints were parsed there was nothing to check that against.
 */
function warnAboutConstraints(
  model: MdpaModel,
  sourceText: string | undefined,
  onWarning: (message: string) => void
): void {
  const { linear, raw } = countConstraints(model.constraints);
  if (sourceText && linear + raw === 0) {
    const declared = (sourceText.match(/^[ \t]*Begin\s+Constraints\b/gm) ?? []).length;
    if (declared > 0) {
      onWarning(
        `${declared} Constraints block(s) in the original file are not in the model being ` +
          `written — an operation dropped them. They are omitted rather than copied onto ` +
          `node ids that have since changed.`
      );
    }
  }

  const undef = undefinedConstraintIds(model.constraints, model.subModelParts);
  if (undef.length > 0) {
    const shown = undef.slice(0, 8).join(", ") + (undef.length > 8 ? ", …" : "");
    onWarning(
      `${undef.length} SubModelPart constraint id(s) name constraints this file does not ` +
        `define (${shown}).`
    );
  }
}

/**
 * The Properties counterpart of the first constraints check: the source
 * declared Properties blocks and the model carries none, i.e. an operation
 * dropped them (a remesh, a level-set split, a foreign-format round trip).
 * They are **omitted rather than copied verbatim** — the copied text would
 * describe materials the output no longer references — so the write says what
 * it left out instead of writing something stale.
 */
function warnAboutProperties(
  model: MdpaModel,
  sourceText: string | undefined,
  onWarning: (message: string) => void
): void {
  if (model.properties && model.properties.length > 0) return;
  if (!sourceText) return;
  const declared = (sourceText.match(/^[ \t]*Begin\s+Properties\b/gm) ?? []).length;
  if (declared > 0) {
    onWarning(
      `${declared} Properties block(s) in the original file are not in the model being ` +
        `written — an operation dropped them. They are omitted rather than copied onto ` +
        `cells that no longer reference them.`
    );
  }
}
