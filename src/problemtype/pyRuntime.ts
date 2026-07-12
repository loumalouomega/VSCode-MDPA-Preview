/**
 * Python problemtype support via pyodide. One interpreter is created lazily on
 * the first .py problemtype discovered (the runtime is ~14 MB of WASM — never
 * loaded when unused) and reused for every load after that.
 *
 * The authoring API lives in assets/kratos_problemtype.py (shipped as
 * dist/problemtypes/kratos_problemtype.py): user code calls
 * define_problemtype(...) which registers a declaration + hook callables in a
 * module-global registry. This bridge reads the declarations back as JSON,
 * validates them with the same validateDeclaration as JS problemtypes, and
 * wraps each entry in a ProblemtypeRuntime whose hooks call into python with
 * JSON-encoded arguments — no PyProxy objects ever cross into the generator.
 *
 * Runtime resolution order (both are optional so plain-Node tests work):
 *  1. require("pyodide")                        — dev / tests via node_modules
 *  2. <__dirname>/pyodide/pyodide.js            — packaged layout (esbuild copies it)
 *
 * Pure Node module: no vscode / DOM imports so it stays Node-testable.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { validateDeclaration, resolveProcessTemplate } from "./api";
import { MAIN_KRATOS_PY } from "./mainKratosTemplate";
import {
  GenContext,
  JsonObject,
  ProblemtypeDeclaration,
  ProblemtypeRuntime,
} from "./types";

/** Minimal pyodide surface we use (avoids a hard type dependency). */
interface Pyodide {
  runPython(code: string): unknown;
  globals: { set(name: string, value: unknown): void; delete(name: string): void };
}

type CallHook = (handle: number, name: string, argsJson: string) => string | undefined;
type HasHook = (handle: number, name: string) => boolean;

let pyodidePromise:
  | Promise<{ py: Pyodide; callHook: CallHook; hasHook: HasHook }>
  | undefined;

/** The kratos_problemtype.py source: packaged next to the bundle, or the repo assets/. */
function readModuleSource(): string {
  const candidates = [
    path.join(__dirname, "problemtypes", "kratos_problemtype.py"), // dist/ layout
    path.join(__dirname, "..", "..", "assets", "kratos_problemtype.py"), // out/ tests + dev
  ];
  for (const candidate of candidates) {
    try {
      return fs.readFileSync(candidate, "utf8");
    } catch {
      /* try the next layout */
    }
  }
  throw new Error("kratos_problemtype.py not found next to the extension bundle.");
}

async function initPyodide(): Promise<{ py: Pyodide; callHook: CallHook; hasHook: HasHook }> {
  type LoadPyodide = (opts?: { indexURL?: string }) => Promise<Pyodide>;
  let loadPyodide: LoadPyodide | undefined;
  let indexURL: string | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ({ loadPyodide } = require("pyodide"));
  } catch {
    const dir = path.join(__dirname, "pyodide");
    try {
      ({ loadPyodide } = require(path.join(dir, "pyodide.js")));
      indexURL = dir;
    } catch {
      /* handled below */
    }
  }
  if (!loadPyodide) {
    throw new Error(
      "The pyodide runtime is not available — Python problemtypes cannot be loaded."
    );
  }
  const py = await loadPyodide(indexURL ? { indexURL } : {});
  // Register the authoring module under its import name, then exec its source
  // into it so user files can `from kratos_problemtype import ...`.
  py.globals.set("_kpt_source", readModuleSource());
  py.runPython(
    [
      "import sys, types",
      '_kpt_mod = types.ModuleType("kratos_problemtype")',
      'sys.modules["kratos_problemtype"] = _kpt_mod',
      "exec(_kpt_source, _kpt_mod.__dict__)",
    ].join("\n")
  );
  py.globals.delete("_kpt_source");
  const callHook = py.runPython("_kpt_mod._call_hook") as CallHook;
  const hasHook = py.runPython("_kpt_mod._has_hook") as HasHook;
  return { py, callHook, hasHook };
}

function getPyodide(): Promise<{ py: Pyodide; callHook: CallHook; hasHook: HasHook }> {
  if (!pyodidePromise) {
    pyodidePromise = initPyodide().catch((err) => {
      pyodidePromise = undefined; // allow a retry (e.g. after installing pyodide)
      throw err;
    });
  }
  return pyodidePromise;
}

/** Wraps one registered python problemtype as a ProblemtypeRuntime. */
function wrapRuntime(
  decl: ProblemtypeDeclaration,
  handle: number,
  callHook: CallHook
): ProblemtypeRuntime {
  const call = (name: string, args: Record<string, unknown>): string | undefined =>
    callHook(handle, name, JSON.stringify(args)) ?? undefined;
  return {
    decl,
    source: "py",
    solverSettings: async (values, ctx) =>
      JSON.parse(call("solverSettings", { values, ctx }) ?? "{}") as JsonObject,
    buildProcess: async (cond, a, ctx) => {
      const result = call("buildProcess", { cond, assignment: a, ctx });
      return result !== undefined
        ? (JSON.parse(result) as JsonObject)
        : resolveProcessTemplate(cond, a, ctx);
    },
    postProcess: async (pp, ctx) => {
      const result = call("postProcess", { pp, ctx });
      return result !== undefined ? (JSON.parse(result) as JsonObject) : pp;
    },
    mainScript: async (ctx: GenContext) => {
      const result = call("mainScript", { ctx });
      return result !== undefined ? (JSON.parse(result) as string) : MAIN_KRATOS_PY;
    },
  };
}

/** Executes a user .py problemtype file and returns its registered runtimes. */
export async function loadPyProblemtypes(
  code: string,
  fileName: string
): Promise<ProblemtypeRuntime[]> {
  const { py, callHook, hasHook } = await getPyodide();
  py.globals.set("_kpt_user_code", code);
  py.globals.set("_kpt_user_file", fileName);
  let pendingJson: string;
  try {
    py.runPython(
      // A fresh globals dict per file; the module import brings in the API.
      'exec(compile(_kpt_user_code, _kpt_user_file, "exec"), {"__name__": "__main__"})'
    );
    pendingJson = py.runPython(
      "import kratos_problemtype as _kpt\n_kpt._take_pending()"
    ) as string;
  } finally {
    py.globals.delete("_kpt_user_code");
    py.globals.delete("_kpt_user_file");
  }
  const pending = JSON.parse(pendingJson) as { handle: number; decl: ProblemtypeDeclaration }[];
  if (pending.length === 0) {
    throw new Error(`${fileName} defined no problemtype — call define_problemtype(...).`);
  }
  return pending.map(({ handle, decl }) => {
    const errors = validateDeclaration(decl);
    if (errors.length > 0) {
      throw new Error(`Invalid problemtype "${decl?.id ?? "?"}" in ${fileName}: ${errors.join("; ")}`);
    }
    if (!hasHook(handle, "solverSettings")) {
      throw new Error(`Problemtype "${decl.id}" in ${fileName}: solver_settings hook is required.`);
    }
    return wrapRuntime(decl, handle, callHook);
  });
}
