/**
 * Adapts a model's element/condition block type names to what a problemtype's
 * solver expects (resolved MeshNamingSpec bases): the target name is
 * `${base}${domainSize}D${nodesPerCell}N`, matching how GiD derives KratosNames
 * from the mesh geometry. Renaming is a pure string swap on EntityBlock.name —
 * SubModelParts and field data reference entities by id, never by block name.
 *
 * Pure module: no vscode / DOM / vtk.js imports so it stays Node-testable.
 */

import { EntityBlock, MdpaModel } from "../parser/types";

export interface BlockRename {
  kind: "Elements" | "Conditions";
  from: string;
  to: string;
}

export interface MeshAdaptResult {
  model: MdpaModel;
  renames: BlockRename[];
  warnings: string[];
}

/**
 * Returns a model whose Elements/Conditions blocks carry the solver-expected
 * names (input never mutated; unchanged models are returned as-is).
 * Point (stride-1) blocks are skipped, of either kind. For conditions their
 * names are load-specific (e.g. PointLoadCondition3D1N); for elements a
 * one-node block is a particle (an Exodus SPHERE, a Kratos DEM sphere), whose
 * name belongs to a particle solver, not to `${base}${dim}D1N`.
 * Two blocks may map to the same target name; Kratos concatenates repeated
 * `Begin <kind> <name>` blocks, and our parser merges them on re-parse.
 */
export function adaptMeshNames(
  model: MdpaModel,
  bases: { elements?: string; conditions?: string },
  domainSize: 2 | 3
): MeshAdaptResult {
  const renames: BlockRename[] = [];
  const warnings: string[] = [];
  const blocks: EntityBlock[] = model.blocks.map((block) => {
    const base =
      block.kind === "Elements" ? bases.elements : block.kind === "Conditions" ? bases.conditions : undefined;
    if (!base) return block;
    if (block.stride === 1) {
      warnings.push(
        block.kind === "Conditions"
          ? `Point condition block "${block.name}" kept as-is (point condition names are load-specific).`
          : `Particle element block "${block.name}" kept as-is (one-node element names are solver-specific).`
      );
      return block;
    }
    const target = `${base}${domainSize}D${block.stride}N`;
    if (block.name === target) return block;
    // base is only set for Elements/Conditions, so kind is narrowed here.
    renames.push({ kind: block.kind as BlockRename["kind"], from: block.name, to: target });
    return { ...block, name: target };
  });
  if (renames.length === 0) return { model, renames, warnings };
  return { model: { ...model, blocks }, renames, warnings };
}
