/**
 * Surface patch segmentation and its variational refinement — meshio++'s
 * `segment` (17.9.0 adds `method: "primitive"`) and `refinePatches` (17.11.0),
 * used strictly as ORACLES in the shape of `partitionMesh.ts`.
 *
 * Both work on a `segment:patch` cell array. The mesh comes back with the same
 * points, connectivity and block order and only that array (plus patch
 * regions and `fit:*`/`refine:*` data) changed, so the labels lay straight back
 * onto OUR blocks. Our models carry no such array, so the label lives in an
 * ordinary field, `SEGMENT_PATCH` (-1 = off the surface), which is what
 * `refinePatches` reads back in: `segment` then `refinePatches` is a chain the
 * history, recipes and `mesh_transform` can run, and the labels are inspectable,
 * colourable and exportable like any other field.
 *
 * One field per id space: Elements (and Geometries) carry an Elemental
 * `SEGMENT_PATCH`, Conditions a Conditional one, so an `Element 7` and a
 * `Condition 7` never share a value. `createParts` additionally writes one
 * `Patch_<k>` SubModelPart per patch (a re-run replaces the previous ones).
 *
 * Pure module (no vscode / DOM). The input is never mutated.
 */

import type { EntityBlock, FieldData, MdpaDiagnostic, MdpaModel, SubModelPart } from "./types";
import { modelToMeshio } from "./meshioConvert";
import { loadMeshio } from "./meshio";
import { flattenMeshioData, meshioCorrespondence } from "./meshioAdapter";
import { findSubModelPart } from "./subModelPartExtract";
import { cellCategory } from "./writers/writerCommon";

export const SEGMENT_VARIABLE = "SEGMENT_PATCH";

export const SEGMENT_METHODS = ["angle", "primitive"] as const;
export type SegmentMethod = (typeof SEGMENT_METHODS)[number];
export const PATCH_PRIMITIVES = ["plane", "sphere", "cylinder", "cone", "torus"] as const;
export type PatchPrimitive = (typeof PATCH_PRIMITIVES)[number];

export interface SegmentParams {
  /** Dihedral degrees above which an edge is a feature no patch crosses (kernel default 30). */
  featureAngle?: number;
  /** Largest normal deviation inside a patch, degrees; 0 = off. */
  normalTolerance?: number;
  /** Largest curvature deviation inside a patch; 0 = off. */
  curvatureTolerance?: number;
  /** A patch with fewer cells joins a neighbour (kernel default 1). */
  minPatchCells?: number;
  /** `angle` (default, region growing) or `primitive` (ends a patch where the underlying primitive changes). */
  method?: SegmentMethod;
  /** `primitive` only: relative tolerance to the bounding-box diagonal. */
  tolerance?: number;
  /** Segment only this SubModelPart (path); the rest is labelled -1. */
  part?: string;
  /** Also create one `Patch_<k>` SubModelPart per patch. */
  createParts?: boolean;
}

export interface RefinePatchesParams {
  tolerance?: number;
  relative?: boolean;
  normalWeight?: number;
  epsilon?: number;
  featureAngle?: number;
  maxIterations?: number;
  minPatchCells?: number;
  /** An integer in [0, 2^53]. */
  ransacSeed?: number;
  types?: PatchPrimitive[];
  allowSplit?: boolean;
  allowMerge?: boolean;
  createParts?: boolean;
}

export interface SegmentResult {
  model: MdpaModel;
  /** Cells that received a patch (>= 0). */
  labelled: number;
  numPatches: number;
  /** Facts the outcome message states. */
  details: string;
}

/** Number of cells of the model that are drawn from the surface (Elements/Conditions/Geometries alike). */
function refuseVolume(model: MdpaModel, op: string): boolean {
  let surface = 0;
  for (const b of model.blocks) {
    if (b.count === 0) continue;
    const cat = cellCategory(b.vtkCellType);
    if (cat === "volume") {
      throw new Error(`${op} works on a surface mesh, and this one has volume cells (${b.name}). Use Export skin first, or run it on the exported skin.`);
    }
    if (cat === "surface") surface += b.count;
  }
  return surface > 0;
}

/** `Patch_<k>` parts are ours: a re-run replaces them. */
const PATCH_PART = /^Patch_\d+$/;

function patchParts(blocks: readonly EntityBlock[], labels: readonly number[]): SubModelPart[] {
  const byPatch = new Map<number, { nodes: Set<number>; element: number[]; condition: number[]; geometry: number[] }>();
  let cursor = 0;
  for (const b of blocks) {
    for (let c = 0; c < b.count; c++) {
      const k = labels[cursor++];
      if (!(k >= 0)) continue;
      let e = byPatch.get(k);
      if (!e) byPatch.set(k, (e = { nodes: new Set(), element: [], condition: [], geometry: [] }));
      (b.kind === "Elements" ? e.element : b.kind === "Conditions" ? e.condition : e.geometry).push(b.entityIds[c]);
      for (let j = 0; j < b.stride; j++) e.nodes.add(b.connectivity[c * b.stride + j]);
    }
  }
  return [...byPatch.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([k, e]) => ({
      name: `Patch_${k}`,
      path: `Patch_${k}`,
      nodeIds: Int32Array.from([...e.nodes].sort((a, b) => a - b)),
      elementIds: Int32Array.from(e.element),
      conditionIds: Int32Array.from(e.condition),
      geometryIds: Int32Array.from(e.geometry),
      constraintIds: new Int32Array(0),
      children: [],
    }));
}

/** Lays per-cell labels (meshio block order) back out as one field per id space and, optionally, as parts. */
function withLabels(model: MdpaModel, blocks: readonly EntityBlock[], labels: readonly number[], createParts: boolean): MdpaModel {
  const el = { ids: [] as number[], values: [] as number[] };
  const co = { ids: [] as number[], values: [] as number[] };
  let cursor = 0;
  for (const b of blocks) {
    const target = b.kind === "Conditions" ? co : el;
    for (let c = 0; c < b.count; c++) {
      target.ids.push(b.entityIds[c]);
      target.values.push(labels[cursor++]);
    }
  }
  const make = (kind: "Elemental" | "Conditional", t: typeof el): FieldData[] =>
    t.ids.length === 0 ? [] : [{ kind, variable: SEGMENT_VARIABLE, components: 1, ids: Int32Array.from(t.ids), values: Float64Array.from(t.values) }];
  const fields = [
    ...model.fields.filter((f) => !(f.variable === SEGMENT_VARIABLE && (f.kind === "Elemental" || f.kind === "Conditional"))),
    ...make("Elemental", el),
    ...make("Conditional", co),
  ];
  const keptParts = model.subModelParts.filter((p) => !(createParts && PATCH_PART.test(p.name)));
  return { ...model, fields, subModelParts: createParts ? [...keptParts, ...patchParts(blocks, labels)] : keptParts };
}

/** The labels a previous `segment` left, in meshio block order; -1 where a cell has none. */
function storedLabels(model: MdpaModel, blocks: readonly EntityBlock[]): { labels: number[]; found: number } {
  const lookup = (kind: "Elemental" | "Conditional") => {
    const f = model.fields.find((x) => x.kind === kind && x.variable === SEGMENT_VARIABLE);
    const m = new Map<number, number>();
    if (f) for (let i = 0; i < f.ids.length; i++) m.set(f.ids[i], f.values[i]);
    return m;
  };
  const el = lookup("Elemental");
  const co = lookup("Conditional");
  const labels: number[] = [];
  let found = 0;
  for (const b of blocks) {
    const m = b.kind === "Conditions" ? co : el;
    for (let c = 0; c < b.count; c++) {
      const v = m.get(b.entityIds[c]);
      if (v === undefined || !(v >= 0)) labels.push(-1);
      else {
        labels.push(Math.round(v));
        found++;
      }
    }
  }
  return { labels, found };
}

/** The mesh as the kernel should see it: geometry and block regions only (no fields to collide with `segment:patch`). */
function surfaceMesh(model: MdpaModel, diagnostics: MdpaDiagnostic[]) {
  return modelToMeshio({ ...model, fields: [] }, diagnostics, { dim: 3 });
}

/** Region name `modelToMeshio` gives a SubModelPart (dotted path). */
const regionName = (path: string) => path.replace(/\//g, ".");

const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export async function segmentModel(model: MdpaModel, params: SegmentParams, diagnostics: MdpaDiagnostic[] = []): Promise<SegmentResult> {
  const unchanged: SegmentResult = { model, labelled: 0, numPatches: 0, details: "" };
  if (!refuseVolume(model, "Segment")) return unchanged;
  if (params.part !== undefined && !findSubModelPart(model, params.part)) throw new Error(`There is no SubModelPart "${params.part}".`);
  const mesh = surfaceMesh(model, diagnostics);
  const m = await loadMeshio();
  const r = m.segment(
    mesh,
    params.featureAngle,
    params.normalTolerance,
    params.curvatureTolerance,
    params.minPatchCells,
    params.part !== undefined ? regionName(params.part) : undefined,
    undefined,
    params.method,
    params.tolerance
  );
  const flat = flattenMeshioData(r.mesh.cell_data?.["segment:patch"]);
  const { blocks, cellCount } = meshioCorrespondence(model, mesh, "segment");
  if (flat.length !== cellCount) throw new Error(`segment returned ${flat.length} labels for ${cellCount} cells; the result was discarded.`);
  const out = withLabels(model, blocks, flat, params.createParts === true);
  const labelled = flat.filter((v) => v >= 0).length;
  return {
    model: out,
    labelled,
    numPatches: r.numPatches,
    details:
      `${r.numFeatureEdges} feature edge(s), ${r.numBoundaryEdges} boundary edge(s)` +
      (r.numNonManifoldEdges > 0 ? `, ${r.numNonManifoldEdges} non-manifold edge(s)` : "") +
      (r.numMerged > 0 ? `; ${r.numMerged} small patch(es) merged into a neighbour` : ""),
  };
}

export interface RefineOutcome extends SegmentResult {
  numIterations: number;
  numSplits: number;
  numMerges: number;
  numPrimitive: number;
  numFreeform: number;
  numFacets: number;
  explainedAreaFraction: number;
  initialExplainedAreaFraction: number;
  hausdorffMax: number;
  hausdorffRms: number;
}

export async function refinePatchesModel(model: MdpaModel, params: RefinePatchesParams, diagnostics: MdpaDiagnostic[] = []): Promise<RefineOutcome> {
  const none = { numIterations: 0, numSplits: 0, numMerges: 0, numPrimitive: 0, numFreeform: 0, numFacets: 0, explainedAreaFraction: 0, initialExplainedAreaFraction: 0, hausdorffMax: NaN, hausdorffRms: NaN };
  const unchanged: RefineOutcome = { model, labelled: 0, numPatches: 0, details: "", ...none };
  if (!refuseVolume(model, "Refine patches")) return unchanged;
  const mesh = surfaceMesh(model, diagnostics);
  const { blocks, cellCount } = meshioCorrespondence(model, mesh, "refinePatches");
  const stored = storedLabels(model, blocks);
  if (stored.found === 0) {
    return { ...unchanged, details: `There is no ${SEGMENT_VARIABLE} field to refine: run Segment first.` };
  }
  if (params.ransacSeed !== undefined && !(Number.isInteger(params.ransacSeed) && params.ransacSeed >= 0 && params.ransacSeed <= 2 ** 53)) {
    throw new Error("ransacSeed must be an integer between 0 and 2^53.");
  }
  // The kernel reads the labels from a per-block INTEGER `segment:patch` array (a double array is refused).
  const perBlock: BigInt64Array[] = [];
  let cursor = 0;
  for (const b of blocks) {
    perBlock.push(BigInt64Array.from(stored.labels.slice(cursor, cursor + b.count), (v) => BigInt(v)));
    cursor += b.count;
  }
  (mesh as { cell_data?: Record<string, unknown[]> }).cell_data = { ...(mesh.cell_data ?? {}), "segment:patch": perBlock };
  const { createParts: _c, ...options } = params;
  const m = await loadMeshio();
  const r = m.refinePatches(mesh, defined(options) as Parameters<typeof m.refinePatches>[1]);
  const flat = flattenMeshioData(r.mesh.cell_data?.["segment:patch"]);
  if (flat.length !== cellCount) throw new Error(`refinePatches returned ${flat.length} labels for ${cellCount} cells; the result was discarded.`);
  const out = withLabels(model, blocks, flat, params.createParts === true);
  return {
    model: out,
    labelled: flat.filter((v) => v >= 0).length,
    numPatches: r.numPatches,
    details:
      `${r.numIterations} iteration(s), ${r.numSplits} split(s), ${r.numMerges} merge(s); ` +
      `${r.numPrimitive} primitive, ${r.numFreeform} freeform, ${r.numFacets} facet patch(es); ` +
      `primitives explain ${(100 * r.explainedAreaFraction).toPrecision(3)}% of the area (${(100 * r.initialExplainedAreaFraction).toPrecision(3)}% before), ` +
      `largest distance to a proxy ${Number.isFinite(r.hausdorffMax) ? r.hausdorffMax.toPrecision(3) : "n/a"}`,
    numIterations: r.numIterations,
    numSplits: r.numSplits,
    numMerges: r.numMerges,
    numPrimitive: r.numPrimitive,
    numFreeform: r.numFreeform,
    numFacets: r.numFacets,
    explainedAreaFraction: r.explainedAreaFraction,
    initialExplainedAreaFraction: r.initialExplainedAreaFraction,
    hausdorffMax: r.hausdorffMax,
    hausdorffRms: r.hausdorffRms,
  };
}

// --- record parsing / validation (shared by opRecordFromMessage and the recipe loader) ---

/** The first thing wrong with a segment record's parameters, or undefined. */
export function segmentProblem(p: SegmentParams): string | undefined {
  for (const k of ["featureAngle", "normalTolerance", "curvatureTolerance", "tolerance"] as const) {
    if (p[k] !== undefined && !(typeof p[k] === "number" && Number.isFinite(p[k]) && (p[k] as number) >= 0)) return `invalid ${k}`;
  }
  if (p.featureAngle !== undefined && p.featureAngle > 180) return "featureAngle must be within [0, 180]";
  if (p.minPatchCells !== undefined && !(Number.isInteger(p.minPatchCells) && p.minPatchCells >= 1)) return "invalid minPatchCells";
  if (p.method !== undefined && !(SEGMENT_METHODS as readonly string[]).includes(p.method)) return "invalid method";
  if (p.part !== undefined && (typeof p.part !== "string" || p.part.length === 0)) return "invalid part";
  return undefined;
}

export function refinePatchesProblem(p: RefinePatchesParams): string | undefined {
  for (const k of ["tolerance", "normalWeight", "epsilon", "featureAngle"] as const) {
    if (p[k] !== undefined && !(typeof p[k] === "number" && Number.isFinite(p[k]) && (p[k] as number) >= 0)) return `invalid ${k}`;
  }
  if (p.tolerance !== undefined && !(p.tolerance > 0)) return "tolerance must be positive";
  if (p.featureAngle !== undefined && p.featureAngle > 180) return "featureAngle must be within [0, 180]";
  if (p.maxIterations !== undefined && !(Number.isInteger(p.maxIterations) && p.maxIterations >= 0)) return "invalid maxIterations";
  if (p.minPatchCells !== undefined && !(Number.isInteger(p.minPatchCells) && p.minPatchCells >= 1)) return "invalid minPatchCells";
  if (p.ransacSeed !== undefined && !(Number.isInteger(p.ransacSeed) && p.ransacSeed >= 0 && p.ransacSeed <= 2 ** 53)) return "ransacSeed must be an integer in [0, 2^53]";
  if (p.types !== undefined && !(Array.isArray(p.types) && p.types.length > 0 && p.types.every((t) => (PATCH_PRIMITIVES as readonly string[]).includes(t)))) return "invalid types";
  return undefined;
}
