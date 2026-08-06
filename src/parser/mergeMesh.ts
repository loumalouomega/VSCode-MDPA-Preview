/**
 * Merges one or more meshes into the current one: appends their nodes and cells
 * with ids offset past the current model's own, adds one SubModelPart per
 * merged-in source, and optionally welds coincident nodes across the seams.
 *
 * Pure module: no vscode / DOM / vtk.js imports so it stays Node-testable, and
 * deliberately **filesystem-free** — it takes already-parsed models, so path →
 * SubModelPart-name derivation stays in `operations.ts`. The inputs are never
 * mutated; a fresh MdpaModel is returned.
 *
 * The offsetting is the same idea `vtkMultiblock.ts`'s `parseVtm` already uses
 * to combine several files into one scene (nodes/entities offset past what came
 * before, fields concatenated by (kind, variable), one SubModelPart per source)
 * — this is that merge exposed as a mesh operation instead of a multiblock-file
 * reader. Welding reuses `mergeNodes.ts` OUTRIGHT rather than reimplementing its
 * tolerance grid: once the node sets are concatenated into one model, "weld
 * coincident nodes across the seam" and "weld coincident nodes" are the same
 * problem.
 *
 * ## Why N sources in one call, and one weld at the end
 *
 * Merging N files as N sequential operations re-offsets from scratch each time
 * and runs N weld passes over a monotonically growing model — `mergeNodes`
 * rebuilds its whole grid hash every call — reporting a sum across passes whose
 * intermediate representative choices are not observable. Welding is transitive
 * over the final coordinate grid, so one pass at the end gives the same result
 * set and one honest number.
 *
 * ## Per-kind id offsets
 *
 * Elements, Conditions and Geometries are offset past their OWN maxima, not one
 * shared maximum. Kratos gives each kind its own id space (every real `.mdpa`
 * already has an `Element 1` beside a `Condition 1`), and a shared offset would
 * re-open, on every merge, the gap the `renumber` operation exists to close.
 */

import {
  EntityBlock,
  EntityKind,
  FieldData,
  MdpaDiagnostic,
  MdpaModel,
  SubModelPart,
} from "./types";
import { mergeNodes } from "./mergeNodes";
import { rebasePaths } from "./subModelPartTree";

export interface MergeMeshParams {
  /** Weld nodes that coincide across the seams (reuses mergeNodes' grid). */
  weld?: boolean;
  tolerance?: number;
  /**
   * Name for the SubModelPart wrapping the merged-in geometry. With several
   * sources this names their shared PARENT, and each source keeps its own
   * child part; without it each source becomes a top-level part of its own.
   */
  name?: string;
}

export interface MergeMeshResult {
  model: MdpaModel;
  addedNodes: number;
  addedCells: number;
  /** Nodes welded away across the seams (0 unless `weld` was set). */
  welded: number;
}

/** One already-parsed mesh to merge in, plus the part name it should land under. */
export interface MergeSource {
  model: MdpaModel;
  /** Usually the source file's stem — the caller owns that derivation. */
  name: string;
}

export interface MergeManyResult extends MergeMeshResult {
  /** The wrapper paths actually created, in source order, after de-duplication. */
  wrapperPaths: string[];
  /** Sources that carried no nodes and no cells. */
  skipped: number;
  /** Both sides' own diagnostics plus everything the merge could not preserve. */
  diagnostics: MdpaDiagnostic[];
}

const ENTITY_KINDS: readonly EntityKind[] = ["Elements", "Conditions", "Geometries"];

/** Ids in an incoming mesh are shifted past the accumulator's own, per space. */
interface IdOffsets {
  node: number;
  Elements: number;
  Conditions: number;
  Geometries: number;
  constraint: number;
}

// --- small typed-array helpers ---------------------------------------------
// Spreading a typed array into a JS array (`Int32Array.from([...a, ...b])`)
// boxes every element; on a million-node mesh that is millions of boxed numbers
// per merge, and an N-ary merge multiplies it.

function concatI32(a: Int32Array, b: Int32Array): Int32Array {
  const out = new Int32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function concatF32(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function concatF64(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Fixity flags are per-record and optional, so a concat has to materialize the
 * missing half rather than carry the surviving one at the wrong length — which
 * is what a `{...existing}` spread used to do.
 */
function concatFixed(
  a: Uint8Array | undefined,
  na: number,
  b: Uint8Array | undefined,
  nb: number
): Uint8Array | undefined {
  if (!a && !b) return undefined;
  const out = new Uint8Array(na + nb);
  if (a) out.set(a.subarray(0, na), 0);
  if (b) out.set(b.subarray(0, nb), na);
  return out;
}

function shifted(ids: Int32Array, by: number): Int32Array {
  if (by === 0) return Int32Array.from(ids);
  const out = new Int32Array(ids.length);
  for (let i = 0; i < ids.length; i++) out[i] = ids[i] + by;
  return out;
}

// --- id-space maxima --------------------------------------------------------

function maxId(ids: Int32Array): number {
  let max = 0;
  for (const id of ids) if (id > max) max = id;
  return max;
}

function entityOffsets(blocks: EntityBlock[]): Record<EntityKind, number> {
  const out = { Elements: 0, Conditions: 0, Geometries: 0 } as Record<EntityKind, number>;
  for (const b of blocks) {
    const m = maxId(b.entityIds);
    if (m > out[b.kind]) out[b.kind] = m;
  }
  return out;
}

/** SubModelPart constraint lists are the only place constraints appear at all. */
function maxConstraintId(parts: SubModelPart[]): number {
  let max = 0;
  for (const p of parts) {
    const m = maxId(p.constraintIds);
    if (m > max) max = m;
    const c = maxConstraintId(p.children);
    if (c > max) max = c;
  }
  return max;
}

function countConstraintIds(parts: SubModelPart[]): number {
  let n = 0;
  for (const p of parts) n += p.constraintIds.length + countConstraintIds(p.children);
  return n;
}

// --- part offsetting --------------------------------------------------------

function offsetPart(part: SubModelPart, off: IdOffsets): SubModelPart {
  return {
    ...part,
    nodeIds: shifted(part.nodeIds, off.node),
    elementIds: shifted(part.elementIds, off.Elements),
    conditionIds: shifted(part.conditionIds, off.Conditions),
    geometryIds: shifted(part.geometryIds, off.Geometries),
    constraintIds: shifted(part.constraintIds, off.constraint),
    children: part.children.map((c) => offsetPart(c, off)),
  };
}

/** `MergedMesh`, `MergedMesh_2`, … — never silently a second part of one name. */
function uniquePath(taken: Set<string>, base: string): string {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

function unionIds(parts: SubModelPart[], pick: (p: SubModelPart) => Int32Array): Int32Array {
  const set = new Set<number>();
  for (const p of parts) for (const id of pick(p)) set.add(id);
  return Int32Array.from([...set].sort((a, b) => a - b));
}

function isEmptyModel(m: MdpaModel): boolean {
  return m.nodeCount === 0 && m.blocks.every((b) => b.count === 0);
}

// --- the merge ---------------------------------------------------------------

interface Accumulator {
  nodeIds: Int32Array;
  coords: Float32Array;
  blocks: EntityBlock[];
  fields: FieldData[];
  subModelParts: SubModelPart[];
  is3D: boolean;
}

/** Folds one source into the accumulator; returns the wrapper it created. */
function appendModel(
  acc: Accumulator,
  source: MergeSource,
  wrapperName: string,
  diagnostics: MdpaDiagnostic[]
): SubModelPart {
  const other = source.model;
  const eOff = entityOffsets(acc.blocks);
  const off: IdOffsets = {
    node: maxId(acc.nodeIds),
    Elements: eOff.Elements,
    Conditions: eOff.Conditions,
    Geometries: eOff.Geometries,
    constraint: maxConstraintId(acc.subModelParts),
  };

  acc.nodeIds = concatI32(acc.nodeIds, shifted(other.nodeIds, off.node));
  acc.coords = concatF32(acc.coords, other.coords);
  acc.is3D = acc.is3D || other.is3D;

  for (const b of other.blocks) {
    acc.blocks.push({
      ...b,
      entityIds: shifted(b.entityIds, off[b.kind]),
      connectivity: shifted(b.connectivity, off.node),
    });
  }

  for (const f of other.fields) {
    const by = f.kind === "Nodal" ? off.node : f.kind === "Elemental" ? off.Elements : off.Conditions;
    const incoming: FieldData = { ...f, ids: shifted(f.ids, by) };
    const idx = acc.fields.findIndex((e) => e.kind === f.kind && e.variable === f.variable);
    if (idx < 0) {
      acc.fields.push(incoming);
      continue;
    }
    const existing = acc.fields[idx];
    if (existing.components !== incoming.components) {
      // Skipped, not kept alongside: the whole field surface is keyed
      // "<kind>:<variable>" (the webview picker, every field selector), and
      // mdpaWriter would emit two `Begin NodalData T` blocks of which the
      // second silently wins on re-read. A duplicate is not retained data.
      diagnostics.push({
        line: 0,
        message:
          `Field "${f.variable}" has inconsistent component counts ` +
          `(${existing.components} vs ${incoming.components}); the incoming ${f.kind} data ` +
          `from "${source.name}" was skipped.`,
      });
      continue;
    }
    acc.fields[idx] = {
      ...existing,
      ids: concatI32(existing.ids, incoming.ids),
      values: concatF64(existing.values, incoming.values),
      fixed: concatFixed(
        existing.fixed,
        existing.ids.length,
        incoming.fixed,
        incoming.ids.length
      ),
    };
  }

  const byKind = (kind: EntityKind): Int32Array =>
    Int32Array.from(
      other.blocks
        .filter((b) => b.kind === kind)
        .flatMap((b) => Array.from(b.entityIds, (id) => id + off[kind]))
    );

  const wrapper: SubModelPart = {
    name: wrapperName,
    path: wrapperName,
    nodeIds: shifted(other.nodeIds, off.node),
    elementIds: byKind("Elements"),
    conditionIds: byKind("Conditions"),
    geometryIds: byKind("Geometries"),
    constraintIds: new Int32Array(0),
    // rebasePaths is what makes a merged-in `Inlet` addressable as
    // `<wrapper>/Inlet`: SubModelParts are looked up by `path`, so a child that
    // keeps its old top-level path is unreachable from the outline, from
    // findSubModelPart and from every op that targets a part.
    children: other.subModelParts.map((p) => rebasePaths(offsetPart(p, off), wrapperName)),
  };

  // Fidelity losses that are real and cannot be repaired here — reported rather
  // than hidden. Properties VALUES are never parsed by this extension (MetaBlock
  // is a label plus a line count), and mdpaWriter copies Properties verbatim out
  // of the BASE's source text, so an incoming file's Properties cannot reach the
  // output regardless of what the model holds. Parsing them is a separate piece
  // of work (it is what beam/line-cell rendering is blocked on).
  const droppedMeta = other.meta.filter((m) => /^(Properties|ModelPartData|Table)/i.test(m.label));
  if (droppedMeta.length > 0) {
    diagnostics.push({
      line: 0,
      message:
        `${droppedMeta.length} Properties / ModelPartData / Table block(s) from "${source.name}" ` +
        `were not merged — this extension keeps only their line counts.`,
    });
  }
  const propIds = new Set<number>();
  for (const b of other.blocks) for (const p of b.propertyIds ?? []) propIds.add(p);
  if (propIds.size > 0) {
    const listed = [...propIds].sort((a, b) => a - b);
    const shown = listed.slice(0, 8).join(", ") + (listed.length > 8 ? ", …" : "");
    diagnostics.push({
      line: 0,
      message:
        `Cells merged from "${source.name}" keep property id(s) ${shown}, which now resolve ` +
        `against the base mesh's Properties.`,
    });
  }
  const constraints = countConstraintIds(other.subModelParts);
  if (constraints > 0) {
    diagnostics.push({
      line: 0,
      message:
        `${constraints} SubModelPart constraint id(s) from "${source.name}" were offset for ` +
        `internal consistency, but Constraints blocks themselves are neither parsed nor written back.`,
    });
  }

  return wrapper;
}

export function mergeManyModels(
  base: MdpaModel,
  sources: MergeSource[],
  params: MergeMeshParams = {}
): MergeManyResult {
  const usable = sources.filter((s) => !isEmptyModel(s.model));
  const skipped = sources.length - usable.length;
  const baseDiagnostics = [...base.diagnostics];

  if (usable.length === 0) {
    return {
      model: base,
      addedNodes: 0,
      addedCells: 0,
      welded: 0,
      wrapperPaths: [],
      skipped,
      diagnostics: baseDiagnostics,
    };
  }

  const diagnostics: MdpaDiagnostic[] = [...baseDiagnostics];
  for (const s of usable) {
    for (const d of s.model.diagnostics) {
      diagnostics.push({ ...d, message: `[${s.name}] ${d.message}` });
    }
  }

  const acc: Accumulator = {
    nodeIds: Int32Array.from(base.nodeIds),
    coords: Float32Array.from(base.coords),
    blocks: [...base.blocks],
    fields: [...base.fields],
    subModelParts: [...base.subModelParts],
    is3D: base.is3D,
  };

  // A wrapper must not collide with an existing top-level part (a nested path
  // can never collide with a top-level one, so only those need seeding).
  const taken = new Set(base.subModelParts.map((p) => p.path));
  const grouped = params.name !== undefined && usable.length > 1;
  const groupPath = grouped ? uniquePath(taken, params.name as string) : "";
  const childTaken = grouped ? new Set<string>() : taken;

  const wrappers: SubModelPart[] = [];
  for (const source of usable) {
    // With a single source `name` IS the wrapper's name (that is the binary
    // merge's contract); with several it names their shared parent instead, and
    // each source keeps its own.
    const desired = usable.length === 1 && params.name !== undefined ? params.name : source.name;
    const name = uniquePath(childTaken, desired);
    const wrapper = appendModel(acc, source, name, diagnostics);
    wrappers.push(grouped ? rebasePaths(wrapper, groupPath) : wrapper);
  }

  if (grouped) {
    // Kratos requires a child's entities to be a subset of its parent's, and
    // subModelPartTree.ts maintains that rule rather than validating it — so the
    // group carries the union of its children.
    acc.subModelParts.push({
      name: params.name as string,
      path: groupPath,
      nodeIds: unionIds(wrappers, (p) => p.nodeIds),
      elementIds: unionIds(wrappers, (p) => p.elementIds),
      conditionIds: unionIds(wrappers, (p) => p.conditionIds),
      geometryIds: unionIds(wrappers, (p) => p.geometryIds),
      constraintIds: new Int32Array(0),
      children: wrappers,
    });
  } else {
    acc.subModelParts.push(...wrappers);
  }

  // One pass over the final coords: always right, and it removes the
  // ±Infinity edge case a fold over each source's own bounds would carry.
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < acc.coords.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = acc.coords[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  if (acc.coords.length === 0) {
    min[0] = min[1] = min[2] = 0;
    max[0] = max[1] = max[2] = 0;
  }

  const merged: MdpaModel = {
    nodeCount: acc.nodeIds.length,
    nodeIds: acc.nodeIds,
    coords: acc.coords,
    blocks: acc.blocks,
    subModelParts: acc.subModelParts,
    meta: base.meta,
    fields: acc.fields,
    diagnostics,
    is3D: acc.is3D,
    bounds: { min, max },
  };

  const addedNodes = usable.reduce((n, s) => n + s.model.nodeCount, 0);
  const addedCells = usable.reduce(
    (n, s) => n + s.model.blocks.reduce((c, b) => c + b.count, 0),
    0
  );
  const wrapperPaths = wrappers.map((w) => w.path);

  if (!params.weld) {
    return { model: merged, addedNodes, addedCells, welded: 0, wrapperPaths, skipped, diagnostics };
  }

  const { model: welded, merged: weldedCount } = mergeNodes(merged, params.tolerance ?? 1e-6);
  return {
    model: { ...welded, diagnostics },
    addedNodes: addedNodes - weldedCount,
    addedCells,
    welded: weldedCount,
    wrapperPaths,
    skipped,
    diagnostics,
  };
}

/** Binary merge — the one-source case, kept as its own entry point. */
export function mergeModels(
  base: MdpaModel,
  other: MdpaModel,
  params: MergeMeshParams = {}
): MergeMeshResult {
  const { model, addedNodes, addedCells, welded } = mergeManyModels(
    base,
    [{ model: other, name: params.name ?? "MergedMesh" }],
    params
  );
  return { model, addedNodes, addedCells, welded };
}
