/**
 * Text for the menubar's document chip and the status bar: entity counts, the
 * timeline frame, the last pick, the "N unsaved edits" label, and which WASM
 * engines this session has used.
 *
 * Pure and DOM-free (and free of `vscode`), so the wording is unit-testable
 * apart from the elements that display it, and both the extension host and the
 * webview bundle can import it. Everything here is a FACT about the loaded
 * document or the session, never a verdict — nothing is coloured or worded as
 * good/bad.
 *
 * ── Engine status: what is real and what is not ─────────────────────────────
 * The engines here are per-CALL, not resident: `loadMeshio()` builds a fresh
 * meshio++ instance each time (only the ES-module namespace is cached), MMG runs
 * in a worker thread that is terminated when the run ends, and Pyodide is a
 * memoized singleton loaded the first time a `.py` problemtype runs. So, as in
 * CAD-Preview's kernel status, "ready" cannot be read off any flag. It is
 * INFERRED from calls, and only from the three choke points that exist:
 *
 *   engine   start signal                          success / failure signal
 *   meshio   `loadMeshio()` entered                its instance resolved / threw
 *   mmg      `mmgRunner(...)` invoked (remesh,     the runner's promise resolved
 *            levelset — worker or in-process)      / rejected (incl. cancel)
 *   pyodide  `initPyodide()` entered               its promise resolved / threw
 *
 * `ready` means "a call that needs this engine has succeeded this session" —
 * never "a WASM instance is resident right now". Engines nothing signals are
 * left out on purpose rather than guessed at: the Flowgraph editor is a forked
 * child process (not WASM), and the mesh parsers/operations that are plain
 * TypeScript touch no engine at all, so opening an `.mdpa` legitimately reads
 * "Engines idle". A failed call that was the one loading an engine leaves it
 * idle again, and a start never demotes an engine that is already ready.
 */

/**
 * Grouped digits with a FIXED locale. `toLocaleString()` with no argument
 * follows the host machine's locale, which would make the same mesh read
 * "1,248" for one user and "1.248" for another — and make a test that compares
 * text depend on where it runs.
 */
const GROUPED = new Intl.NumberFormat("en-US");

/** "12,345" — en-US grouping, always. */
export function groupDigits(n: number): string {
  return GROUPED.format(n);
}

function count(n: number, singular: string, plural: string): string {
  return `${GROUPED.format(n)} ${n === 1 ? singular : plural}`;
}

export interface ModelCounts {
  nodes: number;
  elements: number;
  conditions: number;
  geometries?: number;
}

/**
 * "12,345 nodes · 6,789 elements · 42 conditions". A kind with none is left
 * out rather than spelled "0 conditions" (most meshes carry no geometries, and
 * a row of zeros is noise); an entirely empty model yields "" so the status
 * bar cell collapses.
 */
export function formatModelCounts(c: ModelCounts): string {
  const parts: string[] = [];
  const add = (n: number | undefined, singular: string, plural: string): void => {
    if (typeof n === "number" && Number.isFinite(n) && n > 0) parts.push(count(n, singular, plural));
  };
  add(c.nodes, "node", "nodes");
  add(c.elements, "element", "elements");
  add(c.conditions, "condition", "conditions");
  add(c.geometries, "geometry", "geometries");
  return parts.join(" · ");
}

/**
 * "frame 3 / 12 · step 0.25" for the timeline position, "" for a single-frame
 * document (there is no timeline to be at a position on).
 *
 * `frameIndex` is 0-based, as the host sends it. `stepLabel` is whatever the
 * timeline calls the step — a file-name step or an in-file time value — so it
 * is labelled "step" like the timeline bar itself, never "t =": a file-series
 * label is not a physical time.
 */
export function formatFrame(frameIndex: number, totalFrames: number, stepLabel?: string): string {
  if (!Number.isFinite(frameIndex) || !Number.isFinite(totalFrames) || totalFrames <= 1) return "";
  const idx = Math.min(Math.max(Math.floor(frameIndex), 0), totalFrames - 1);
  const head = `frame ${GROUPED.format(idx + 1)} / ${GROUPED.format(totalFrames)}`;
  const label = (stepLabel ?? "").trim();
  return label ? `${head} · step ${label}` : head;
}

export interface PickInfo {
  /** The owning entity, when the click resolved to one. */
  entity?: { kind: "Element" | "Condition" | "Geometry"; id: number; blockName?: string };
  /** The nearest node, when there was one. */
  node?: { id: number; coords: readonly [number, number, number] };
}

/**
 * Coordinates for a copy-paste readout: up to 5 significant digits, plain
 * hyphen-minus (a coordinate is something people paste into other tools, and a
 * typographic minus does not parse there), and `-0` collapsed.
 */
export function formatCoord(v: number): string {
  if (!Number.isFinite(v)) return "0";
  if (v === 0) return "0";
  return String(Number(v.toPrecision(5)));
}

/**
 * The last pick, e.g. "element 45 · Triangle2D3 · node 123 (0.5, 1, 0)"; ""
 * when nothing is picked. Lowercase kind, like the status bar's other clauses.
 * Ids are plain digits, unlike the counts: they are keys people type into the
 * Find bar and other tools, and "1,191" would not paste back.
 */
export function formatPick(p: PickInfo | undefined): string {
  if (!p) return "";
  const parts: string[] = [];
  if (p.entity) {
    parts.push(`${p.entity.kind.toLowerCase()} ${p.entity.id}`);
    if (p.entity.blockName) parts.push(p.entity.blockName);
  }
  if (p.node) {
    const [x, y, z] = p.node.coords;
    parts.push(`node ${p.node.id} (${formatCoord(x)}, ${formatCoord(y)}, ${formatCoord(z)})`);
  }
  return parts.join(" · ");
}

/** "3 unsaved edits" for the document chip; "" when there are none. */
export function unsavedEditsLabel(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  return count(Math.floor(n), "unsaved edit", "unsaved edits");
}

/**
 * How many operations differ between what is applied now and what the source
 * file already holds: the ops past their common prefix, on both sides.
 *
 * Records are compared by IDENTITY — the history stores the objects it was
 * given, and `save` snapshots that same array — so this needs no notion of
 * op equality. It makes the count exact where a plain "applied - saved"
 * subtraction is not:
 *   - undo back to the save point → 0 (clean at once);
 *   - undo one op past it → 1 (the file has an op the view no longer shows);
 *   - undo one and apply a different op → 2 (one removed, one added).
 * The chip therefore answers "does the source file contain what I am looking
 * at?", which is deliberately not the question VS Code's tab dot answers (that
 * one is a latch, cleared only by a save or revert).
 */
export function unsavedEditCount<T>(applied: readonly T[], saved: readonly T[]): number {
  let common = 0;
  const limit = Math.min(applied.length, saved.length);
  while (common < limit && applied[common] === saved[common]) common++;
  return applied.length - common + (saved.length - common);
}

// ── Engine activity ──────────────────────────────────────────────────────────

export type Engine = "meshio" | "mmg" | "pyodide";
export type EnginePhase = "idle" | "loading" | "ready";
export type EngineState = Record<Engine, EnginePhase>;

export const ENGINE_LABELS: Record<Engine, string> = {
  meshio: "meshio++",
  mmg: "MMG",
  pyodide: "Pyodide",
};

/** Display order: the two everyday engines first. */
export const ENGINE_ORDER: readonly Engine[] = ["meshio", "mmg", "pyodide"];

export function initialEngineState(): EngineState {
  return { meshio: "idle", mmg: "idle", pyodide: "idle" };
}

export type EngineEvent =
  | { type: "start"; engine: Engine }
  | { type: "success"; engine: Engine }
  | { type: "failure"; engine: Engine };

/**
 * Pure reducer. Returns the SAME object when nothing changed so a caller can
 * cheaply skip a broadcast (`next === prev`).
 *
 * A start never demotes an engine that is already warm (a second remesh does
 * not flip "MMG ready" back to "loading"), and a failure only cools the engine
 * that was still loading — one that had already succeeded stays ready, since a
 * later failed call says nothing about the earlier success.
 */
export function reduceEngineState(prev: EngineState, ev: EngineEvent): EngineState {
  const cur = prev[ev.engine];
  let phase: EnginePhase = cur;
  if (ev.type === "start") {
    if (cur === "idle") phase = "loading";
  } else if (ev.type === "success") {
    phase = "ready";
  } else if (cur === "loading") {
    phase = "idle";
  }
  return phase === cur ? prev : { ...prev, [ev.engine]: phase };
}

/**
 * The status bar's text and colour bucket.
 *   - nothing active → "Engines idle"
 *   - otherwise "meshio++ ready · MMG loading…", listing only the non-idle engines
 */
export function describeEngineState(state: EngineState): { text: string; tone: "idle" | "loading" | "ready" } {
  const active = ENGINE_ORDER.filter((e) => state[e] !== "idle");
  if (active.length === 0) return { text: "Engines idle", tone: "idle" };
  const text = active.map((e) => `${ENGINE_LABELS[e]} ${state[e] === "ready" ? "ready" : "loading…"}`).join(" · ");
  return { text, tone: active.some((e) => state[e] === "loading") ? "loading" : "ready" };
}

/** A structural check for the `engineStatus` wire message (the host is trusted, but a stale build is not). */
export function isEngineState(v: unknown): v is EngineState {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return ENGINE_ORDER.every((e) => o[e] === "idle" || o[e] === "loading" || o[e] === "ready");
}
