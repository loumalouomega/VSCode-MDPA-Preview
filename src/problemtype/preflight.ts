/**
 * Case preflight (roadmap item 6, first increment): everything worth telling
 * the user about a case BEFORE it is generated, as structured findings.
 *
 * Pure module: no vscode / DOM / fs imports, so the sidebar (through
 * `PtController`) and the MCP `case_validate` tool share one rulebook and one
 * answer, the way `timeStepEstimate.ts` and `validateMaterialAssignment` do.
 *
 * The guarantee is ONE-DIRECTIONAL, and by construction: the core of the report
 * is a dry run of `planCaseMesh` + `generateCase` (both pure — nothing is
 * written), so a report with no `error` finding is a case that generates.
 * The converse does not hold on purpose: preflight is stricter than Generate
 * for a handful of things Generate only warns about (a SubModelPart that is not
 * in the mesh, a condition the problemtype does not declare — Generate skips
 * it), because those are almost never what the user meant.
 *
 * The extra layers deliberately stay clear of what the dry run already
 * reports (material rulebook, time stepping, domain/interface problems, the
 * `validate` hook), so the same problem never appears twice in two wordings.
 */

import { EntityKind, MdpaModel, SubModelPart } from "../parser/types";
import { computeMeshQuality } from "../parser/meshQuality";
import { findIsolatedNodeIds } from "../parser/isolatedNodes";
import { surfaceDefects } from "../parser/surfaceDefects";
import { CaseState, ProblemtypeRuntime } from "./types";
import { planCaseMesh } from "./caseMesh";
import {
  domainOfCondition,
  domainOfLaw,
  generateCase,
  partsConditionIds,
  subModelPartPaths,
} from "./generate";

export type FindingSeverity = "error" | "warning" | "info";

/** What a finding is about, so a UI can point at it and an agent can act on it. */
export interface FindingTarget {
  /** Slash-separated SubModelPart path. */
  smpPath?: string;
  conditionId?: string;
  lawId?: string;
  /** A Properties id of the mesh. */
  propertyId?: number;
  entityKind?: EntityKind;
  /** A bounded sample of entity ids (the full list stays in `mesh_quality`). */
  entityIds?: number[];
}

export interface Finding {
  severity: FindingSeverity;
  /** Stable machine-readable code, e.g. `smp-missing`. */
  code: string;
  message: string;
  target?: FindingTarget;
}

export interface PreflightReport {
  /** True when no finding is an `error`: such a case generates. */
  ok: boolean;
  counts: Record<FindingSeverity, number>;
  /** Most severe first; stable within a severity. */
  findings: Finding[];
}

export interface PreflightOptions {
  /** Whether the source mesh is an `.mdpa` (selects the case-mesh policy). Default true. */
  isMdpaSource?: boolean;
  /** Run the mesh-quality checks (default true). */
  quality?: boolean;
  /** Skip the quality checks above this many cells, with an `info` finding (default 200 000). */
  qualityMaxElements?: number;
}

export const DEFAULT_QUALITY_MAX_ELEMENTS = 200_000;
/** Names listed in one aggregated finding before it says "and N more". */
const LIST_LIMIT = 10;
const SAMPLE_IDS = 8;

const SEVERITY_ORDER: Record<FindingSeverity, number> = { error: 0, warning: 1, info: 2 };

function listNames(names: string[]): string {
  const shown = names.slice(0, LIST_LIMIT).map((n) => `"${n}"`).join(", ");
  return names.length > LIST_LIMIT ? `${shown} and ${names.length - LIST_LIMIT} more` : shown;
}

function indexParts(parts: SubModelPart[]): Map<string, SubModelPart> {
  const out = new Map<string, SubModelPart>();
  const walk = (p: SubModelPart): void => {
    out.set(p.path, p);
    p.children.forEach(walk);
  };
  parts.forEach(walk);
  return out;
}

type PartList = "nodeIds" | "elementIds" | "conditionIds" | "geometryIds";

/** Whether the part or any descendant carries an entity in one of `lists` (short-circuits). */
function partHas(part: SubModelPart, lists: PartList[]): boolean {
  if (lists.some((l) => part[l].length > 0)) return true;
  return part.children.some((c) => partHas(c, lists));
}

/** A material at `materialPath` covers `partPath` when it is that part or one of its ancestors. */
function covers(materialPath: string, partPath: string): boolean {
  return partPath === materialPath || partPath.startsWith(`${materialPath}/`);
}

/** Related by ancestry in either direction. */
function related(a: string, b: string): boolean {
  return covers(a, b) || covers(b, a);
}

/** Splits `generateCase`'s "...:\n- a\n- b" refusal into its individual problems. */
function refusalLines(message: string): string[] {
  const bullets = message
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim())
    .filter((l) => l.length > 0);
  return bullets.length > 0 ? bullets : [message.trim()];
}

/** Generator warnings the structural layer reports itself, with a target. */
const COVERED_GENERATOR_WARNING = [/ is not in the mesh\.$/, /^Unknown condition /];

/** Quality findings depend on the model alone, so repeat runs over one model (every form edit) reuse them. */
const qualityCache = new WeakMap<MdpaModel, { cap: number; findings: Finding[] }>();

function qualityFindings(model: MdpaModel, cap: number): Finding[] {
  const hit = qualityCache.get(model);
  if (hit && hit.cap === cap) return hit.findings;
  const out: Finding[] = [];
  const add = (severity: FindingSeverity, code: string, message: string, target?: FindingTarget): void => {
    out.push(target ? { severity, code, message, target } : { severity, code, message });
  };
  const cells = model.blocks.reduce((n, b) => n + b.count, 0);
  if (cells > cap) {
    add("info", "quality-skipped", `Mesh quality was not checked: ${cells} cells exceeds the preflight limit of ${cap}. Run mesh_quality or the Quality panel for the full report.`);
  } else if (cells > 0) {
    const report = computeMeshQuality(model);
    for (const metric of report.metrics) {
      if (!metric.failed) continue;
      const bad = metric.bandPct.bad + metric.bandPct.unacceptable;
      add("warning", "quality-metric",
        `Mesh-wide ${metric.label}: ${bad.toFixed(1)}% of ${metric.perElement ? "elements" : "nodes"} are in the bad or unacceptable bands (worst ${metric.higherIsBetter ? metric.min : metric.max}${metric.unit ? ` ${metric.unit}` : ""}).`,
        metric.perElement ? { entityIds: metric.badEntityIds.slice(0, SAMPLE_IDS) } : undefined);
    }
    const isolated = findIsolatedNodeIds(model);
    if (isolated.length > 0) {
      add("info", "isolated-nodes", `${isolated.length} node(s) belong to no cell.`, { entityIds: isolated.slice(0, SAMPLE_IDS) });
    }
    const defects = surfaceDefects(model);
    // Boundary edges are NOT reported: an open shell is a legitimate structural mesh.
    if (defects.inconsistentFaces.length > 0) {
      add("warning", "surface-orientation",
        `${defects.inconsistentFaces.length} surface face(s) are wound against a neighbour, so their normals disagree.`,
        { entityIds: defects.inconsistentFaces.slice(0, SAMPLE_IDS).map((f) => f.id) });
    }
    if (defects.degenerateFaces.length > 0) {
      add("warning", "surface-degenerate",
        `${defects.degenerateFaces.length} surface face(s) have zero area.`,
        { entityIds: defects.degenerateFaces.slice(0, SAMPLE_IDS).map((f) => f.id) });
    }
  }
  qualityCache.set(model, { cap, findings: out });
  return out;
}

export async function preflightCase(
  runtime: ProblemtypeRuntime,
  model: MdpaModel,
  state: CaseState,
  stem: string,
  opts: PreflightOptions = {}
): Promise<PreflightReport> {
  const findings: Finding[] = [];
  const add = (severity: FindingSeverity, code: string, message: string, target?: FindingTarget): void => {
    findings.push(target ? { severity, code, message, target } : { severity, code, message });
  };
  const decl = runtime.decl;
  const parts = indexParts(model.subModelParts);
  const knownPaths = new Set(subModelPartPaths(model.subModelParts));
  const partIds = new Set(partsConditionIds(decl));

  // --- 1. Dry run of the generator: everything it refuses on is an error. ---
  try {
    const plan = planCaseMesh(runtime, model, state, stem, opts.isMdpaSource ?? true);
    for (const w of plan.warnings) add("warning", "plan-warning", w);
    const out = await generateCase(runtime, plan.caseModel, state, plan.caseStem);
    for (const w of out.warnings) {
      if (COVERED_GENERATOR_WARNING.some((re) => re.test(w))) continue;
      add("warning", "generate-warning", w);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    for (const line of refusalLines(message)) add("error", "generate-refused", line);
  }

  // --- 2. Assignments and materials against the mesh and the declaration. ---
  const seen = new Set<string>();
  for (const a of state.assignments) {
    const cond = decl.conditions.find((c) => c.id === a.conditionId);
    if (!cond) {
      add("error", "condition-undeclared",
        `Assignment on "${a.smpPath}": condition "${a.conditionId}" is not declared by "${decl.id}" (Generate would skip it).`,
        { smpPath: a.smpPath, conditionId: a.conditionId });
    }
    if (!knownPaths.has(a.smpPath)) {
      add("error", "smp-missing",
        `Assignment "${a.conditionId}": SubModelPart "${a.smpPath}" is not in the mesh.`,
        { smpPath: a.smpPath, conditionId: a.conditionId });
    }
    const key = `${a.conditionId}\u0000${a.smpPath}`;
    if (seen.has(key)) {
      add("warning", "assignment-duplicate",
        `"${cond?.label ?? a.conditionId}" is assigned to "${a.smpPath}" more than once.`,
        { smpPath: a.smpPath, conditionId: a.conditionId });
    }
    seen.add(key);
  }
  for (const m of state.materials) {
    if (!knownPaths.has(m.smpPath)) {
      add("error", "smp-missing",
        `Material "${m.lawId}": SubModelPart "${m.smpPath}" is not in the mesh.`,
        { smpPath: m.smpPath, lawId: m.lawId });
    }
    if (decl.domains && decl.domains.length > 0 && decl.materialLaws.some((l) => l.id === m.lawId) && !domainOfLaw(decl, m.lawId)) {
      add("warning", "law-no-domain",
        `Material law "${m.lawId}" on "${m.smpPath}" belongs to no domain, so it is written to no materials file.`,
        { smpPath: m.smpPath, lawId: m.lawId });
    }
  }

  // --- 3. Computing parts and their materials. ---
  const computing = state.assignments.filter((a) => partIds.has(a.conditionId));
  const lawsOf = (domainId: string | undefined): string[] =>
    decl.materialLaws.filter((l) => (decl.domains ? l.domain === domainId : true)).map((l) => l.id);
  for (const a of computing) {
    const domain = domainOfCondition(decl, a.conditionId);
    const laws = lawsOf(domain?.id);
    if (laws.length === 0 || (domain && domain.materialsFileName === undefined)) continue;
    const hasMaterial = state.materials.some(
      (m) => laws.includes(m.lawId) && covers(m.smpPath, a.smpPath)
    );
    if (!hasMaterial) {
      add("warning", "part-no-material",
        `Computing part "${a.smpPath}"${domain ? ` (${domain.label})` : ""} has no material assigned.`,
        { smpPath: a.smpPath });
    }
  }
  if (computing.length > 0) {
    for (const m of state.materials) {
      const lawDomain = domainOfLaw(decl, m.lawId);
      const own = computing.filter((a) => (lawDomain ? domainOfCondition(decl, a.conditionId)?.id === lawDomain.id : true));
      if (own.length > 0 && !own.some((a) => related(m.smpPath, a.smpPath))) {
        add("warning", "material-outside-parts",
          `Material "${m.lawId}" on "${m.smpPath}"${lawDomain ? ` (${lawDomain.label})` : ""} is not on any computing part of its domain.`,
          { smpPath: m.smpPath, lawId: m.lawId });
      }
    }
  }

  // --- 4. Parts and their entities. ---
  const assignedPaths = new Set<string>([
    ...state.assignments.map((a) => a.smpPath),
    ...state.materials.map((m) => m.smpPath),
  ]);
  const ALL: PartList[] = ["nodeIds", "elementIds", "conditionIds", "geometryIds"];
  const emptyAssigned = new Set<string>();
  for (const p of assignedPaths) {
    const part = parts.get(p);
    if (part && !partHas(part, ALL)) {
      emptyAssigned.add(p);
      add("warning", "part-empty", `SubModelPart "${p}" is assigned but contains no nodes or entities.`, { smpPath: p });
    }
  }
  for (const a of state.assignments) {
    const cond = decl.conditions.find((c) => c.id === a.conditionId);
    const part = parts.get(a.smpPath);
    if (!cond || !part || emptyAssigned.has(a.smpPath)) continue;
    const need: Record<string, PartList[]> = {
      nodes: ["nodeIds"],
      volume: ["elementIds"],
      surface: ["conditionIds", "geometryIds", "elementIds"],
    };
    const lists = need[cond.target];
    if (lists && !partHas(part, lists)) {
      const what = cond.target === "nodes" ? "nodes" : cond.target === "volume" ? "elements" : "conditions or elements";
      add("warning", "part-wrong-kind",
        `"${cond.label}" targets ${cond.target === "nodes" ? "nodes" : cond.target}, but "${a.smpPath}" has no ${what}, so it would have nothing to act on.`,
        { smpPath: a.smpPath, conditionId: a.conditionId });
    }
  }
  const unusedPaths: string[] = [];
  const emptyUnassigned: string[] = [];
  for (const [p, part] of parts) {
    if (!partHas(part, ALL)) {
      if (!assignedPaths.has(p)) emptyUnassigned.push(p);
      continue;
    }
    if (![...assignedPaths].some((a) => related(a, p))) unusedPaths.push(p);
  }
  if (emptyUnassigned.length > 0) {
    add("info", "part-empty", `${emptyUnassigned.length} SubModelPart(s) are empty: ${listNames(emptyUnassigned)}.`);
  }
  if (state.assignments.length + state.materials.length > 0 && unusedPaths.length > 0) {
    add("info", "part-unused", `${unusedPaths.length} SubModelPart(s) are not used by any assignment or material: ${listNames(unusedPaths)}.`);
  }

  // --- 5. Properties references. ---
  if (model.properties !== undefined) {
    const defined = new Set(model.properties.map((s) => s.id));
    const used = new Map<number, Set<string>>();
    for (const b of model.blocks) {
      if (!b.propertyIds) continue;
      const n = Math.min(b.propertyIds.length, b.count);
      for (let i = 0; i < n; i++) {
        const id = b.propertyIds[i];
        if (id === 0) continue; // 0 is the "default Properties" convention
        let blocks = used.get(id);
        if (!blocks) used.set(id, (blocks = new Set()));
        blocks.add(b.name);
      }
    }
    for (const [id, blocks] of [...used].sort((a, b) => a[0] - b[0])) {
      if (!defined.has(id)) {
        add("warning", "property-undefined",
          `Properties ${id} is referenced by ${listNames([...blocks])} but the mesh does not define it.`,
          { propertyId: id });
      }
    }
    const unused = model.properties.filter((s) => s.id !== 0 && !used.has(s.id)).map((s) => String(s.id));
    if (unused.length > 0) {
      add("info", "property-unused", `Properties defined but used by no entity: ${unused.slice(0, LIST_LIMIT).join(", ")}${unused.length > LIST_LIMIT ? ` and ${unused.length - LIST_LIMIT} more` : ""}.`);
    }
  }

  // --- 6. Mesh quality (mesh-wide; the metrics have no per-part split). ---
  if (opts.quality !== false) {
    findings.push(...qualityFindings(model, opts.qualityMaxElements ?? DEFAULT_QUALITY_MAX_ELEMENTS));
  }

  const ordered = findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => SEVERITY_ORDER[a.f.severity] - SEVERITY_ORDER[b.f.severity] || a.i - b.i)
    .map((x) => x.f);
  const counts: Record<FindingSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of ordered) counts[f.severity]++;
  return { ok: counts.error === 0, counts, findings: ordered };
}
