// VTK-wasm method table (roadmap item 18): which C++ methods a class exposes
// through the session's invoker registry, and which of them may SUSPEND
// (JSPI) and therefore must be called through `invokeAsync`.
//
// Built from the `types/vtk*.json` manifests shipped in the unified VTK-wasm
// tarballs. The @kitware/vtk-wasm loader builds the same table (its `Ke`/`Ge`
// helpers) and, crucially, when the table is MISSING it wraps every method
// in an async function — which is what the 2026-09-18 spike measured as
// "every instance method returns a Promise". The compact serialised form
// written by `serializeMethodTable` is exactly what the loader accepts as
// `vtk-methods.json` in directory mode (`{Class: {inherits, methods: {Name: 0|1}}}`).
//
// Pure: callers read the manifests; tests feed literal objects.

export interface MethodManifest {
  /** C++ class name (the manifest's `title`). */
  title: string;
  inherits?: string | null;
  methods?: Record<string, { maySuspend?: boolean } | unknown>;
}

export interface CompactClass {
  inherits: string | null;
  /** C++ method name -> 1 if it may suspend, else 0. */
  methods: Record<string, 0 | 1>;
}

export type MethodTable = Record<string, CompactClass>;

export interface ResolvedMethod {
  cxxName: string;
  maySuspend: boolean;
  /** The class in the inheritance chain that declares it. */
  declaredOn: string;
}

export function buildMethodTable(manifests: Iterable<MethodManifest>): MethodTable {
  const table: MethodTable = Object.create(null);
  for (const m of manifests) {
    if (!m || typeof m.title !== "string") continue;
    const methods: Record<string, 0 | 1> = Object.create(null);
    for (const [name, spec] of Object.entries(m.methods ?? {})) {
      const suspend = typeof spec === "object" && spec !== null && (spec as { maySuspend?: unknown }).maySuspend === true;
      methods[name] = suspend ? 1 : 0;
    }
    table[m.title] = { inherits: m.inherits ?? null, methods };
  }
  return table;
}

/** Stable JSON (sorted classes and methods) so the build output is reproducible. */
export function serializeMethodTable(table: MethodTable): string {
  const out: Record<string, CompactClass> = {};
  for (const cls of Object.keys(table).sort()) {
    const methods: Record<string, 0 | 1> = {};
    for (const name of Object.keys(table[cls].methods).sort()) methods[name] = table[cls].methods[name];
    out[cls] = { inherits: table[cls].inherits, methods };
  }
  return JSON.stringify(out);
}

/**
 * Resolve `method` on `cls` or any ancestor. Accepts the C++ spelling
 * (`SetVisibility`) and the loader's camelCase JS spelling (`setVisibility`).
 */
export function lookupMethod(table: MethodTable, cls: string, method: string): ResolvedMethod | undefined {
  const cxx = method.charAt(0).toUpperCase() + method.slice(1);
  const seen = new Set<string>();
  for (let c: string | null = cls; c && !seen.has(c); c = table[c]?.inherits ?? null) {
    seen.add(c);
    const entry = table[c];
    if (!entry) return undefined;
    if (Object.prototype.hasOwnProperty.call(entry.methods, cxx)) {
      return { cxxName: cxx, maySuspend: entry.methods[cxx] === 1, declaredOn: c };
    }
  }
  return undefined;
}

export function hasClass(table: MethodTable, cls: string): boolean {
  return Object.prototype.hasOwnProperty.call(table, cls);
}

/** Every method in the table that may suspend, as `Class::Method`. */
export function suspendingMethods(table: MethodTable): string[] {
  const out: string[] = [];
  for (const [cls, entry] of Object.entries(table)) {
    for (const [name, flag] of Object.entries(entry.methods)) if (flag === 1) out.push(`${cls}::${name}`);
  }
  return out.sort();
}

export interface UsageEntry {
  /** The class the backend holds the object as (a factory may hand back a subclass). */
  cls: string;
  method: string;
  /** True where the backend deliberately awaits the call (Render, pixel reads). */
  expectSuspend?: boolean;
}

export interface UsageProblem {
  entry: UsageEntry;
  problem: "unknown-class" | "missing-method" | "unexpected-suspend" | "expected-suspend-missing";
}

/**
 * Check a declared usage list against a table. Any problem is a hard stop
 * for the backend: a missing method would fail at runtime with a logged
 * `null` (the session does not throw), and a method that may suspend but is
 * called synchronously would trap under JSPI.
 */
export function classifyUsage(table: MethodTable, usage: readonly UsageEntry[]): { resolved: Array<UsageEntry & ResolvedMethod>; problems: UsageProblem[] } {
  const resolved: Array<UsageEntry & ResolvedMethod> = [];
  const problems: UsageProblem[] = [];
  for (const entry of usage) {
    if (!hasClass(table, entry.cls)) {
      problems.push({ entry, problem: "unknown-class" });
      continue;
    }
    const r = lookupMethod(table, entry.cls, entry.method);
    if (!r) {
      problems.push({ entry, problem: "missing-method" });
      continue;
    }
    if (r.maySuspend && !entry.expectSuspend) problems.push({ entry, problem: "unexpected-suspend" });
    else if (!r.maySuspend && entry.expectSuspend) problems.push({ entry, problem: "expected-suspend-missing" });
    resolved.push({ ...entry, ...r });
  }
  return { resolved, problems };
}
