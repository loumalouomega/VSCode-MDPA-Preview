/**
 * Loads workspace-authored JS problemtypes: the file runs inside a node:vm
 * sandbox exposing only `defineProblemtype` (plus a muted console) — no
 * require, no process, no filesystem. Definitions are captured, validated by
 * defineProblemtype itself, and returned as runtimes. A 2 s timeout guards the
 * top-level evaluation; hooks execute later at generate time.
 *
 * Pure Node module: no vscode / DOM imports so it stays Node-testable.
 */

import * as vm from "node:vm";
import { defineProblemtype } from "./api";
import { ProblemtypeDeclaration, ProblemtypeHooks, ProblemtypeRuntime } from "./types";

export function loadJsProblemtypes(code: string, fileName: string): ProblemtypeRuntime[] {
  const captured: ProblemtypeRuntime[] = [];
  const sandbox = {
    defineProblemtype: (decl: ProblemtypeDeclaration, hooks: ProblemtypeHooks): ProblemtypeRuntime => {
      const runtime = defineProblemtype(decl, hooks, "js");
      captured.push(runtime);
      return runtime;
    },
    // Muted console so a stray log in a problemtype never throws.
    console: { log: () => undefined, warn: () => undefined, error: () => undefined },
  };
  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });
  vm.runInContext(code, context, { filename: fileName, timeout: 2000 });
  if (captured.length === 0) {
    throw new Error(`${fileName} defined no problemtype — call defineProblemtype({...}, {...}).`);
  }
  return captured;
}
