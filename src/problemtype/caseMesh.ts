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
import { CaseState, ConditionEmitSpec, JsonValue, ProblemtypeRuntime } from "./types";
import { asStr, flattenValues, resolveMeshNaming } from "./api";
import { domainOfLaw, resolveDomainSize } from "./generate";
import { adaptMeshNames, BlockRename, MeshAdaptProblem } from "./meshAdapt";
import { addInterfacePointLoads } from "./interfacePointLoad";
import { emitLoadConditions, LoadEmitRequest } from "./emitLoadConditions";

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
 * Runs load-condition emission (point, moment and moving loads) over `model`:
 * every assignment whose condition declares `emit` synthesizes the Kratos
 * conditions into a sibling part. `values` are the flattened case values the
 * formulation field is read from; `prefix` labels the warnings per domain.
 */
function emitLoads(
  model: MdpaModel,
  decl: { conditions: { id: string; emit?: ConditionEmitSpec }[] },
  values: Record<string, JsonValue>,
  assignments: { smpPath: string; conditionId: string }[],
  domainSize: 2 | 3,
  prefix = ""
): { model: MdpaModel; warnings: string[] } {
  const requests: LoadEmitRequest[] = [];
  for (const a of assignments) {
    if (decl.conditions.some((c) => c.id === a.conditionId && c.emit !== undefined)) {
      requests.push({ smpPath: a.smpPath, conditionId: a.conditionId });
    }
  }
  if (requests.length === 0) return { model, warnings: [] };
  const emitOf = (id: string) => decl.conditions.find((c) => c.id === id)?.emit;
  const applied = emitLoadConditions(model, requests, {
    domainSize,
    emitOf,
    formulationOf: (id: string) => {
      const field = emitOf(id)?.formulationField;
      return field ? asStr(values[field], "") : "";
    },
  });
  return {
    model: applied.model,
    warnings: applied.warnings.map((w) => (prefix ? `${prefix}: ${w}` : w)),
  };
}

/**
 * Throws the Generate refusal for blocks the resolved naming cannot name, one
 * bullet per block, so preflight reports each as its own error finding.
 */
function refuseMesh(problems: MeshAdaptProblem[], domain?: string): void {
  if (problems.length === 0) return;
  const bullets = problems.map((p) => (domain ? `Domain "${domain}": ${p.message}` : p.message));
  throw new Error(
    `The mesh cannot be adapted to the selected formulation, so no case files were written:\n- ${bullets.join("\n- ")}`
  );
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
  const decl = runtime.decl;
  const values = flattenValues(decl, state);
  const naming = resolveMeshNaming(decl, values, domainSize);
  const adapted = adaptMeshNames(model, naming, domainSize);
  refuseMesh(adapted.problems);
  const warnings = [...adapted.warnings];
  // Point, moment and moving loads synthesize their Kratos conditions from
  // the assigned parts into sibling parts (the mesh rarely carries them).
  const emitted = emitLoads(adapted.model, decl, values, state.assignments, domainSize);
  warnings.push(...emitted.warnings);
  if (
    model.subModelParts.length === 0 &&
    (state.assignments.length > 0 || state.materials.length > 0)
  ) {
    warnings.push(
      "The mesh declares no SubModelParts, so the assigned conditions and materials have " +
        "nothing to attach to — the solver will see an unloaded model."
    );
  }
  if (decl.domains && decl.domains.length > 0) {
    // Slice the source into one mesh per domain by the SubModelParts assigned
    // there (its conditions' and its materials'), keeping the original paths so
    // a path assigned in the source still addresses the same part in the slice.
    const domainMeshes: DomainMesh[] = [];
    for (const d of decl.domains) {
      const own = state.assignments.filter((a) => d.conditionIds.includes(a.conditionId));
      const paths = [
        ...own.map((a) => a.smpPath),
        ...state.materials.filter((m) => domainOfLaw(decl, m.lawId)?.id === d.id).map((m) => m.smpPath),
      ];
      const slice = extractSubModelParts(model, paths, { keepTree: true });
      if (!slice) {
        warnings.push(`Domain "${d.label}": none of its assigned SubModelParts exist in the mesh, so its mesh file is empty.`);
      }
      const base = slice ?? { ...model, nodeCount: 0, nodeIds: new Int32Array(0), coords: new Float32Array(0), blocks: [], subModelParts: [], fields: [] };
      const naming = resolveMeshNaming({ ...decl, meshNaming: d.meshNaming ?? decl.meshNaming }, values, domainSize);
      const renamed = adaptMeshNames(base, naming, domainSize);
      refuseMesh(renamed.problems, d.label);
      warnings.push(...renamed.warnings.map((w) => `${d.label}: ${w}`));
      let domainModel = renamed.model;
      // The domain's own point, moment and moving loads, before the mapped
      // interface load tops the same sibling up (see interfacePointLoad.ts).
      const loads = emitLoads(domainModel, decl, values, own, domainSize, d.label);
      domainModel = loads.model;
      warnings.push(...loads.warnings);
      if (d.pointLoadInterface) {
        // The coupling's mapped POINT_LOAD is assembled by one-node point
        // conditions in a sibling of the interface part (see interfacePointLoad.ts).
        const paths = state.assignments
          .filter((a) => a.conditionId === d.pointLoadInterface!.conditionId)
          .map((a) => a.smpPath);
        const applied = addInterfacePointLoads(domainModel, paths, domainSize);
        domainModel = applied.model;
        warnings.push(...applied.warnings.map((w) => `${d.label}: ${w}`));
      }
      domainMeshes.push({ domainId: d.id, stem: `${stem}_${d.mdpaSuffix}`, model: domainModel, renames: renamed.renames });
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
  const shouldWriteMesh = !isMdpaSource || adapted.renames.length > 0 || emitted.model !== adapted.model;
  return {
    caseModel: emitted.model,
    caseStem: shouldWriteMesh ? `${stem}_case` : stem,
    shouldWriteMesh,
    domainSize,
    renames: adapted.renames,
    warnings,
    domainMeshes: [],
  };
}
