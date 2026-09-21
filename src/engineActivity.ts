/**
 * A process-wide observer for which WASM engines have been used — the hub that
 * `statusStats.ts`'s reducer is fed through.
 *
 * Deliberately a module-level singleton, like CAD-Preview's kernel status: the
 * engines are process-wide (MMG workers, the meshio++ loader, the Pyodide
 * singleton), so every open preview shows the same line. Zero dependencies and
 * no `vscode` import, so the parser modules that report into it stay
 * Node-testable; with no subscriber a report is a single object compare.
 *
 * Reporters (see the header of `statusStats.ts` for what each signal means):
 *   - `parser/meshio.ts` `loadMeshio()`   → meshio
 *   - `parser/operations.ts` `runMmg()`   → mmg
 *   - `problemtype/pyRuntime.ts`          → pyodide
 */

import {
  EngineEvent,
  EngineState,
  initialEngineState,
  reduceEngineState,
} from "./statusStats";

let state: EngineState = initialEngineState();
const listeners = new Set<(s: EngineState) => void>();

/** Records one engine event; notifies subscribers only when the state moved. */
export function reportEngine(ev: EngineEvent): void {
  const next = reduceEngineState(state, ev);
  if (next === state) return;
  state = next;
  for (const l of [...listeners]) {
    try {
      l(state);
    } catch {
      /* a broken listener must never break the engine call that reported */
    }
  }
}

/**
 * Runs `fn` bracketed by start / success / failure for `engine`. The failure
 * event is reported before the original error is rethrown, unchanged.
 */
export async function trackEngine<T>(engine: EngineEvent["engine"], fn: () => Promise<T>): Promise<T> {
  reportEngine({ type: "start", engine });
  try {
    const out = await fn();
    reportEngine({ type: "success", engine });
    return out;
  } catch (err) {
    reportEngine({ type: "failure", engine });
    throw err;
  }
}

export function engineState(): EngineState {
  return state;
}

/** Subscribes to changes; returns the unsubscribe function. */
export function onEngineChange(listener: (s: EngineState) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: back to all-idle with no subscribers. */
export function resetEngineActivity(): void {
  state = initialEngineState();
  listeners.clear();
}
