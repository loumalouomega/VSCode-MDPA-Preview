/**
 * User layers: named view-only groups that organise what the viewer shows,
 * kept deliberately separate from SubModelParts.
 *
 * A SubModelPart is solver data: Kratos reads it, every writer emits it, and
 * operations change it through the undoable history. A user layer is a view
 * annotation: it may list blocks, SubModelParts or an explicit id set taken
 * from a selection set, but it never changes membership, Properties,
 * constraints, fields, the file on disk or the dirty marker, and it never
 * reaches a solver input unless it is promoted explicitly through
 * `createSubModelPartFromSelection`.
 *
 * Pure module (no vscode / DOM / vtk / wasm / node:fs), the same Node-testable
 * tier as `selectionCore.ts`, which this mirrors. The webview holds the state;
 * the host persists it to the `<stem>.kratosview.json` sidecar (see
 * `caseFile.ts`'s `viewFilePath`). Nothing here enters the operation history,
 * a recipe, or MCP — promotion reuses the existing op, so headless parity
 * needs no new tool.
 *
 * **The survival rule is "refresh by definition"**, the same rule selection
 * sets use: explicit ids intersect each new model's id universes, block and
 * part references prune when the block/part vanishes, and the change is
 * flagged rather than silently kept. A stale layer silently applied to a
 * different mesh is exactly the failure this rule exists to prevent.
 *
 * **Lock semantics:** a locked layer cannot be renamed, reordered, deleted,
 * or promoted. Show/hide and recolour still apply — those are view-only and
 * never mutate solver data. Membership is set at creation and never edited
 * afterwards (except by pruning); deleting a layer never deletes entities,
 * parts or fields.
 */

import { EntityKind, MdpaModel } from "./types";
import { ENTITY_KINDS, KindIdSets, entityUniverses } from "./selectionCore";
import { findSubModelPart } from "./subModelPartExtract";

export const VIEW_SIDECAR_VERSION = 1;

/** RGB in 0..1, the same shape `OutlineNode.color` uses. */
export type LayerColor = [number, number, number];

/** One named view-only group. Id lists are sorted ascending. */
export interface UserLayer {
  /** Stable slug, unique within the sidecar (e.g. "walls", "walls_2"). */
  id: string;
  /** Display name, unique within the sidecar, never contains "/". */
  name: string;
  color: LayerColor;
  visible: boolean;
  locked: boolean;
  /** Block layer ids (`block:<kind>:<name>`, see `blockLayerId` in main.ts). */
  blocks: string[];
  /** SubModelPart paths (subtree-inclusive on resolve). */
  parts: string[];
  /** Explicit snapshot, usually imported from a selection set. */
  ids: KindIdSets;
}

/** The `<stem>.kratosview.json` document. Today it carries only `layers`; item
 * 3 will add camera/field/clip/layout keys alongside it. */
export interface ViewSidecar {
  version: number;
  layers: UserLayer[];
}

const DEFAULT_PALETTE: LayerColor[] = [
  [0.23, 0.45, 0.95],
  [0.88, 0.25, 0.19],
  [0.35, 0.65, 0.25],
  [1.0, 0.65, 0.1],
  [0.6, 0.35, 0.75],
  [0.2, 0.7, 0.75],
  [0.95, 0.45, 0.65],
  [0.55, 0.55, 0.55],
];

export function defaultLayerColor(index: number): LayerColor {
  const c = DEFAULT_PALETTE[((index % DEFAULT_PALETTE.length) + DEFAULT_PALETTE.length) % DEFAULT_PALETTE.length];
  return [c[0], c[1], c[2]];
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Parses `#rrggbb` (leading `#` optional) into RGB 0..1, or undefined. */
export function parseLayerColor(text: string): LayerColor | undefined {
  const t = text.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(t)) return undefined;
  const r = parseInt(t.slice(0, 2), 16) / 255;
  const g = parseInt(t.slice(2, 4), 16) / 255;
  const b = parseInt(t.slice(4, 6), 16) / 255;
  return [r, g, b];
}

export function layerColorToHex(c: LayerColor): string {
  const to255 = (v: number): string => Math.round(clamp01(v) * 255).toString(16).padStart(2, "0");
  return `#${to255(c[0])}${to255(c[1])}${to255(c[2])}`;
}

export function layerColorToCss(c: LayerColor): string {
  const to255 = (v: number): number => Math.round(clamp01(v) * 255);
  return `rgb(${to255(c[0])}, ${to255(c[1])}, ${to255(c[2])})`;
}

function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return s.length > 0 ? s.slice(0, 48) : "layer";
}

/** A new stable id for `name` that collides with none of `existing`. */
export function newLayerId(name: string, existing: readonly string[]): string {
  const base = slugify(name);
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

/** A layer name is usable when it is non-empty and carries no `/` (the
 * SubModelPart path separator — allowing it would invite confusion between
 * the two concepts this feature exists to keep apart). */
export function isValidLayerName(name: string): boolean {
  const t = name.trim();
  return t.length > 0 && !t.includes("/") && t.length <= 120;
}

export function isLayerNameAvailable(layers: readonly UserLayer[], name: string, ignoreId?: string): boolean {
  const t = name.trim();
  return !layers.some((l) => l.id !== ignoreId && l.name === t);
}

function cleanIds(xs: unknown): number[] {
  if (!Array.isArray(xs)) return [];
  const out = new Set<number>();
  for (const v of xs) {
    if (typeof v === "number" && Number.isInteger(v) && v > 0) out.add(v);
  }
  return Array.from(out).sort((a, b) => a - b);
}

function cleanStrings(xs: unknown): string[] {
  if (!Array.isArray(xs)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of xs) {
    if (typeof v === "string") {
      const t = v.trim();
      if (t.length > 0 && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
  }
  return out;
}

function cleanColor(raw: unknown, fallbackIndex: number): LayerColor {
  if (Array.isArray(raw) && raw.length === 3 && raw.every(isFiniteNum)) {
    return [clamp01(raw[0]), clamp01(raw[1]), clamp01(raw[2])];
  }
  return defaultLayerColor(fallbackIndex);
}

/**
 * Validates one unknown record into a `UserLayer`, collecting warnings rather
 * than throwing — a sidecar on disk is untrusted input, the recipe-tolerance
 * rule from `parseOpsJson`/`parseCaseJson`.
 */
export function validateUserLayer(raw: unknown, fallbackIndex: number): { layer?: UserLayer; warnings: string[] } {
  const warnings: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { warnings: ["Skipped a malformed user layer (not an object)."] };
  }
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!isValidLayerName(name)) {
    return { warnings: ["Skipped a user layer without a valid name."] };
  }
  const id = typeof r.id === "string" && r.id.trim().length > 0 ? r.id.trim().slice(0, 64) : slugify(name);
  const idsRaw = (r.ids as Record<string, unknown> | undefined) ?? {};
  const ids: KindIdSets = {
    Elements: cleanIds(idsRaw.Elements),
    Conditions: cleanIds(idsRaw.Conditions),
    Geometries: cleanIds(idsRaw.Geometries),
  };
  const blocks = cleanStrings(r.blocks).filter((b) => b.startsWith("block:"));
  if (Array.isArray(r.blocks) && blocks.length !== (r.blocks as unknown[]).length) {
    warnings.push(`Layer "${name}": dropped block references that are not block layer ids.`);
  }
  const parts = cleanStrings(r.parts);
  return {
    layer: {
      id,
      name,
      color: cleanColor(r.color, fallbackIndex),
      visible: r.visible === undefined ? true : r.visible === true,
      locked: r.locked === true,
      blocks,
      parts,
      ids,
    },
    warnings,
  };
}

/** Validates a whole layer list, de-duplicating ids and names. */
export function validateUserLayers(raw: unknown): { layers: UserLayer[]; warnings: string[] } {
  const warnings: string[] = [];
  if (raw === undefined) return { layers: [], warnings };
  if (!Array.isArray(raw)) {
    return { layers: [], warnings: ['"layers" is not an array — ignored.'] };
  }
  const layers: UserLayer[] = [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  raw.forEach((entry, i) => {
    const { layer, warnings: w } = validateUserLayer(entry, i);
    warnings.push(...w);
    if (!layer) return;
    let id = layer.id;
    if (seenIds.has(id)) {
      id = newLayerId(layer.name, [...seenIds]);
      warnings.push(`Layer "${layer.name}": duplicate id renamed to "${id}".`);
    }
    seenIds.add(id);
    let name = layer.name;
    if (seenNames.has(name)) {
      let n = 2;
      while (seenNames.has(`${name} (${n})`)) n++;
      const renamed = `${name} (${n})`;
      warnings.push(`Duplicate layer name "${name}" renamed to "${renamed}".`);
      name = renamed;
    }
    seenNames.add(name);
    layers.push({ ...layer, id, name });
  });
  return { layers, warnings };
}

export function serializeViewSidecar(layers: readonly UserLayer[]): string {
  const doc: ViewSidecar = {
    version: VIEW_SIDECAR_VERSION,
    layers: layers.map((l) => ({
      id: l.id,
      name: l.name,
      color: [l.color[0], l.color[1], l.color[2]],
      visible: l.visible,
      locked: l.locked,
      blocks: [...l.blocks],
      parts: [...l.parts],
      ids: {
        Elements: [...l.ids.Elements],
        Conditions: [...l.ids.Conditions],
        Geometries: [...l.ids.Geometries],
      },
    })),
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

/**
 * Parses a `<stem>.kratosview.json` document. Tolerant like `parseCaseJson`:
 * malformed pieces degrade with warnings instead of throwing. A missing or
 * unsupported document leaves the mesh with its ordinary sections (empty list).
 */
export function parseViewSidecar(text: string): { layers: UserLayer[]; warnings: string[]; version?: number } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { layers: [], warnings: ["View sidecar is not valid JSON — ignored."] };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { layers: [], warnings: ["View sidecar is not a JSON object — ignored."] };
  }
  const r = raw as Record<string, unknown>;
  const version = typeof r.version === "number" ? r.version : undefined;
  if (version !== undefined && version > VIEW_SIDECAR_VERSION) {
    return {
      layers: [],
      warnings: [`View sidecar version ${version} is newer than supported (${VIEW_SIDECAR_VERSION}) — layers ignored.`],
      version,
    };
  }
  const { layers, warnings } = validateUserLayers(r.layers);
  if (version === undefined) {
    warnings.unshift("View sidecar has no version — read as version 1.");
  }
  return { layers, warnings, version: version ?? VIEW_SIDECAR_VERSION };
}

/** Block layer ids (`block:<kind>:<name>`) present in the model. */
export function blockLayerIdsOf(model: MdpaModel): Set<string> {
  const out = new Set<string>();
  for (const b of model.blocks) out.add(`block:${b.kind}:${b.name}`);
  return out;
}

function sameNums(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameStrs(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface RefreshReport {
  layerId: string;
  layerName: string;
  prunedBlocks: string[];
  prunedParts: string[];
  prunedIds: KindIdSets;
}

/**
 * Re-evaluates every layer against `model`. Block/part references that no
 * longer exist are pruned, explicit ids intersect the id universes. Returns a
 * NEW list (never mutates the input) plus per-layer prune reports — the
 * selection `refreshSelection` contract.
 */
export function refreshUserLayers(
  model: MdpaModel,
  layers: readonly UserLayer[]
): { layers: UserLayer[]; changed: boolean; reports: RefreshReport[] } {
  const universes = entityUniverses(model);
  const blocks = blockLayerIdsOf(model);
  const out: UserLayer[] = [];
  const reports: RefreshReport[] = [];
  let changed = false;
  for (const l of layers) {
    const keptBlocks = l.blocks.filter((b) => blocks.has(b));
    const prunedBlocks = l.blocks.filter((b) => !blocks.has(b));
    const keptParts: string[] = [];
    const prunedParts: string[] = [];
    for (const p of l.parts) {
      if (findSubModelPart(model, p)) keptParts.push(p);
      else prunedParts.push(p);
    }
    const ids: KindIdSets = { Elements: [], Conditions: [], Geometries: [] };
    const prunedIds: KindIdSets = { Elements: [], Conditions: [], Geometries: [] };
    for (const k of ENTITY_KINDS) {
      for (const id of l.ids[k]) {
        if (universes[k].has(id)) ids[k].push(id);
        else prunedIds[k].push(id);
      }
    }
    const layerChanged =
      !sameStrs(keptBlocks, l.blocks) ||
      !sameStrs(keptParts, l.parts) ||
      !sameNums(ids.Elements, l.ids.Elements) ||
      !sameNums(ids.Conditions, l.ids.Conditions) ||
      !sameNums(ids.Geometries, l.ids.Geometries);
    if (layerChanged) {
      changed = true;
      reports.push({ layerId: l.id, layerName: l.name, prunedBlocks, prunedParts, prunedIds });
    }
    out.push({ ...l, blocks: keptBlocks, parts: keptParts, ids });
  }
  return { layers: out, changed, reports };
}

/** Collects a part subtree's entity ids (elements/conditions/geometries). */
function partSubtreeIds(model: MdpaModel, path: string): KindIdSets | undefined {
  const part = findSubModelPart(model, path);
  if (!part) return undefined;
  const acc: KindIdSets = { Elements: [], Conditions: [], Geometries: [] };
  const walk = (p: typeof part): void => {
    acc.Elements.push(...p.elementIds);
    acc.Conditions.push(...p.conditionIds);
    acc.Geometries.push(...p.geometryIds);
    for (const c of p.children) walk(c);
  };
  walk(part);
  const dedup = (xs: number[]): number[] => Array.from(new Set(xs)).sort((a, b) => a - b);
  return { Elements: dedup(acc.Elements), Conditions: dedup(acc.Conditions), Geometries: dedup(acc.Geometries) };
}

export interface ResolvedLayer {
  /** Union of explicit + block + part entity ids, intersected with the model. */
  elements: number[];
  conditions: number[];
  geometries: number[];
  /** Member base block layer ids that still exist. */
  blockLayerIds: string[];
  /** Member `smp:<path>` layer ids that still exist. */
  smpLayerIds: string[];
  warnings: string[];
}

/**
 * Resolves a layer against the current model for rendering and promotion.
 * Blocks contribute their blocks' entity ids, parts their subtree ids,
 * explicit ids their intersected snapshot. Never throws for a stale reference
 * — it prunes and names it, the refresh rule.
 */
export function resolveUserLayer(model: MdpaModel, layer: UserLayer): ResolvedLayer {
  const warnings: string[] = [];
  const universes = entityUniverses(model);
  const byBlock = new Map<string, typeof model.blocks>();
  for (const b of model.blocks) {
    const id = `block:${b.kind}:${b.name}`;
    const list = byBlock.get(id);
    if (list) list.push(b);
    else byBlock.set(id, [b]);
  }
  const elements = new Set<number>();
  const conditions = new Set<number>();
  const geometries = new Set<number>();
  const blockLayerIds: string[] = [];
  for (const ref of layer.blocks) {
    const found = byBlock.get(ref);
    if (!found) {
      warnings.push(`Block "${ref}" is not in the mesh.`);
      continue;
    }
    blockLayerIds.push(ref);
    for (const b of found) {
      const target = b.kind === "Elements" ? elements : b.kind === "Conditions" ? conditions : geometries;
      for (const id of b.entityIds) target.add(id);
    }
  }
  const smpLayerIds: string[] = [];
  for (const p of layer.parts) {
    const ids = partSubtreeIds(model, p);
    if (!ids) {
      warnings.push(`SubModelPart "${p}" is not in the mesh.`);
      continue;
    }
    smpLayerIds.push(`smp:${p}`);
    for (const id of ids.Elements) if (universes.Elements.has(id)) elements.add(id);
    for (const id of ids.Conditions) if (universes.Conditions.has(id)) conditions.add(id);
    for (const id of ids.Geometries) if (universes.Geometries.has(id)) geometries.add(id);
  }
  for (const id of layer.ids.Elements) if (universes.Elements.has(id)) elements.add(id);
  for (const id of layer.ids.Conditions) if (universes.Conditions.has(id)) conditions.add(id);
  for (const id of layer.ids.Geometries) if (universes.Geometries.has(id)) geometries.add(id);
  const sorted = (s: Set<number>): number[] => (s.size === 0 ? [] : Array.from(s).sort((a, b) => a - b));
  return {
    elements: sorted(elements),
    conditions: sorted(conditions),
    geometries: sorted(geometries),
    blockLayerIds,
    smpLayerIds,
    warnings,
  };
}

/** One short prose line describing what a layer holds (UI rows/toasts). */
export function describeUserLayer(layer: UserLayer): string {
  const bits: string[] = [];
  if (layer.blocks.length > 0) bits.push(`${layer.blocks.length} block(s)`);
  if (layer.parts.length > 0) bits.push(`${layer.parts.length} part(s)`);
  const n = layer.ids.Elements.length + layer.ids.Conditions.length + layer.ids.Geometries.length;
  if (n > 0) bits.push(`${n} pick(s)`);
  if (bits.length === 0) return "empty";
  return bits.join(", ");
}

/** Counts of a layer's explicit snapshot (the UI's row subtitle). */
export function layerCounts(layer: UserLayer): { elements: number; conditions: number; geometries: number; total: number } {
  const elements = layer.ids.Elements.length;
  const conditions = layer.ids.Conditions.length;
  const geometries = layer.ids.Geometries.length;
  return { elements, conditions, geometries, total: elements + conditions + geometries };
}
