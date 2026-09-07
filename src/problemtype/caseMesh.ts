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
import { CaseState, ProblemtypeRuntime } from "./types";
import { flattenValues, resolveMeshNaming } from "./api";
import { resolveDomainSize } from "./generate";
import { adaptMeshNames, BlockRename } from "./meshAdapt";

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
  const shouldWriteMesh = !isMdpaSource || adapted.renames.length > 0;
  return {
    caseModel: adapted.model,
    caseStem: shouldWriteMesh ? `${stem}_case` : stem,
    shouldWriteMesh,
    domainSize,
    renames: adapted.renames,
    warnings,
  };
}
