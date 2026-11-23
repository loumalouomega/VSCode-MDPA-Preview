/**
 * Additional solver settings per case (roadmap item 80): a raw JSON object per
 * solver document, merged last with RFC 7386 JSON Merge Patch rules.
 *
 * Pure module: no vscode / DOM / fs imports, so the sidebar, preflight, MCP and
 * the generator share one parser, one merge and one list of changed paths.
 *
 * The patch is kept as text in the case state so a half-typed value survives.
 * Empty/whitespace text is not a patch: it is skipped before parsing, which is
 * what keeps an empty box byte-identical to a case without one.
 */

import { primaryDocumentName, solverDocumentNames } from "./documentNames";
import type {
  AdditionalSettingsChange,
  AdditionalSettingsOverride,
  AdditionalSettingsReport,
  CaseState,
  JsonObject,
  JsonValue,
  ProblemtypeDeclaration,
} from "./types";

export interface PatchProblem {
  /** The document the patch names; "(case)" when the field itself is malformed. */
  document: string;
  message: string;
  /** Character offset in the text, when the problem is a parse error. */
  position?: number;
  line?: number;
  column?: number;
}

export interface ParsedPatch {
  patch?: JsonObject;
  problem?: PatchProblem;
}

export interface AdditionalSettingsCheck {
  /** Document name → parsed patch (only non-empty, valid entries). */
  patches: Map<string, JsonObject>;
  problems: PatchProblem[];
  /** Documents whose entry must be ignored by a dry run. */
  invalidDocuments: Set<string>;
  /** True when `additionalSettings` itself is not an object. */
  invalidCase?: boolean;
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function lineColumn(text: string, position: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, position));
  const line = before.split("\n").length;
  const last = before.lastIndexOf("\n");
  return { line, column: position - last };
}

function problem(document: string, message: string, text?: string, position?: number): PatchProblem {
  if (position === undefined || text === undefined) return { document, message };
  const { line, column } = lineColumn(text, position);
  return { document, message: `${message} (line ${line} column ${column})`, position, line, column };
}

/**
 * Where a JSON syntax error is. V8 reports `at position N` for most errors but
 * not for `Unexpected token 'X'`, where the offending token is the one to point
 * at. A last-resort offset (the end of the text) keeps every refusal positioned.
 */
function syntaxErrorPosition(raw: string, text: string): number {
  const at = /at position (\d+)/.exec(raw);
  if (at) return Number(at[1]);
  const token = /Unexpected token '(.+?)'/.exec(raw)?.[1];
  const found = token === undefined ? -1 : text.lastIndexOf(token);
  return found >= 0 ? found : text.length;
}

/** Walks a parsed value, refusing prototype keys and non-finite numbers. */
function inspect(value: JsonValue, document: string, text: string): PatchProblem | undefined {
  if (typeof value === "number" && !Number.isFinite(value)) {
    return problem(document, "Additional settings contain a number that is not finite.", text, 0);
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const p = inspect(v, document, text);
      if (p) return p;
    }
    return undefined;
  }
  if (isRecord(value)) {
    for (const [key, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        const found = text.indexOf(JSON.stringify(key));
        return problem(document, `Additional settings must not use the key "${key}".`, text, found >= 0 ? found : 0);
      }
      const p = inspect(v as JsonValue, document, text);
      if (p) return p;
    }
  }
  return undefined;
}

/** Parses one document's patch text; empty text is neither a patch nor a problem. */
export function parsePatchText(text: string, document: string): ParsedPatch {
  if (text.trim().length === 0) return {};
  let value: JsonValue;
  try {
    value = JSON.parse(text) as JsonValue;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const message = raw.replace(/\s+at position \d+.*$/, "");
    return {
      problem: problem(document, `Additional settings for "${document}" are not valid JSON: ${message}.`, text, syntaxErrorPosition(raw, text)),
    };
  }
  if (!isRecord(value)) {
    const kind = Array.isArray(value) ? "an array" : value === null ? "null" : typeof value;
    const first = text.search(/\S/);
    return { problem: problem(document, `Additional settings for "${document}" must be a JSON object, not ${kind}.`, text, first >= 0 ? first : 0) };
  }
  const bad = inspect(value as JsonValue, document, text);
  if (bad) return { problem: bad };
  return { patch: value as JsonObject };
}

/**
 * The document names a case may patch, in card order: the declaration's list
 * first, then any extra key already in the state (a hand-edited case) so the
 * sidebar can show it rather than hide it.
 */
export function additionalSettingsDocuments(
  decl: ProblemtypeDeclaration,
  state: Pick<CaseState, "additionalSettings">
): string[] {
  const declared = solverDocumentNames(decl);
  const known = new Set(declared);
  const raw: unknown = state.additionalSettings;
  const extra = isRecord(raw) ? Object.keys(raw).filter((d) => !known.has(d)) : [];
  return [...declared, ...extra];
}

/** Parses every non-empty entry of a case; unknown documents are problems. */
export function checkAdditionalSettings(
  decl: ProblemtypeDeclaration,
  state: Pick<CaseState, "additionalSettings">
): AdditionalSettingsCheck {
  const patches = new Map<string, JsonObject>();
  const problems: PatchProblem[] = [];
  const invalidDocuments = new Set<string>();
  const raw: unknown = state.additionalSettings;
  if (raw === undefined) return { patches, problems, invalidDocuments };
  if (!isRecord(raw)) {
    problems.push({ document: "(case)", message: "Additional settings must be an object of document name → JSON text." });
    return { patches, problems, invalidDocuments, invalidCase: true };
  }
  const known = solverDocumentNames(decl);
  for (const [document, text] of Object.entries(raw)) {
    if (typeof text !== "string") {
      problems.push({ document, message: `Additional settings for "${document}" must be text.` });
      invalidDocuments.add(document);
      continue;
    }
    if (text.trim().length === 0) continue;
    if (!known.includes(document)) {
      problems.push({
        document,
        message: `Additional settings name "${document}", which "${decl.id}" does not write. It writes: ${known.join(", ")}.`,
      });
      invalidDocuments.add(document);
      continue;
    }
    const parsed = parsePatchText(text, document);
    if (parsed.problem) {
      problems.push(parsed.problem);
      invalidDocuments.add(document);
      continue;
    }
    if (parsed.patch) patches.set(document, parsed.patch);
  }
  return { patches, problems, invalidDocuments };
}

/**
 * A copy of the state with the entries a dry run cannot use removed, so the
 * rest of preflight still reports on the case. Valid patches stay in place.
 */
export function withoutInvalidAdditionalSettings(
  state: CaseState,
  check: AdditionalSettingsCheck
): CaseState {
  if (check.invalidCase) {
    const rest: CaseState = { ...state };
    delete rest.additionalSettings;
    return rest;
  }
  if (check.invalidDocuments.size === 0) return state;
  const map: Record<string, string> = { ...(state.additionalSettings ?? {}) };
  for (const document of check.invalidDocuments) delete map[document];
  const rest: CaseState = { ...state };
  delete rest.additionalSettings;
  return Object.keys(map).length > 0 ? { ...rest, additionalSettings: map } : rest;
}

/**
 * RFC 7386 JSON Merge Patch. Returns a new value; neither `target` nor `patch`
 * is modified. A non-object patch replaces the target, though the case parser
 * refuses one at the root.
 */
export function applyMergePatch(target: JsonValue, patch: JsonValue): JsonValue {
  if (!isRecord(patch)) return patch;
  const base = isRecord(target) ? target : {};
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(base)) {
    if (!FORBIDDEN_KEYS.has(key)) out[key] = value as JsonValue;
  }
  for (const [key, value] of Object.entries(patch)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    if (value === null) delete out[key];
    else out[key] = applyMergePatch(out[key] ?? null, value as JsonValue);
  }
  return out;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A dotted path; a key that is not an identifier is written as `["a.b"]`. */
export function formatPath(segments: readonly string[]): string {
  let out = "";
  for (const segment of segments) {
    if (IDENT.test(segment)) out += out ? `.${segment}` : segment;
    else out += `[${JSON.stringify(segment)}]`;
  }
  return out || "(root)";
}

function same(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Every leaf that changed between two documents, in path order. Objects recurse
 * only when both sides are objects; arrays and scalars report at their own path
 * (JSON Merge Patch replaces them whole). A no-op patch yields no changes.
 */
export function diffDocuments(
  before: JsonValue,
  after: JsonValue
): Omit<AdditionalSettingsChange, "document">[] {
  const out: Omit<AdditionalSettingsChange, "document">[] = [];
  const walk = (a: JsonValue | undefined, b: JsonValue | undefined, path: string[]): void => {
    if (a === undefined && b === undefined) return;
    if (a === undefined) {
      out.push({ path: formatPath(path), action: "set", existing: false, value: b });
      return;
    }
    if (b === undefined) {
      out.push({ path: formatPath(path), action: "remove", existing: true });
      return;
    }
    if (isRecord(a) && isRecord(b)) {
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
      for (const key of keys) walk(a[key] as JsonValue, b[key] as JsonValue, [...path, key]);
      return;
    }
    if (!same(a, b)) out.push({ path: formatPath(path), action: "set", existing: true, value: b });
  };
  walk(before, after, []);
  return out;
}

/** A short JSON rendering for a finding message. */
export function previewValue(value: JsonValue | undefined, limit = 120): string {
  const text = value === undefined ? "null" : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3))}...` : text;
}

export interface AppliedAdditionalSettings {
  /** The primary document after the merge. */
  primary: JsonValue;
  /** The extra files after the merge (the materials files are not in here). */
  extraFiles: { name: string; content: string }[];
  /** Changes per document; absent when no patch changed anything. */
  report?: AdditionalSettingsReport;
  /** Everything that makes Generate refuse, one entry per problem. */
  problems: PatchProblem[];
}

/**
 * Applies every valid patch to the generated documents. The caller refuses the
 * case when `problems` is non-empty; the valid patches may still be applied so
 * a dry run can report on them.
 */
export function applyAdditionalSettings(
  decl: ProblemtypeDeclaration,
  state: Pick<CaseState, "additionalSettings">,
  primary: JsonValue,
  extraFiles: { name: string; content: string }[]
): AppliedAdditionalSettings {
  const check = checkAdditionalSettings(decl, state);
  const problems = [...check.problems];
  const documents: AdditionalSettingsReport["documents"] = [];
  let nextPrimary = primary;
  const nextExtra = extraFiles.map((f) => ({ ...f }));
  const primaryName = primaryDocumentName(decl);

  for (const document of solverDocumentNames(decl)) {
    const patch = check.patches.get(document);
    if (!patch) continue;
    if (document === primaryName) {
      const after = applyMergePatch(nextPrimary, patch);
      const changes = diffDocuments(nextPrimary, after).map((c) => ({ ...c, document }));
      if (changes.length > 0) {
        nextPrimary = after;
        documents.push({ name: document, changes });
      }
      continue;
    }
    const file = nextExtra.find((f) => f.name === document);
    if (!file) {
      problems.push({
        document,
        message: `Additional settings for "${document}" cannot be applied: the problemtype declares it but Generate did not write it.`,
      });
      continue;
    }
    let before: JsonValue;
    try {
      before = JSON.parse(file.content) as JsonValue;
    } catch {
      problems.push({
        document,
        message: `Additional settings for "${document}" cannot be applied: its generated content is not JSON.`,
      });
      continue;
    }
    if (!isRecord(before)) {
      problems.push({
        document,
        message: `Additional settings for "${document}" cannot be applied: its generated content is not a JSON object.`,
      });
      continue;
    }
    const after = applyMergePatch(before, patch);
    const changes = diffDocuments(before, after).map((c) => ({ ...c, document }));
    if (changes.length === 0) continue;
    file.content = JSON.stringify(after, null, 4) + "\n";
    documents.push({ name: document, changes });
  }

  return {
    primary: nextPrimary,
    extraFiles: nextExtra,
    ...(documents.length > 0 ? { report: { documents } } : {}),
    problems,
  };
}

/** The overridden subset of a report, for `case_validate`. */
export function overridesFromReport(report: AdditionalSettingsReport | undefined): AdditionalSettingsOverride[] {
  const out: AdditionalSettingsOverride[] = [];
  for (const document of report?.documents ?? []) {
    for (const change of document.changes) {
      if (change.existing) out.push({ document: change.document, path: change.path, action: change.action });
    }
  }
  return out;
}
