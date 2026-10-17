/**
 * The Kratos applications a generated case needs (roadmap item 16: a missing
 * application must be refused by name, never surface as a raw traceback).
 *
 * Pure, so the generator, the run path and MCP share one list. The list is the
 * union of three sources:
 *   - the application in the analysis stage module
 *     (`KratosMultiphysics.FluidDynamicsApplication.fluid_dynamics_analysis`);
 *   - every application the generated JSON documents name — a process's
 *     `kratos_module` or `python_module`, a linear solver's
 *     `"LinearSolversApplication.sparse_lu"`;
 *   - the declaration's own `applications` list, whose entries may carry a
 *     `when` rule over the case's values (an ALE mesh solver only when ALE is on).
 * Scanning the documents means a problemtype rarely needs to declare anything:
 * whatever it writes it is checked for.
 */

import { isFieldVisible } from "./layout";
import type { JsonValue, MaterialLawSpec, ProblemtypeDeclaration, RequiredApplication } from "./types";

export const APPLICATION_NAME = /^[A-Z][A-Za-z0-9]*Application$/;

/** `KratosMultiphysics.<App>` at the start of a module path. */
const MODULE_PATH = /^KratosMultiphysics\.([A-Z][A-Za-z0-9]*Application)(?:\.|$)/;
/** `<App>.<factory key>`, the way Kratos names an application-provided linear solver. */
const FACTORY_KEY = /^([A-Z][A-Za-z0-9]*Application)\.[a-z][a-z0-9_]*$/;

export function applicationOfModule(module: string): string | undefined {
  return MODULE_PATH.exec(module)?.[1];
}

/** Every application a JSON document names, in first-seen order. */
export function applicationsInDocument(doc: JsonValue, out: Set<string> = new Set()): Set<string> {
  if (typeof doc === "string") {
    const app = MODULE_PATH.exec(doc)?.[1] ?? FACTORY_KEY.exec(doc)?.[1];
    if (app) out.add(app);
  } else if (Array.isArray(doc)) {
    for (const v of doc) applicationsInDocument(v, out);
  } else if (doc && typeof doc === "object") {
    for (const v of Object.values(doc)) applicationsInDocument(v as JsonValue, out);
  }
  return out;
}

/** The declaration's applications that apply to these values. */
export function declaredApplications(
  declared: RequiredApplication[] | undefined,
  values: Record<string, JsonValue>
): string[] {
  const out: string[] = [];
  for (const entry of declared ?? []) {
    if (typeof entry === "string") out.push(entry);
    else if (isFieldVisible({ visibleWhen: entry.when }, values)) out.push(entry.application);
  }
  return out;
}

/** The sorted union of the stage's, the declaration's, the documents' and the assigned laws' applications. */
export function requiredApplications(
  decl: Pick<ProblemtypeDeclaration, "analysisStage" | "applications"> & {
    /** Optional so callers without material laws (a composed runtime) need not fake an empty list. */
    materialLaws?: readonly MaterialLawSpec[];
  },
  values: Record<string, JsonValue>,
  documents: JsonValue[],
  materials: readonly { lawId: string }[] = []
): string[] {
  const all = new Set<string>();
  const stage = applicationOfModule(decl.analysisStage);
  if (stage) all.add(stage);
  for (const app of declaredApplications(decl.applications, values)) all.add(app);
  for (const doc of documents) applicationsInDocument(doc, all);
  // A materials file carries no module path, so the scan above cannot see a
  // law's own application (`ConstitutiveLawsApplication`): add it for every
  // assignment that uses the law, unless the law's `when` excludes the setup.
  for (const m of materials) {
    const law = decl.materialLaws?.find((l) => l.id === m.lawId);
    if (law?.application && isFieldVisible({ visibleWhen: law.when }, values)) all.add(law.application);
  }
  return [...all].sort();
}

/** Problems with a declaration's `applications` list, for `validateDeclaration`. */
export function applicationDeclarationProblems(declared: unknown): string[] {
  if (declared === undefined) return [];
  if (!Array.isArray(declared)) return ["applications must be a list"];
  const out: string[] = [];
  declared.forEach((entry, i) => {
    const name = typeof entry === "string" ? entry : (entry as { application?: unknown })?.application;
    if (typeof name !== "string" || !APPLICATION_NAME.test(name)) {
      out.push(`applications[${i}]: expected a Kratos application name such as "FluidDynamicsApplication"`);
    }
    const when = typeof entry === "object" && entry ? (entry as { when?: unknown }).when : undefined;
    if (when !== undefined && (typeof when !== "object" || when === null)) out.push(`applications[${i}].when must be a visibility rule`);
  });
  return out;
}

/**
 * The prelude every generated driver starts with: it checks that Kratos and
 * each required application can be imported, before anything is read or
 * written, and exits with code 3 naming the missing ones. `find_spec` on a
 * submodule imports its parent, so `KratosMultiphysics` is checked first.
 */
export function applicationCheckPy(applications: readonly string[]): string {
  return `# Kratos applications this case needs; checked before anything is read or written.
import importlib.util as _kkss_find
import sys as _kkss_sys

_KKSS_REQUIRED_APPLICATIONS = ${JSON.stringify([...applications])}


def _kkss_missing_applications():
    if _kkss_find.find_spec("KratosMultiphysics") is None:
        return ["KratosMultiphysics"]
    missing = []
    for name in _KKSS_REQUIRED_APPLICATIONS:
        try:
            found = _kkss_find.find_spec("KratosMultiphysics." + name) is not None
        except (ImportError, ValueError):
            found = False
        if not found:
            missing.append(name)
    return missing


_kkss_missing = _kkss_missing_applications()
if _kkss_missing:
    print("Missing Kratos applications: " + ", ".join(_kkss_missing), file=_kkss_sys.stderr)
    print("Install them (pip install Kratos<Name>, e.g. KratosFluidDynamicsApplication) or point kratos.installPath at a build that has them.", file=_kkss_sys.stderr)
    _kkss_sys.exit(3)

`;
}

/** The exit code the prelude uses for a missing application. */
export const MISSING_APPLICATION_EXIT_CODE = 3;

/** One sentence naming the missing applications, shared by every refusal. */
export function describeMissingApplications(missing: readonly string[]): string {
  if (missing.includes("KratosMultiphysics")) {
    return "Kratos (KratosMultiphysics) cannot be imported with the configured Python. Install it or set kratos.installPath / kratos.pythonPath.";
  }
  const list = missing.join(", ");
  return `The case needs Kratos application${missing.length === 1 ? "" : "s"} that the configured Python cannot import: ${list}. Install ${missing.length === 1 ? "it" : "them"} (pip install Kratos<Name>) or point kratos.installPath at a build that has ${missing.length === 1 ? "it" : "them"}.`;
}
