/**
 * Decides which mesh file the solver reads for a case.
 *
 * A Kratos solve always reads an `.mdpa` file (`input_filename`). When the
 * source mesh already is one, it can be referenced directly — unless the
 * problemtype's mesh-name adaptation renames a block, in which case a
 * `<stem>_case.mdpa` copy is written and the original stays untouched. When
 * the source is anything else (`.vtu`, `.msh`, `.med`, …), there is no `.mdpa`
 * to reference, so the conversion this flow performs anyway becomes the case
 * mesh: `<stem>_case.mdpa` is always written.
 *
 * Pure module: no vscode / DOM / fs imports so it stays Node-testable. Both
 * `PtController.generate` and the MCP `case_generate` tool delegate to
 * `planCaseMesh`, so the two cannot drift apart again.
 */

import { MdpaModel } from "../parser/types";
import { extractSubModelParts } from "../parser/subModelPartExtract";
import { CaseState, ProblemtypeRuntime } from "./types";
import { flattenValues, resolveMeshNaming } from "./api";
import { domainOfLaw, resolveDomainSize } from "./generate";
import { adaptMeshNames, BlockRename } from "./meshAdapt";

/** One physics domain's own mesh file, sliced from the source (coupled problemtypes). */
export interface DomainMesh {
  domainId: string;
  /** The file is `<stem>.mdpa`. */
  stem: string;
  model: MdpaModel;
  renames: BlockRename[];
}

export interface CaseMeshPlan {
  /** The model to generate from (adapted when renames occurred). */
  caseModel: MdpaModel;
  /** Stem the generator uses for `input_filename` (no extension). */
  caseStem: string;
  /** Whether the caller must write `<caseStem>.mdpa` before generating. */
  shouldWriteMesh: boolean;
  domainSize: 2 | 3;
  renames: BlockRename[];
  warnings: string[];
  /**
   * For a problemtype with domains: one sliced mesh per domain, each written as
   * `<stem>.mdpa`. The solver reads these (never `caseModel`), so
   * `shouldWriteMesh` is false and `caseStem` stays the source stem.
   */
  domainMeshes: DomainMesh[];
}

/**
 * Plans the case mesh for a source mesh of stem `stem`.
 *
 * `isMdpaSource` selects the policy: an `.mdpa` source is referenced directly
 * when no rename occurred (`shouldWriteMesh: false`), while any other source
 * is always converted (`shouldWriteMesh: true`, `caseStem: "<stem>_case"`).
 * Writing the file itself stays with the caller (it owns fs + the verbatim
 * source text, which only an `.mdpa` source has).
 */
export function planCaseMesh(
  runtime: ProblemtypeRuntime,
  model: MdpaModel,
  state: CaseState,
  stem: string,
  isMdpaSource: boolean
): CaseMeshPlan {
  const scratch: string[] = []; // generateCase re-reports these warnings
  const domainSize = resolveDomainSize(runtime, model, scratch);
  const bases = resolveMeshNaming(runtime.decl, flattenValues(runtime.decl, state), domainSize);
  const adapted = adaptMeshNames(model, bases, domainSize);
  const warnings = [...adapted.warnings];
  if (
    model.subModelParts.length === 0 &&
    (state.assignments.length > 0 || state.materials.length > 0)
  ) {
    warnings.push(
      "The mesh declares no SubModelParts, so the assigned conditions and materials have " +
        "nothing to attach to — the solver will see an unloaded model."
    );
  }
  const decl = runtime.decl;
  if (decl.domains && decl.domains.length > 0) {
    // Slice the source into one mesh per domain by the SubModelParts assigned
    // there (its conditions' and its materials'), keeping the original paths so
    // a path assigned in the source still addresses the same part in the slice.
    const values = flattenValues(decl, state);
    const domainMeshes: DomainMesh[] = [];
    for (const d of decl.domains) {
      const paths = [
        ...state.assignments.filter((a) => d.conditionIds.includes(a.conditionId)).map((a) => a.smpPath),
        ...state.materials.filter((m) => domainOfLaw(decl, m.lawId)?.id === d.id).map((m) => m.smpPath),
      ];
      const slice = extractSubModelParts(model, paths, { keepTree: true });
      if (!slice) {
        warnings.push(`Domain "${d.label}": none of its assigned SubModelParts exist in the mesh, so its mesh file is empty.`);
      }
      const base = slice ?? { ...model, nodeCount: 0, nodeIds: new Int32Array(0), coords: new Float32Array(0), blocks: [], subModelParts: [], fields: [] };
      const bases = resolveMeshNaming({ ...decl, meshNaming: d.meshNaming ?? decl.meshNaming }, values, domainSize);
      const renamed = adaptMeshNames(base, bases, domainSize);
      warnings.push(...renamed.warnings.map((w) => `${d.label}: ${w}`));
      domainMeshes.push({ domainId: d.id, stem: `${stem}_${d.mdpaSuffix}`, model: renamed.model, renames: renamed.renames });
    }
    return {
      caseModel: model,
      caseStem: stem,
      shouldWriteMesh: false,
      domainSize,
      renames: domainMeshes.flatMap((m) => m.renames),
      warnings,
      domainMeshes,
    };
  }
  const shouldWriteMesh = !isMdpaSource || adapted.renames.length > 0;
  return {
    caseModel: adapted.model,
    caseStem: shouldWriteMesh ? `${stem}_case` : stem,
    shouldWriteMesh,
    domainSize,
    renames: adapted.renames,
    warnings,
    domainMeshes: [],
  };
}
