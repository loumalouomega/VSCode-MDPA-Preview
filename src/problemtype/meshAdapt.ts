/**
 * Adapts a model's element/condition block type names to what a problemtype's
 * solver expects (`ResolvedMeshNaming`, from the declaration's meshNaming):
 * the target is the resolved kind's name for the block's shape — GiD's
 * `${base}${dim}D${nodes}N` for the usual base kind, a `{dim}`/`{nodes}`
 * substitution for a template, or the exact entry of a shape table. Renaming
 * is a pure string swap on EntityBlock.name — SubModelParts and field data
 * reference entities by id, never by block name.
 *
 * A shape table lists the only shapes a formulation has, so a block of any
 * other shape cannot be renamed without inventing a Kratos type that does not
 * exist: it is left untouched and reported in `problems`, which the caller
 * turns into a generation refusal (preflight shows it as an error).
 *
 * Pure module: no vscode / DOM / vtk.js imports so it stays Node-testable.
 */

import { EntityBlock, MdpaModel } from "../parser/types";
import { ResolvedMeshKind, ResolvedMeshNaming } from "./types";
import { meshShapeKey, meshShapeList, meshTargetName } from "./meshNaming";

export interface BlockRename {
  kind: "Elements" | "Conditions";
  from: string;
  to: string;
}

/** A block the resolved naming has no name for, so it cannot be renamed. */
export interface MeshAdaptProblem {
  kind: "Elements" | "Conditions";
  block: string;
  /** The block's shape, e.g. "2D3N". */
  shape: string;
  /** One sentence for a Generate refusal bullet (see `planCaseMesh`). */
  message: string;
}

export interface MeshAdaptResult {
  model: MdpaModel;
  renames: BlockRename[];
  warnings: string[];
  /** Non-empty when a block cannot be named; the caller refuses generation then. */
  problems: MeshAdaptProblem[];
}

function missingShapeProblem(block: EntityBlock, kind: ResolvedMeshKind, domainSize: 2 | 3): MeshAdaptProblem {
  const shape = meshShapeKey(domainSize, block.stride);
  const what = block.kind === "Elements" ? "Element" : "Condition";
  return {
    kind: block.kind as MeshAdaptProblem["kind"],
    block: block.name,
    shape,
    message:
      `${what} block "${block.name}" (${shape}) has no "${kind.source ?? "selected"}" variant — ` +
      `that formulation names ${meshShapeList(kind)} — so renaming it would invent a Kratos type.`,
  };
}

/**
 * Returns a model whose Elements/Conditions blocks carry the solver-expected
 * names (input never mutated; unchanged models are returned as-is).
 *
 * One-node blocks are special: a stride-1 element is a particle (an Exodus
 * SPHERE, a DEM sphere), a stride-1 condition a point condition
 * (PointLoadCondition3D1N) — names a particle solver or a load family owns, not
 * `${base}${dim}D1N` — so they are kept as is with a warning. A shape table that
 * declares a one-node element (a NodalConcentratedElement) lifts that guard for
 * the shapes it names.
 *
 * Two blocks may map to the same target name; Kratos concatenates repeated
 * `Begin <kind> <name>` blocks, and our parser merges them on re-parse.
 */
export function adaptMeshNames(
  model: MdpaModel,
  naming: ResolvedMeshNaming,
  domainSize: 2 | 3
): MeshAdaptResult {
  const renames: BlockRename[] = [];
  const warnings: string[] = [];
  const problems: MeshAdaptProblem[] = [];
  const blocks: EntityBlock[] = model.blocks.map((block) => {
    const kind = block.kind === "Elements" ? naming.elements : block.kind === "Conditions" ? naming.conditions : undefined;
    if (!kind) return block;
    if (block.stride === 1 && kind.shapes?.[meshShapeKey(domainSize, 1)] === undefined) {
      warnings.push(
        block.kind === "Conditions"
          ? `Point condition block "${block.name}" kept as-is (point condition names are load-specific).`
          : `Particle element block "${block.name}" kept as-is (one-node element names are solver-specific).`
      );
      return block;
    }
    const target = meshTargetName(kind, domainSize, block.stride);
    if (target === undefined) {
      problems.push(missingShapeProblem(block, kind, domainSize));
      return block;
    }
    if (block.name === target) return block;
    // kind is only set for Elements/Conditions, so this narrows safely.
    renames.push({ kind: block.kind as BlockRename["kind"], from: block.name, to: target });
    return { ...block, name: target };
  });
  if (renames.length === 0) return { model, renames, warnings, problems };
  return { model: { ...model, blocks }, renames, warnings, problems };
}
