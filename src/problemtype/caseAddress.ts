/**
 * Addresses of numeric values in a case — the target of a `caseValue` field
 * (a ROM parameter names the value it varies). Pure, so the webview picker,
 * the generator and MCP share one spelling:
 *
 *   section:<sectionId>/<fieldId>[i]
 *   assignment:<conditionId>@<smpPath>/<fieldId>[i]
 *   material:<smpPath>/<variable>[i]
 *
 * `[i]` selects one component of a vector3 value and is absent for a scalar.
 * A SubModelPart path may itself contain "/", so the field id is always the
 * segment after the LAST "/". An assignment address names the first assignment
 * of that condition on that part (preflight already reports duplicates).
 */

import { fieldDefault } from "./api";
import type { Assignment, CaseState, FieldSpec, JsonValue, MaterialAssignment, ProblemtypeDeclaration } from "./types";

export type CaseAddress =
  | { kind: "section"; sectionId: string; fieldId: string; component?: number }
  | { kind: "assignment"; conditionId: string; smpPath: string; fieldId: string; component?: number }
  | { kind: "material"; smpPath: string; fieldId: string; component?: number };

export interface CaseValueOption {
  address: string;
  /** Human label, e.g. "Pressure on Load/Top · Pressure". */
  label: string;
  /** Picker group: the section label, "Conditions" or "Materials". */
  group: string;
  /** The value the case holds now (defaults merged). */
  value: number;
}

const COMPONENT = ["x", "y", "z"];

function splitComponent(s: string): { base: string; component?: number } {
  const m = /^(.*)\[(\d)\]$/.exec(s);
  if (!m) return { base: s };
  const component = Number(m[2]);
  return component <= 2 ? { base: m[1], component } : { base: s };
}

function splitField(s: string): { head: string; fieldId: string } | undefined {
  const at = s.lastIndexOf("/");
  if (at <= 0 || at === s.length - 1) return undefined;
  return { head: s.slice(0, at), fieldId: s.slice(at + 1) };
}

export function parseCaseAddress(address: string): CaseAddress | undefined {
  if (typeof address !== "string") return undefined;
  const colon = address.indexOf(":");
  if (colon < 0) return undefined;
  const kind = address.slice(0, colon);
  const { base, component } = splitComponent(address.slice(colon + 1));
  const parts = splitField(base);
  if (!parts) return undefined;
  if (kind === "section") {
    if (parts.head.includes("/")) return undefined;
    return { kind, sectionId: parts.head, fieldId: parts.fieldId, component };
  }
  if (kind === "assignment") {
    const at = parts.head.indexOf("@");
    if (at <= 0 || at === parts.head.length - 1) return undefined;
    return { kind, conditionId: parts.head.slice(0, at), smpPath: parts.head.slice(at + 1), fieldId: parts.fieldId, component };
  }
  if (kind === "material") return { kind, smpPath: parts.head, fieldId: parts.fieldId, component };
  return undefined;
}

export function formatCaseAddress(a: CaseAddress): string {
  const c = a.component !== undefined ? `[${a.component}]` : "";
  if (a.kind === "section") return `section:${a.sectionId}/${a.fieldId}${c}`;
  if (a.kind === "assignment") return `assignment:${a.conditionId}@${a.smpPath}/${a.fieldId}${c}`;
  return `material:${a.smpPath}/${a.fieldId}${c}`;
}

const numeric = (f: FieldSpec): boolean => f.type === "number" || f.type === "int" || f.type === "vector3";

function numberAt(v: JsonValue | undefined, f: FieldSpec, component?: number): number | undefined {
  if (f.type === "vector3") {
    if (component === undefined || !Array.isArray(v)) return undefined;
    const x = Number(v[component]);
    return Number.isFinite(x) ? x : undefined;
  }
  if (component !== undefined) return undefined;
  const x = Number(v);
  return typeof v === "number" || typeof v === "string" ? (Number.isFinite(x) ? x : undefined) : undefined;
}

function lawOf(decl: ProblemtypeDeclaration, m: MaterialAssignment) {
  return decl.materialLaws.find((l) => l.id === m.lawId);
}

/** The field spec an address points at, and the value currently stored there. */
function locate(
  decl: ProblemtypeDeclaration,
  state: CaseState,
  a: CaseAddress
): { field: FieldSpec; raw: JsonValue | undefined } | undefined {
  if (a.kind === "section") {
    const field = decl.sections.find((s) => s.id === a.sectionId)?.fields.find((f) => f.id === a.fieldId);
    if (!field) return undefined;
    const v = state.values[a.sectionId]?.[a.fieldId];
    return { field, raw: v !== undefined ? v : fieldDefault(field) };
  }
  if (a.kind === "assignment") {
    const cond = decl.conditions.find((c) => c.id === a.conditionId);
    const field = cond?.fields.find((f) => f.id === a.fieldId);
    const asg = state.assignments.find((x) => x.conditionId === a.conditionId && x.smpPath === a.smpPath);
    if (!field || !asg) return undefined;
    const v = asg.values[a.fieldId];
    return { field, raw: v !== undefined ? v : fieldDefault(field) };
  }
  const mat = state.materials.find((m) => m.smpPath === a.smpPath);
  const field = mat ? lawOf(decl, mat)?.variables.find((f) => f.id === a.fieldId) : undefined;
  if (!mat || !field) return undefined;
  const v = mat.values[a.fieldId];
  return { field, raw: v !== undefined ? v : fieldDefault(field) };
}

/** The number at an address, or undefined when it names nothing numeric in this case. */
export function readCaseValue(decl: ProblemtypeDeclaration, state: CaseState, address: string): number | undefined {
  const a = parseCaseAddress(address);
  const found = a ? locate(decl, state, a) : undefined;
  if (!a || !found || !numeric(found.field)) return undefined;
  return numberAt(found.raw, found.field, a.component);
}

/**
 * A copy of the case with the value at `address` set to `x`. Never mutates the
 * input. Returns undefined when the address names nothing numeric.
 */
export function withCaseValue(
  decl: ProblemtypeDeclaration,
  state: CaseState,
  address: string,
  x: number
): CaseState | undefined {
  const a = parseCaseAddress(address);
  const found = a ? locate(decl, state, a) : undefined;
  if (!a || !found || !numeric(found.field)) return undefined;
  if ((found.field.type === "vector3") !== (a.component !== undefined)) return undefined;
  const nextValue = (raw: JsonValue | undefined): JsonValue => {
    if (a.component === undefined) return x;
    const vec = Array.isArray(raw) ? [...raw] : [0, 0, 0];
    vec[a.component] = x;
    return vec as JsonValue;
  };
  if (a.kind === "section") {
    return {
      ...state,
      values: { ...state.values, [a.sectionId]: { ...(state.values[a.sectionId] ?? {}), [a.fieldId]: nextValue(found.raw) } },
    };
  }
  if (a.kind === "assignment") {
    let done = false;
    const assignments: Assignment[] = state.assignments.map((asg) => {
      if (done || asg.conditionId !== a.conditionId || asg.smpPath !== a.smpPath) return asg;
      done = true;
      return { ...asg, values: { ...asg.values, [a.fieldId]: nextValue(found.raw) } };
    });
    return { ...state, assignments };
  }
  let done = false;
  const materials = state.materials.map((m) => {
    if (done || m.smpPath !== a.smpPath) return m;
    done = true;
    return { ...m, values: { ...m.values, [a.fieldId]: nextValue(found.raw) } };
  });
  return { ...state, materials };
}

/** Every numeric value in the case a `caseValue` field could name, grouped for a picker. */
export function caseValueAddresses(decl: ProblemtypeDeclaration, state: CaseState): CaseValueOption[] {
  const out: CaseValueOption[] = [];
  const push = (a: CaseAddress, field: FieldSpec, raw: JsonValue | undefined, label: string, group: string): void => {
    if (!numeric(field)) return;
    if (field.type === "vector3") {
      for (let i = 0; i < 3; i++) {
        const value = numberAt(raw, field, i);
        if (value !== undefined) out.push({ address: formatCaseAddress({ ...a, component: i } as CaseAddress), label: `${label} (${COMPONENT[i]})`, group, value });
      }
      return;
    }
    const value = numberAt(raw, field);
    if (value !== undefined) out.push({ address: formatCaseAddress(a as CaseAddress), label, group, value });
  };
  for (const s of decl.sections) {
    for (const f of s.fields) {
      const v = state.values[s.id]?.[f.id];
      push({ kind: "section", sectionId: s.id, fieldId: f.id }, f, v !== undefined ? v : fieldDefault(f), f.label, s.label);
    }
  }
  const seen = new Set<string>();
  for (const asg of state.assignments) {
    const key = `${asg.conditionId}@${asg.smpPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cond = decl.conditions.find((c) => c.id === asg.conditionId);
    for (const f of cond?.fields ?? []) {
      const v = asg.values[f.id];
      push(
        { kind: "assignment", conditionId: asg.conditionId, smpPath: asg.smpPath, fieldId: f.id },
        f, v !== undefined ? v : fieldDefault(f), `${cond!.label} on ${asg.smpPath} · ${f.label}`, "Conditions"
      );
    }
  }
  const seenMat = new Set<string>();
  for (const m of state.materials) {
    if (seenMat.has(m.smpPath)) continue;
    seenMat.add(m.smpPath);
    for (const f of lawOf(decl, m)?.variables ?? []) {
      const v = m.values[f.id];
      push({ kind: "material", smpPath: m.smpPath, fieldId: f.id }, f, v !== undefined ? v : fieldDefault(f), `Material on ${m.smpPath} · ${f.label}`, "Materials");
    }
  }
  return out;
}

/** The human label of an address in this case, or the raw address when it names nothing. */
export function caseValueLabel(decl: ProblemtypeDeclaration, state: CaseState, address: string): string {
  return caseValueAddresses(decl, state).find((o) => o.address === address)?.label ?? address;
}

