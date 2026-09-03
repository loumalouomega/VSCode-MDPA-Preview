/**
 * Parses the ROWS inside an mdpa `Begin Constraints <name> <variables…>` block,
 * and owns every operation that keeps them valid while a mesh is edited.
 *
 * Until this module existed a Constraints block was kept only as a `MetaBlock`
 * (`{label, lineCount}`) and copied through a Save as verbatim source text. That
 * was an explicit stopgap: verbatim text is keyed by NODE id, so renumbering or
 * removing nodes left it naming ids the written mesh no longer had, and the two
 * ways that keying could go stale were *reported* rather than fixed. Parsing
 * them into entities is what lets `renumber` / `mergeNodes` / `removeOrphanNodes`
 * / `mergeMesh` / `crop` / `linearize` maintain them instead.
 *
 * Pure — no `vscode`, no DOM, no fs — the `propertiesParser.ts` contract, and
 * for the same reason: the result rides on `MdpaModel` to the webview.
 *
 * **Plain JSON, never a `Map`.** `MdpaModel` crosses `postMessage`, and
 * `scripts/screenshots/build-harness.mjs` re-serializes every message through
 * `JSON.stringify` — a `Map` survives VS Code's structured clone and becomes
 * `{}` in the one environment used to verify the rendering. Rows are also kept
 * flat (numbers and arrays of numbers, nothing deeper) because an MPC-heavy mesh
 * can carry a hundred thousand of them and the whole model is re-posted on every
 * render; that is the same cost `properties` already pays, one order up.
 *
 * The layout, from the two committed Kratos fixtures:
 *
 * ```
 * Begin Constraints LinearMasterSlaveConstraint DISPLACEMENT_X
 * 1 0.0 [0.5] 1 2                 // id constant [weights] slave master
 * 2 0.0 [0.25, 0.25] 1 3 972      // two weights → the last two ids are masters
 * End Constraints
 *
 * Begin Constraints<TAB>LinearMasterSlaveConstraint<TAB>TEMPERATURE<TAB>TEMPERATURE
 * <TAB>1<TAB>0.0 [1.0]<TAB>1<TAB>80<TAB>          // tabs, CRLF, trailing tab
 * End Constraints
 * ```
 *
 * The trailing integer run is split **from the end**: the last `weights.length`
 * ids are the masters and whatever precedes them are the slaves. That is
 * deliberately robust to either reading of Kratos' column order — and the order
 * does not matter for maintenance anyway, since `constraintNodeIds` returns all
 * of them and *every one is a node id*.
 *
 * **Tolerant, never throwing**, again like `propertiesParser.ts`, but the
 * fallback is different in kind: a row that does not fit the layout above is
 * kept **verbatim** (`kind: "raw"`) rather than coerced. A raw row loses nothing
 * a human could read and still round-trips byte-for-byte, but it cannot be
 * maintained — so every consumer counts raw rows separately and says so instead
 * of quietly renumbering around an id it could not find. The fallback is per
 * ROW, not per block: one unreadable row among cube.mdpa's forty must not strand
 * the other thirty-nine, and "every row raw" then *is* the whole-block-verbatim
 * case with no second code path.
 */

import type { SubModelPart } from "./types";

/** One `id constant [weights] slave… master…` row that parsed cleanly. */
export interface LinearConstraint {
  kind: "linear";
  /** The constraint's own id — the space `SubModelPart.constraintIds` names. */
  id: number;
  /** The scalar constant column. `0.0` in every real file seen so far. */
  constant: number;
  /** One weight per master node, in written order. */
  weights: number[];
  /** The trailing node ids before the masters. One in every observed file. */
  slaveIds: number[];
  /** The LAST `weights.length` trailing node ids. */
  masterIds: number[];
}

/**
 * A row this module could not decompose. Kept verbatim so nothing is lost and
 * the writer can re-emit it unchanged; NOT maintainable through renumber or
 * mergeNodes, which is why consumers count these apart.
 */
export interface RawConstraintRow {
  kind: "raw";
  /** The comment-stripped, trimmed source line, interior whitespace intact. */
  text: string;
}

export type ConstraintRow = LinearConstraint | RawConstraintRow;

/** One `Begin Constraints …` block — one per SOURCE block, never merged. */
export interface ConstraintBlock {
  /** `LinearMasterSlaveConstraint`; `""` for a bare `Begin Constraints`. */
  name: string;
  /** Header args after the name — `["DISPLACEMENT_X"]`, `["TEMPERATURE","TEMPERATURE"]`. */
  variables: string[];
  rows: ConstraintRow[];
}

// --- formatting -------------------------------------------------------------

/**
 * Formats one number the way Kratos files write a constraint column.
 *
 * Deliberately NOT `writerCommon`'s `num()`, which renders an integer as `"0"`:
 * every real file carries `0.0 [1.0]`, and while `std::stod` reads both, a
 * round-trip that keeps the source's own spelling is free here.
 */
export function constraintNum(x: number): string {
  if (!Number.isFinite(x)) return "0.0";
  if (Number.isInteger(x)) return x.toFixed(1);
  return String(parseFloat(x.toPrecision(7)));
}

/** Renders one row back to its mdpa line (without indentation). */
export function formatConstraintRow(row: ConstraintRow): string {
  if (row.kind === "raw") return row.text;
  const weights = row.weights.map(constraintNum).join(", ");
  const ids = [...row.slaveIds, ...row.masterIds].join(" ");
  return `${row.id} ${constraintNum(row.constant)} [${weights}]${ids ? ` ${ids}` : ""}`;
}

// --- parsing ----------------------------------------------------------------

/** Splits "a, b ,c" into trimmed, non-empty parts. */
function splitList(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Parses a comma-separated numeric list; undefined if any entry is not a number. */
function numberList(text: string): number[] | undefined {
  const parts = splitList(text);
  if (parts.length === 0) return undefined;
  const out: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isFinite(n)) return undefined;
    out.push(n);
  }
  return out;
}

/**
 * Finds the first bracket group in `text`, counting depth.
 *
 * Returns the payload plus where the group ends and how deep it nested. Depth
 * matters: a `LinearMasterSlaveConstraint` may in principle carry a relation
 * MATRIX (`[[1,0],[0,1]]`), which the caller refuses rather than mis-splitting.
 */
function bracketSpan(
  text: string
): { start: number; end: number; payload: string; maxDepth: number } | undefined {
  const start = text.indexOf("[");
  if (start === -1) return undefined;
  let depth = 0;
  let maxDepth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "[") {
      depth++;
      if (depth > maxDepth) maxDepth = depth;
    } else if (c === "]") {
      depth--;
      if (depth === 0) {
        return { start, end: i, payload: text.slice(start + 1, i), maxDepth };
      }
    }
  }
  return undefined; // unbalanced
}

/**
 * Parses one constraint row.
 *
 * `line` is the comment-stripped, trimmed source line — the shape
 * `mdpaParser.feedLine` already produces. The work is done on the STRING rather
 * than on whitespace tokens because `[0.25, 0.25]` shatters across a `/\s+/`
 * split; `parseFieldRecord` re-joins `(v1, v2)` for exactly the same reason.
 *
 * Anything that does not fit comes back as a `raw` row — never a throw, and
 * never a guess.
 */
export function parseConstraintRow(
  line: string,
  onDiagnostic?: (message: string) => void
): ConstraintRow {
  const text = line.trim();
  const raw = (why: string): RawConstraintRow => {
    onDiagnostic?.(`${why}; row kept verbatim: "${text}"`);
    return { kind: "raw", text };
  };

  const head = /^([+-]?\d+)(\s[\s\S]*)$/.exec(text);
  if (!head) return raw("no leading constraint id");
  const id = parseInt(head[1], 10);
  if (!Number.isFinite(id)) return raw("unreadable constraint id");
  const rest = head[2];

  const span = bracketSpan(rest);
  if (!span) return raw("no balanced [weights] group");
  if (span.maxDepth > 1) {
    return raw("nested [[…]] relation matrix is not decomposable here");
  }

  const constantText = rest.slice(0, span.start).trim();
  const constant = Number(constantText);
  if (constantText.length === 0 || /\s/.test(constantText) || !Number.isFinite(constant)) {
    return raw("constant column is not a single number");
  }

  const weights = numberList(span.payload);
  if (!weights) return raw("[weights] is not a comma-separated list of numbers");

  const tail = rest.slice(span.end + 1).trim();
  if (tail.length > 0 && bracketSpan(tail)) {
    // A second bracket group means a shape this module has never seen (a vector
    // constant, say). Splitting the ids around it would be a guess.
    return raw("a second [ … ] group follows the weights");
  }
  if (!/^[+-]?\d+(\s+[+-]?\d+)*$/.test(tail)) {
    return raw("the columns after [weights] are not a run of node ids");
  }
  const ids = tail.split(/\s+/).map((s) => parseInt(s, 10));
  if (ids.length <= weights.length) {
    return raw(
      `${weights.length} weight(s) but only ${ids.length} trailing node id(s) — ` +
        `no slave column left`
    );
  }

  return {
    kind: "linear",
    id,
    constant,
    weights,
    slaveIds: ids.slice(0, ids.length - weights.length),
    masterIds: ids.slice(ids.length - weights.length),
  };
}

/**
 * Parses one whole `Begin Constraints … End Constraints` block from its header
 * args and inner lines. Standalone entry point used by the tests; `mdpaParser`
 * feeds `parseConstraintRow` line by line inside its own state machine.
 */
export function parseConstraintsBlock(
  args: readonly string[],
  lines: readonly string[],
  onDiagnostic?: (message: string) => void
): ConstraintBlock {
  const block = emptyConstraintBlock(args);
  for (const rawLine of lines) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (line.length === 0) continue;
    block.rows.push(parseConstraintRow(line, onDiagnostic));
  }
  return block;
}

/** Creates an empty block from a `Begin Constraints` header's arguments. */
export function emptyConstraintBlock(args: readonly string[]): ConstraintBlock {
  return { name: args[0] ?? "", variables: args.slice(1), rows: [] };
}

// --- queries ----------------------------------------------------------------

/**
 * Every node id a row names — slaves and masters alike.
 *
 * The union rather than the two halves separately is what every maintenance
 * site actually wants: which column is which does not change the fact that all
 * of them must follow a renumbering, or die with a removed node.
 */
export function constraintNodeIds(row: ConstraintRow): number[] {
  return row.kind === "linear" ? [...row.slaveIds, ...row.masterIds] : [];
}

/** The constraint ids the blocks actually define (raw rows define none). */
export function definedConstraintIds(blocks?: readonly ConstraintBlock[]): number[] {
  const out: number[] = [];
  for (const b of blocks ?? []) {
    for (const r of b.rows) if (r.kind === "linear") out.push(r.id);
  }
  return out;
}

/** How many rows parsed, and how many are carried verbatim. */
export function countConstraints(blocks?: readonly ConstraintBlock[]): {
  linear: number;
  raw: number;
} {
  let linear = 0;
  let raw = 0;
  for (const b of blocks ?? []) {
    for (const r of b.rows) {
      if (r.kind === "linear") linear++;
      else raw++;
    }
  }
  return { linear, raw };
}

/** True when any block carries a row that could not be parsed. */
export function hasRawConstraintRows(blocks?: readonly ConstraintBlock[]): boolean {
  return countConstraints(blocks).raw > 0;
}

/** The largest defined constraint id, or 0 when there are none. */
export function maxDefinedConstraintId(blocks?: readonly ConstraintBlock[]): number {
  let max = 0;
  for (const id of definedConstraintIds(blocks)) if (id > max) max = id;
  return max;
}

// --- maintenance ------------------------------------------------------------

/** Rebuilds `blocks` with `rows` replaced, dropping blocks left with none. */
function rebuild(
  blocks: readonly ConstraintBlock[],
  rowsOf: (b: ConstraintBlock) => ConstraintRow[]
): ConstraintBlock[] {
  const out: ConstraintBlock[] = [];
  for (const b of blocks) {
    const rows = rowsOf(b);
    if (rows.length > 0) out.push({ name: b.name, variables: b.variables, rows });
  }
  return out;
}

/**
 * Maps every node id a constraint names through `map`.
 *
 * A node with no mapping **drops the whole constraint**, and its id is reported.
 * Connectivity zero-fills a dangling ref instead (it is stride-fixed, and
 * `buildCellLayout` skips an unresolvable cell), but a constraint with a `0`
 * master is garbage to Kratos and its weight vector would silently misalign with
 * the masters that remain — dropping is the only honest answer.
 *
 * Raw rows are carried unchanged and reported by the caller: their node columns
 * were never located, so they cannot follow a renumbering.
 */
export function mapConstraintNodes(
  blocks: readonly ConstraintBlock[],
  map: (nodeId: number) => number | undefined
): { blocks: ConstraintBlock[]; droppedIds: number[] } {
  const droppedIds: number[] = [];
  const out = rebuild(blocks, (b) => {
    const rows: ConstraintRow[] = [];
    for (const r of b.rows) {
      if (r.kind === "raw") {
        rows.push(r);
        continue;
      }
      const slaveIds: number[] = [];
      const masterIds: number[] = [];
      let ok = true;
      for (const id of r.slaveIds) {
        const m = map(id);
        if (m === undefined) { ok = false; break; }
        slaveIds.push(m);
      }
      if (ok) {
        for (const id of r.masterIds) {
          const m = map(id);
          if (m === undefined) { ok = false; break; }
          masterIds.push(m);
        }
      }
      if (!ok) {
        droppedIds.push(r.id);
        continue;
      }
      rows.push({ ...r, slaveIds, masterIds });
    }
    return rows;
  });
  return { blocks: out, droppedIds };
}

/**
 * Keeps only the constraints every one of whose nodes passes `keepNode`.
 *
 * Used by every module that REMOVES nodes. Raw rows are kept — their columns are
 * unknown, so there is nothing to test — and the caller reports them.
 */
export function filterConstraintsByNode(
  blocks: readonly ConstraintBlock[] | undefined,
  keepNode: (nodeId: number) => boolean
): { blocks?: ConstraintBlock[]; droppedIds: number[] } {
  if (!blocks) return { blocks: undefined, droppedIds: [] };
  const droppedIds: number[] = [];
  const out = rebuild(blocks, (b) =>
    b.rows.filter((r) => {
      if (r.kind === "raw") return true;
      const ok = constraintNodeIds(r).every(keepNode);
      if (!ok) droppedIds.push(r.id);
      return ok;
    })
  );
  return { blocks: out.length > 0 ? out : undefined, droppedIds };
}

/** Keeps only the constraints whose own id passes `keepId`. Raw rows survive. */
export function filterConstraintsById(
  blocks: readonly ConstraintBlock[] | undefined,
  keepId: (constraintId: number) => boolean
): ConstraintBlock[] | undefined {
  if (!blocks) return undefined;
  const out = rebuild(blocks, (b) =>
    b.rows.filter((r) => (r.kind === "raw" ? true : keepId(r.id)))
  );
  return out.length > 0 ? out : undefined;
}

/** Relabels each row's own constraint id through `map`; unmapped ids stay put. */
export function remapConstraintIds(
  blocks: readonly ConstraintBlock[],
  map: ReadonlyMap<number, number>
): ConstraintBlock[] {
  return rebuild(blocks, (b) =>
    b.rows.map((r) => (r.kind === "raw" ? r : { ...r, id: map.get(r.id) ?? r.id }))
  );
}

/** Adds `by` to every row id and to every node id. Raw rows cannot be shifted. */
export function offsetConstraints(
  blocks: readonly ConstraintBlock[],
  byConstraintId: number,
  byNodeId: number
): ConstraintBlock[] {
  return rebuild(blocks, (b) =>
    b.rows.map((r) =>
      r.kind === "raw"
        ? r
        : {
            ...r,
            id: r.id + byConstraintId,
            slaveIds: r.slaveIds.map((n) => n + byNodeId),
            masterIds: r.masterIds.map((n) => n + byNodeId),
          }
    )
  );
}

/**
 * Drops from every SubModelPart (recursively) the constraint ids `keep` does not
 * hold, returning the new tree and how many entries went.
 *
 * The counterpart of a constraint being deleted: a part that still lists it
 * would make the written file name a constraint it does not define, which is the
 * original defect this whole module exists to close.
 */
export function pruneSubModelPartConstraints(
  parts: readonly SubModelPart[],
  keep: ReadonlySet<number>
): { parts: SubModelPart[]; removed: number } {
  let removed = 0;
  const walk = (p: SubModelPart): SubModelPart => {
    const kept = Array.from(p.constraintIds).filter((id) => keep.has(id));
    removed += p.constraintIds.length - kept.length;
    return {
      ...p,
      constraintIds: kept.length === p.constraintIds.length ? p.constraintIds : Int32Array.from(kept),
      children: p.children.map(walk),
    };
  };
  return { parts: parts.map(walk), removed };
}

/** Every constraint id listed by any SubModelPart in the tree. */
export function subModelPartConstraintIds(parts: readonly SubModelPart[]): number[] {
  const out: number[] = [];
  const walk = (ps: readonly SubModelPart[]): void => {
    for (const p of ps) {
      for (const id of p.constraintIds) out.push(id);
      walk(p.children);
    }
  };
  walk(parts);
  return out;
}

/** Constraint ids a SubModelPart lists that no block defines. */
export function undefinedConstraintIds(
  blocks: readonly ConstraintBlock[] | undefined,
  parts: readonly SubModelPart[]
): number[] {
  const defined = new Set(definedConstraintIds(blocks));
  const out = new Set<number>();
  for (const id of subModelPartConstraintIds(parts)) if (!defined.has(id)) out.add(id);
  return [...out].sort((a, b) => a - b);
}
