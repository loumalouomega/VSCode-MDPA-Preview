/**
 * Native OpenFOAM field-file reader (ASCII `vol*Field` / `point*Field`).
 *
 * Upstream meshio++ reads none of a case's time-directory fields, so a case
 * opened here was geometry-only. These files are plain OpenFOAM dictionaries,
 * so a small native parser is tractable — but it must be strict where it
 * counts: a malformed list must fail the FIELD (diagnostic + skip), never
 * shift later values, and binary / `#include` / `$`-substitution / coded
 * content must refuse rather than misread.
 *
 * Pure (no `vscode`/DOM/fs/wasm); the disk half lives in `openfoamCase.ts`.
 */

import type { MdpaDiagnostic } from "./types";

/** Volume vs point storage domain of a field file's `FoamFile.class`. */
export type OpenFoamFieldDomain = "vol" | "point" | "surface" | "unsupported";

/** A successfully parsed field file (internal may be absent for boundary-only files). */
export interface OpenFoamParsedField {
  /** `FoamFile.object` (the variable name); falls back to the file name. */
  object: string;
  /** Raw `FoamFile.class` string, e.g. `volScalarField`. */
  className: string;
  domain: OpenFoamFieldDomain;
  /** Tuple width: 1 scalar, 3 vector, 6 symmTensor, 9 tensor. */
  components: number;
  internal?:
    | { kind: "uniform"; values: number[] }
    | { kind: "nonuniform"; count: number; values: Float64Array };
  /** Patch name -> uniform tuple (boundary `value uniform ...` only). */
  boundaryUniform: Map<string, number[]>;
}

const CLASS_TABLE: Record<string, { domain: OpenFoamFieldDomain; components: number }> = {
  volScalarField: { domain: "vol", components: 1 },
  volVectorField: { domain: "vol", components: 3 },
  volTensorField: { domain: "vol", components: 9 },
  volSymmTensorField: { domain: "vol", components: 6 },
  volSphericalTensorField: { domain: "vol", components: 1 },
  pointScalarField: { domain: "point", components: 1 },
  pointVectorField: { domain: "point", components: 3 },
  pointTensorField: { domain: "point", components: 9 },
  surfaceScalarField: { domain: "surface", components: 1 },
  surfaceVectorField: { domain: "surface", components: 3 },
  surfaceTensorField: { domain: "surface", components: 9 },
};

/** Drops `/* … *​/` and `// …` so brace/paren matching cannot trip over them. */
export function stripFoamComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** Index just past the matching close for the open brace/paren at `open`, or -1. */
export function matchFoamBrace(text: string, open: number, kind: "{" | "(" = "{"): number {
  const close = kind === "{" ? "}" : ")";
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === kind) depth++;
    else if (text[i] === close && --depth === 0) return i + 1;
  }
  return -1;
}

const NUM_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function parseNumbers(tokens: string[], label: string, diagnostics: MdpaDiagnostic[]): number[] | undefined {
  const out: number[] = [];
  for (const t of tokens) {
    if (!NUM_RE.test(t) || /nan|inf/i.test(t)) {
      diagnostics.push({ line: 0, message: `${label}: malformed number "${t}"; field skipped.` });
      return undefined;
    }
    const v = Number(t);
    if (!Number.isFinite(v)) {
      diagnostics.push({ line: 0, message: `${label}: non-finite value; field skipped.` });
      return undefined;
    }
    out.push(v);
  }
  return out;
}

/** Parses a `(a b c)` tuple of exactly `width` finite numbers; undefined on any failure. */
function parseTuple(text: string, width: number, label: string, diagnostics: MdpaDiagnostic[]): number[] | undefined {
  const m = /\(\s*([^()]*)\)/.exec(text);
  if (!m) {
    diagnostics.push({ line: 0, message: `${label}: expected a (${width}) tuple; field skipped.` });
    return undefined;
  }
  const tokens = m[1].trim().split(/\s+/).filter(Boolean);
  if (tokens.length !== width) {
    diagnostics.push({
      line: 0,
      message: `${label}: expected ${width} value(s), got ${tokens.length}; field skipped.`,
    });
    return undefined;
  }
  return parseNumbers(tokens, label, diagnostics);
}

/**
 * Parses one ASCII field file. Never throws for a data problem: an unsupported
 * or malformed file yields `undefined` plus a diagnostic, so the caller keeps
 * the geometry and skips the field (the tolerant-parser policy used everywhere
 * here for untrusted disk input).
 *
 * `fallbackName` is the file name (`U`, `p`, `T`, …), used when the file has no
 * `FoamFile.object` and in every diagnostic label.
 */
export function parseFoamField(
  text: string,
  fallbackName: string,
  diagnostics: MdpaDiagnostic[]
): OpenFoamParsedField | undefined {
  const label = `OpenFOAM field "${fallbackName}"`;
  const src = stripFoamComments(text);

  if (/\bformat\s+binary\b/.test(src)) {
    diagnostics.push({ line: 0, message: `${label}: binary format is not read; field skipped.` });
    return undefined;
  }
  if (/^\s*#\s*(include|includeIfPresent|codeStream|calc|remove)/m.test(src)) {
    diagnostics.push({ line: 0, message: `${label}: uses a directive that is not resolved here; field skipped.` });
    return undefined;
  }
  if (/\$[A-Za-z_{]/.test(src)) {
    diagnostics.push({ line: 0, message: `${label}: uses variable substitution that is not resolved here; field skipped.` });
    return undefined;
  }

  const object = /\bobject\s+([A-Za-z_][\w.\-]*)\s*;/.exec(src)?.[1] ?? fallbackName;
  const className = /\bclass\s+([A-Za-z_]\w*)\s*;/.exec(src)?.[1];
  if (!className) {
    diagnostics.push({ line: 0, message: `${label}: no FoamFile.class; field skipped.` });
    return undefined;
  }
  const entry = CLASS_TABLE[className];
  if (!entry) {
    diagnostics.push({ line: 0, message: `${label}: class "${className}" is not read; field skipped.` });
    return undefined;
  }
  if (entry.domain === "surface" || entry.domain === "unsupported") {
    diagnostics.push({
      line: 0,
      message: `${label}: class "${className}" has no volume/point equivalent here; field skipped.`,
    });
    return undefined;
  }
  const { domain, components } = entry;

  // ---- internalField ------------------------------------------------------
  let internal: OpenFoamParsedField["internal"];
  const im = /internalField\s+(uniform|nonuniform)\b/.exec(src);
  if (!im) {
    diagnostics.push({ line: 0, message: `${label}: no internalField; volume values skipped.` });
  } else if (im[1] === "uniform") {
    const rest = src.slice(im.index + im[0].length);
    const semi = rest.indexOf(";");
    if (semi < 0) {
      diagnostics.push({ line: 0, message: `${label}: unterminated uniform internalField; field skipped.` });
      return undefined;
    }
    const body = rest.slice(0, semi).trim();
    const values = components === 1
      ? parseNumbers(body.split(/\s+/).filter(Boolean), label, diagnostics)
      : parseTuple(body, components, label, diagnostics);
    if (!values) return undefined;
    if (components === 1 && values.length !== 1) {
      diagnostics.push({ line: 0, message: `${label}: expected 1 value, got ${values.length}; field skipped.` });
      return undefined;
    }
    internal = { kind: "uniform", values };
  } else {
    const rest = src.slice(im.index + im[0].length);
    // Ordinary form: `List<scalar|vector|…> N (...)`. `0()` is the empty field.
    const empty = /^\s*0\s*\(\s*\)/.exec(rest);
    if (empty) {
      internal = { kind: "nonuniform", count: 0, values: new Float64Array(0) };
    } else {
      const lm = /^\s*List<\s*(scalar|vector|tensor|symmTensor|sphericalTensor)\s*>\s*(\d+)\s*\(/.exec(rest);
      if (!lm) {
        diagnostics.push({ line: 0, message: `${label}: unsupported nonuniform internalField form; field skipped.` });
        return undefined;
      }
      const widths: Record<string, number> = {
        scalar: 1, vector: 3, tensor: 9, symmTensor: 6, sphericalTensor: 1,
      };
      const listWidth = widths[lm[1]];
      if (listWidth !== components) {
        diagnostics.push({
          line: 0,
          message: `${label}: ${className} with List<${lm[1]}> (width ${listWidth}); field skipped.`,
        });
        return undefined;
      }
      const count = parseInt(lm[2], 10);
      const listOpen = rest.indexOf("(", lm.index);
      const end = matchFoamBrace(rest, listOpen, "(");
      if (end < 0) {
        diagnostics.push({ line: 0, message: `${label}: unterminated nonuniform list; field skipped.` });
        return undefined;
      }
      const body = rest.slice(listOpen + 1, end - 1);
      let flat: number[] | undefined;
      if (listWidth === 1) {
        const tokens = body.trim().split(/\s+/).filter(Boolean);
        if (tokens.length !== count) {
          diagnostics.push({
            line: 0,
            message: `${label}: declares ${count} value(s) but holds ${tokens.length}; field skipped.`,
          });
          return undefined;
        }
        flat = parseNumbers(tokens, label, diagnostics);
      } else {
        const tuples = [...body.matchAll(/\(([^()]*)\)/g)];
        if (tuples.length !== count) {
          diagnostics.push({
            line: 0,
            message: `${label}: declares ${count} tuple(s) but holds ${tuples.length}; field skipped.`,
          });
          return undefined;
        }
        flat = [];
        for (const t of tuples) {
          const tokens = t[1].trim().split(/\s+/).filter(Boolean);
          if (tokens.length !== listWidth) {
            diagnostics.push({
              line: 0,
              message: `${label}: expected ${listWidth} value(s) per tuple, got ${tokens.length}; field skipped.`,
            });
            return undefined;
          }
          const nums = parseNumbers(tokens, label, diagnostics);
          if (!nums) return undefined;
          flat.push(...nums);
        }
      }
      if (!flat) return undefined;
      internal = { kind: "nonuniform", count, values: new Float64Array(flat) };
    }
  }

  // ---- boundaryField (uniform patch values only) ---------------------------
  const boundaryUniform = new Map<string, number[]>();
  let skippedBoundary = 0;
  const bi = src.indexOf("boundaryField");
  if (bi >= 0) {
    const open = src.indexOf("{", bi);
    const end = open >= 0 ? matchFoamBrace(src, open, "{") : -1;
    if (end > 0) {
      const body = src.slice(open + 1, end - 1);
      const name = /([A-Za-z_][\w.\-]*)\s*\{/g;
      let cursor = 0;
      for (;;) {
        name.lastIndex = cursor;
        const m = name.exec(body);
        if (!m) break;
        const braceAt = body.indexOf("{", m.index);
        const close = matchFoamBrace(body, braceAt, "{");
        if (close < 0) { skippedBoundary++; break; }
        const entryBody = body.slice(braceAt, close);
        const vm = /value\s+uniform\s+([^;]+);/.exec(entryBody);
        if (vm) {
          const raw = vm[1].trim();
          // A patch value uses the same class width as the internal field.
          const vals = components === 1
            ? parseNumbers(raw.split(/\s+/).filter(Boolean), `${label} patch "${m[1]}"`, diagnostics)
            : parseTuple(raw, components, `${label} patch "${m[1]}"`, diagnostics);
          if (vals) boundaryUniform.set(m[1], vals);
          else skippedBoundary++;
        } else if (/value\s+nonuniform/.test(entryBody)) {
          // Patch-local nonuniform values are ordered by the patch's own face
          // order, which does not survive the meshio regrouping — defer rather
          // than silently misassign.
          skippedBoundary++;
        }
        cursor = close;
      }
    }
  }

  if (!internal && boundaryUniform.size === 0) return undefined;
  if (skippedBoundary > 0) {
    diagnostics.push({
      line: 0,
      message:
        `${label}: ${skippedBoundary} patch value(s) are not a uniform value and were skipped ` +
        `(only "value uniform ..." becomes a boundary field).`,
    });
  }
  return { object, className, domain, components, internal, boundaryUniform };
}

/** Filenames worth trying as fields inside a time directory (plus any other regular file found). */
export const FOAM_KNOWN_FIELD_FILES = ["U", "p", "T", "k", "epsilon", "omega", "nut", "alpha"] as const;
