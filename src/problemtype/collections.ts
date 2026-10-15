/**
 * Collections: repeatable lists of named entries in a case (see
 * `CollectionSpec` in types.ts). This module is the one rulebook for them —
 * the webview editor, the generator, preflight and MCP all call it, so an entry
 * the editor flags is exactly one Generate refuses.
 *
 * Pure module: no vscode / DOM / node imports.
 */

import { dottedModelPart, fieldDefault } from "./api";
import type {
  CaseState,
  CollectionEntry,
  CollectionEntryTypeSpec,
  CollectionSpec,
  FieldSpec,
  JsonValue,
  ProblemtypeDeclaration,
  ResolvedCollectionEntry,
} from "./types";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Entry names reach Kratos as component names (`response_function.<name>`,
 * summary columns `<name>:value`), so they are identifiers: no spaces, no dots,
 * no colons.
 */
export function isValidEntryName(name: unknown): name is string {
  return typeof name === "string" && IDENTIFIER.test(name);
}

export function collectionSpec(decl: ProblemtypeDeclaration, id: string): CollectionSpec | undefined {
  return decl.collections?.find((c) => c.id === id);
}

export function entryTypeOf(spec: CollectionSpec, type: string): CollectionEntryTypeSpec | undefined {
  return spec.entryTypes.find((t) => t.id === type);
}

/** The entries of one collection in a case (empty when absent). */
export function entriesOf(state: CaseState, collectionId: string): CollectionEntry[] {
  return state.collections?.[collectionId] ?? [];
}

/** A name not yet used in the collection: `base`, then `base_2`, `base_3`… */
export function uniqueEntryName(state: CaseState, collectionId: string, base: string): string {
  const clean = base.replace(/[^A-Za-z0-9_]/g, "_").replace(/^([^A-Za-z_])/, "_$1") || "entry";
  const taken = new Set(entriesOf(state, collectionId).map((e) => e.name));
  if (!taken.has(clean)) return clean;
  for (let i = 2; ; i++) if (!taken.has(`${clean}_${i}`)) return `${clean}_${i}`;
}

/** A new entry of a type with every field at its default (no parts). */
export function newEntry(spec: CollectionSpec, type: string, name: string): CollectionEntry {
  const t = entryTypeOf(spec, type);
  const values: Record<string, JsonValue> = {};
  for (const f of t?.fields ?? []) values[f.id] = fieldDefault(f);
  return { name, type, parts: [], values };
}

/** One entry's values with the type's defaults merged in. */
export function entryValues(spec: CollectionSpec, e: CollectionEntry): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const f of entryTypeOf(spec, e.type)?.fields ?? []) {
    out[f.id] = e.values?.[f.id] !== undefined ? e.values[f.id] : fieldDefault(f);
  }
  return out;
}

/** Every collection of a case as hooks see it: defaults merged, parts also dotted under `root`. */
export function resolveCollections(
  decl: ProblemtypeDeclaration,
  state: CaseState,
  root: string
): Record<string, ResolvedCollectionEntry[]> {
  const out: Record<string, ResolvedCollectionEntry[]> = {};
  for (const spec of decl.collections ?? []) {
    out[spec.id] = entriesOf(state, spec.id).map((e) => ({
      name: e.name,
      type: e.type,
      parts: [...(e.parts ?? [])],
      modelParts: (e.parts ?? []).map((p) => dottedModelPart(root, p)),
      values: entryValues(spec, e),
    }));
  }
  return out;
}

/** Every `ref` field naming `collectionId`, with where it lives. */
function refFields(decl: ProblemtypeDeclaration, collectionId: string): {
  sections: { sectionId: string; field: FieldSpec }[];
  entries: { collectionId: string; typeId: string; field: FieldSpec }[];
} {
  const sections: { sectionId: string; field: FieldSpec }[] = [];
  const entries: { collectionId: string; typeId: string; field: FieldSpec }[] = [];
  for (const s of decl.sections) {
    for (const f of s.fields) if (f.type === "ref" && f.refCollection === collectionId) sections.push({ sectionId: s.id, field: f });
  }
  for (const c of decl.collections ?? []) {
    for (const t of c.entryTypes) {
      for (const f of t.fields) if (f.type === "ref" && f.refCollection === collectionId) entries.push({ collectionId: c.id, typeId: t.id, field: f });
    }
  }
  return { sections, entries };
}

/**
 * Renames an entry and rewrites every `ref` value that named it, in sections
 * and in other entries. Returns a new state; refuses (returns undefined) an
 * invalid or already-taken name, so a rename can never leave a dangling ref.
 */
export function renameEntry(
  decl: ProblemtypeDeclaration,
  state: CaseState,
  collectionId: string,
  oldName: string,
  newName: string
): CaseState | undefined {
  if (oldName === newName) return state;
  if (!isValidEntryName(newName)) return undefined;
  const list = entriesOf(state, collectionId);
  if (!list.some((e) => e.name === oldName) || list.some((e) => e.name === newName)) return undefined;
  const next: CaseState = {
    ...state,
    values: Object.fromEntries(Object.entries(state.values).map(([k, v]) => [k, { ...v }])),
    collections: Object.fromEntries(
      Object.entries(state.collections ?? {}).map(([k, v]) => [k, v.map((e) => ({ ...e, parts: [...e.parts], values: { ...e.values } }))])
    ),
  };
  for (const e of next.collections![collectionId]) if (e.name === oldName) e.name = newName;
  const { sections, entries } = refFields(decl, collectionId);
  for (const { sectionId, field } of sections) {
    const section = next.values[sectionId];
    if (section && section[field.id] === oldName) section[field.id] = newName;
  }
  for (const { collectionId: owner, typeId, field } of entries) {
    for (const e of next.collections![owner] ?? []) {
      if (e.type === typeId && e.values[field.id] === oldName) e.values[field.id] = newName;
    }
  }
  return next;
}

export type CollectionProblemCode =
  | "collection-count"
  | "collection-name"
  | "collection-duplicate"
  | "collection-type"
  | "collection-parts-count"
  | "collection-part-missing"
  | "collection-ref";

export interface CollectionProblem {
  code: CollectionProblemCode;
  message: string;
  collectionId: string;
  entry?: string;
  smpPath?: string;
}

/**
 * Every reference to a collection entry that names no entry. An EMPTY ref is
 * dangling too: a section that asks for a ref (an objective) is never optional.
 */
export function danglingRefs(decl: ProblemtypeDeclaration, state: CaseState): CollectionProblem[] {
  const out: CollectionProblem[] = [];
  for (const c of decl.collections ?? []) {
    const names = new Set(entriesOf(state, c.id).map((e) => e.name));
    const { sections, entries } = refFields(decl, c.id);
    for (const { sectionId, field } of sections) {
      const v = state.values[sectionId]?.[field.id] ?? fieldDefault(field);
      if (typeof v !== "string" || !names.has(v)) {
        const section = decl.sections.find((s) => s.id === sectionId);
        out.push({
          code: "collection-ref",
          collectionId: c.id,
          message: v === "" || v === undefined
            ? `${section?.label ?? sectionId} › ${field.label}: choose one of the ${c.label.toLowerCase()}.`
            : `${section?.label ?? sectionId} › ${field.label} names "${String(v)}", which is not one of the ${c.label.toLowerCase()}.`,
        });
      }
    }
    for (const { collectionId: owner, typeId, field } of entries) {
      const ownerSpec = collectionSpec(decl, owner);
      for (const e of entriesOf(state, owner)) {
        if (e.type !== typeId) continue;
        const v = e.values?.[field.id] ?? fieldDefault(field);
        if (typeof v !== "string" || !names.has(v)) {
          out.push({
            code: "collection-ref",
            collectionId: owner,
            entry: e.name,
            message: v === ""
              ? `${ownerSpec?.label ?? owner} "${e.name}": choose its ${field.label.toLowerCase()}.`
              : `${ownerSpec?.label ?? owner} "${e.name}": ${field.label.toLowerCase()} "${String(v)}" is not one of the ${c.label.toLowerCase()}.`,
          });
        }
      }
    }
  }
  return out;
}

/**
 * Everything wrong with a case's collections: entry counts, names, types, part
 * counts, parts missing from the mesh, and dangling refs. `subModelParts` is
 * the mesh's slash paths; pass undefined to skip the mesh check.
 */
export function collectionProblems(
  decl: ProblemtypeDeclaration,
  state: CaseState,
  subModelParts?: readonly string[]
): CollectionProblem[] {
  const out: CollectionProblem[] = [];
  const mesh = subModelParts ? new Set(subModelParts) : undefined;
  for (const c of decl.collections ?? []) {
    const list = entriesOf(state, c.id);
    if (c.min !== undefined && list.length < c.min) {
      out.push({ code: "collection-count", collectionId: c.id, message: `${c.label}: add at least ${c.min} (there ${list.length === 1 ? "is" : "are"} ${list.length}).` });
    }
    if (c.max !== undefined && list.length > c.max) {
      out.push({ code: "collection-count", collectionId: c.id, message: `${c.label}: at most ${c.max} allowed (there are ${list.length}).` });
    }
    const seen = new Set<string>();
    for (const e of list) {
      if (!isValidEntryName(e.name)) {
        out.push({ code: "collection-name", collectionId: c.id, entry: String(e.name), message: `${c.label}: "${String(e.name)}" is not a valid name (letters, digits and _; not starting with a digit).` });
      } else if (seen.has(e.name)) {
        out.push({ code: "collection-duplicate", collectionId: c.id, entry: e.name, message: `${c.label}: the name "${e.name}" is used twice.` });
      }
      seen.add(e.name);
      const type = entryTypeOf(c, e.type);
      if (!type) {
        out.push({ code: "collection-type", collectionId: c.id, entry: e.name, message: `${c.label} "${e.name}": unknown type "${e.type}".` });
        continue;
      }
      const parts = e.parts ?? [];
      if (!type.parts && parts.length > 0) {
        out.push({ code: "collection-parts-count", collectionId: c.id, entry: e.name, message: `${c.label} "${e.name}": a ${type.label.toLowerCase()} takes no SubModelParts.` });
      }
      if (type.parts) {
        const min = type.parts.min ?? 0;
        if (parts.length < min) {
          out.push({ code: "collection-parts-count", collectionId: c.id, entry: e.name, message: `${c.label} "${e.name}": assign at least ${min} SubModelPart${min === 1 ? "" : "s"} as ${type.parts.label.toLowerCase()}.` });
        }
        if (type.parts.max !== undefined && parts.length > type.parts.max) {
          out.push({ code: "collection-parts-count", collectionId: c.id, entry: e.name, message: `${c.label} "${e.name}": at most ${type.parts.max} SubModelPart${type.parts.max === 1 ? "" : "s"} as ${type.parts.label.toLowerCase()}.` });
        }
      }
      if (mesh) {
        for (const p of parts) {
          if (!mesh.has(p)) out.push({ code: "collection-part-missing", collectionId: c.id, entry: e.name, smpPath: p, message: `${c.label} "${e.name}": SubModelPart "${p}" is not in the mesh.` });
        }
        for (const f of type.fields) {
          if (f.type !== "smp" && f.type !== "smpList") continue;
          const v = e.values?.[f.id];
          const paths = f.type === "smp" ? (typeof v === "string" && v ? [v] : []) : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
          for (const p of paths) {
            if (!mesh.has(p)) out.push({ code: "collection-part-missing", collectionId: c.id, entry: e.name, smpPath: p, message: `${c.label} "${e.name}": ${f.label.toLowerCase()} "${p}" is not in the mesh.` });
          }
        }
      }
    }
  }
  out.push(...danglingRefs(decl, state));
  return out;
}

/** Parses a comma/whitespace-separated list typed into a list field. */
export function parseListText(text: string, kind: "numberList" | "stringList"): JsonValue[] {
  const tokens = text.split(/[,;\s]+/).map((t) => t.trim()).filter((t) => t.length > 0);
  if (kind === "stringList") return tokens;
  return tokens.map(Number).filter((n) => Number.isFinite(n));
}

/** The inverse of `parseListText` for drawing a list field. */
export function formatListValue(v: JsonValue | undefined): string {
  return Array.isArray(v) ? v.map((x) => String(x)).join(", ") : "";
}
