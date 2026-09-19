/**
 * A tiny, dependency-free math-expression evaluator used to drive the MMG
 * remesher's per-node target size from a user-written formula (e.g. `0.5*h`, or
 * `clamp(0.5*h, mean-1.5*std, mean+1.5*std)`, or a coordinate-graded field).
 *
 * Pure module: no `vscode` / DOM / vtk.js imports, so it runs in the extension
 * host, the MMG worker, the MCP server, the webview bundle (for pre-submit
 * validation), and plain Node unit tests.
 *
 * Deliberately a real recursive-descent parser + tree-walking evaluator — NOT
 * `eval` / `new Function`. Expressions arrive from saved recipes and problem
 * archives (untrusted disk input), so the evaluator must never reach a JS scope:
 * only the whitelisted variables, functions and constants below are reachable.
 */

// --- surface ------------------------------------------------------------------

/** A parsed expression, ready to evaluate against a variable scope. */
export interface CompiledExpr {
  /** The original source text (verbatim, for round-tripping / messages). */
  readonly source: string;
  /** Variable names the expression actually references (subset of the allowed set). */
  readonly variablesUsed: readonly string[];
  /** Evaluates the expression; missing scope variables read as NaN. */
  evaluate(scope: Record<string, number>): number;
}

/** Math functions callable from an expression; the name → (arity, impl) table. */
const FUNCTIONS: Record<string, { arity: number | "any"; fn: (a: number[]) => number }> = {
  min: { arity: "any", fn: (a) => Math.min(...a) },
  max: { arity: "any", fn: (a) => Math.max(...a) },
  clamp: { arity: 3, fn: ([v, lo, hi]) => Math.min(Math.max(v, lo), hi) },
  abs: { arity: 1, fn: ([v]) => Math.abs(v) },
  sqrt: { arity: 1, fn: ([v]) => Math.sqrt(v) },
  sin: { arity: 1, fn: ([v]) => Math.sin(v) },
  cos: { arity: 1, fn: ([v]) => Math.cos(v) },
  tan: { arity: 1, fn: ([v]) => Math.tan(v) },
  exp: { arity: 1, fn: ([v]) => Math.exp(v) },
  log: { arity: 1, fn: ([v]) => Math.log(v) },
  pow: { arity: 2, fn: ([a, b]) => Math.pow(a, b) },
  floor: { arity: 1, fn: ([v]) => Math.floor(v) },
  ceil: { arity: 1, fn: ([v]) => Math.ceil(v) },
  round: { arity: 1, fn: ([v]) => Math.round(v) },
};

/** Named constants usable as bare identifiers. */
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

/**
 * The variable names the remesher exposes to a sizing expression. `std` has the
 * spelling aliases `stdev`/`sigma` (normalized to `std` before evaluation).
 */
export const SIZE_EXPR_VARIABLES = [
  "h", "x", "y", "z",
  "mean", "std", "min", "max", "median", "q1", "q3", "iqr",
] as const;

/**
 * The remesh `expr` scope gains this extra variable when a distance surface is
 * attached (`RemeshParams.distanceSurface`): the unsigned distance from the
 * node to it, for boundary-layer-style grading (e.g. `clamp(0.1*h + 0.5*d,
 * 0.1*h, 2*h)`). Kept out of `SIZE_EXPR_VARIABLES` itself so a formula that
 * references `d` with no surface attached fails to PARSE with a clear "unknown
 * name" error, rather than silently reading NaN and falling back to `h`.
 */
export const REMESH_DISTANCE_VAR = "d";

/**
 * `SIZE_EXPR_VARIABLES`, plus `REMESH_DISTANCE_VAR` when a distance surface is
 * attached, plus `extraVars` — the mesh's own existing Nodal field names (see
 * `fieldCalc.ts`'s `scopeVariables`), which is what lets a sizing formula
 * reference any variable the Variables panel (or `fieldCalc`/`sdfDistance`
 * directly) already computed — including a field named "d" from an EARLIER
 * step in the same sequence (`mesh_transform`'s own chaining story), which is
 * exactly the natural name to give such a field — plus `globalVars`, the
 * mesh's global (scalar) variable names from `model.globals` (see
 * `globalReduce.ts`), recomputed from the current fields at scope-build time.
 *
 * A name colliding with `SIZE_EXPR_VARIABLES` (h/x/y/z/stats) is always
 * dropped rather than shadowing it — a field literally named "H" must not
 * hijack the remesher's own nodal-size variable. "d" is different: it is
 * reserved only when THIS call actually attaches a distance surface (the
 * surface's own unsigned distance must win over a same-named stale field);
 * otherwise "d" carries no built-in meaning here at all, and a field by that
 * name is exactly the point of this widening, not a collision to guard
 * against. Globals follow the same rule, with one more rung: a global whose
 * name collides with an existing FIELD name is dropped too — per-entity
 * lookup stays primary, and the `reduceField` message already warns at
 * creation time.
 */
export function remeshSizeExprVars(
  hasDistanceSurface: boolean,
  extraVars: readonly string[] = [],
  globalVars: readonly string[] = []
): readonly string[] {
  const base = hasDistanceSurface ? [...SIZE_EXPR_VARIABLES, REMESH_DISTANCE_VAR] : SIZE_EXPR_VARIABLES;
  const reserved = new Set<string>(hasDistanceSurface ? base : SIZE_EXPR_VARIABLES);
  const extra = extraVars.filter((v) => !reserved.has(v));
  const taken = new Set<string>([...reserved, ...extra]);
  // Lowercased: the parser lowercases identifiers before matching, so a
  // mixed-case global must enter lowercase (callers may already have).
  const globals = globalVars
    .map((v) => v.toLowerCase())
    .filter((v) => !taken.has(v));
  const out = [...base, ...extra];
  if (globals.length > 0) out.push(...globals);
  return out;
}

/**
 * Identifiers refused even by `validateSizeExprLenient`'s otherwise-permissive
 * check: `expressionSizes`/`fieldCalcModel` build a plain `{}` scope object to
 * evaluate against, and a name like `__proto__` would hit that object's own
 * special setter rather than read like an ordinary variable.
 */
const UNSAFE_NAMES = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

/** A `Set` whose `.has()` accepts any name except `UNSAFE_NAMES` and `reject`. */
class PermissiveVarSet extends Set<string> {
  constructor(private readonly reject: ReadonlySet<string>) {
    super();
  }
  has(name: string): boolean {
    return !UNSAFE_NAMES.has(name) && !this.reject.has(name);
  }
}

/**
 * Validates a remesh sizing formula at RECIPE-LOAD time, when the mesh it
 * will eventually replay against is not known yet (a saved recipe may run
 * against a different mesh than the one it was authored on, so the exact
 * Nodal field list cannot be checked here — see `operations.ts`'s
 * `validateParams`). Accepts any syntactically well-formed expression whose
 * bare names are not JS-unsafe, EXCEPT `d`, which is still refused unless
 * `hasDistanceSurface` — that one variable's availability IS fully derivable
 * from the record itself, so it keeps the strict, immediate check. Real
 * "unknown name" resolution for every other identifier happens later, in
 * `expressionSizes`, against the mesh actually being remeshed.
 */
export function validateSizeExprLenient(src: string, hasDistanceSurface: boolean): string | undefined {
  const reject = hasDistanceSurface ? new Set<string>() : new Set([REMESH_DISTANCE_VAR]);
  try {
    parseSizeExpr(src, new PermissiveVarSet(reject));
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const STD_ALIASES: Record<string, string> = { stdev: "std", sigma: "std" };

/** Own-property lookup guard (never walks the prototype chain). */
function has(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// --- AST ----------------------------------------------------------------------

type Node =
  | { t: "num"; v: number }
  | { t: "var"; name: string }
  | { t: "const"; v: number }
  | { t: "unary"; op: "-"; e: Node }
  | { t: "binary"; op: string; l: Node; r: Node }
  | { t: "call"; name: string; args: Node[] };

// --- tokenizer ----------------------------------------------------------------

type Token =
  | { k: "num"; v: number }
  | { k: "ident"; v: string }
  | { k: "op"; v: string }
  | { k: "lparen" }
  | { k: "rparen" }
  | { k: "comma" };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isDigit = (c: string) => c >= "0" && c <= "9";
  const isIdentStart = (c: string) => /[a-zA-Z_]/.test(c);
  const isIdentPart = (c: string) => /[a-zA-Z0-9_]/.test(c);
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(src[i + 1] ?? ""))) {
      let j = i;
      while (j < src.length && isDigit(src[j])) j++;
      if (src[j] === ".") {
        j++;
        while (j < src.length && isDigit(src[j])) j++;
      }
      // Scientific notation: e / E followed by an optional sign and digits.
      if (src[j] === "e" || src[j] === "E") {
        let k = j + 1;
        if (src[k] === "+" || src[k] === "-") k++;
        if (isDigit(src[k] ?? "")) {
          k++;
          while (k < src.length && isDigit(src[k])) k++;
          j = k;
        }
      }
      const text = src.slice(i, j);
      const v = Number(text);
      if (!Number.isFinite(v)) throw new Error(`Invalid number "${text}".`);
      tokens.push({ k: "num", v });
      i = j;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < src.length && isIdentPart(src[j])) j++;
      tokens.push({ k: "ident", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if ("+-*/%^".includes(c)) {
      tokens.push({ k: "op", v: c });
      i++;
      continue;
    }
    if (c === "(") { tokens.push({ k: "lparen" }); i++; continue; }
    if (c === ")") { tokens.push({ k: "rparen" }); i++; continue; }
    if (c === ",") { tokens.push({ k: "comma" }); i++; continue; }
    throw new Error(`Unexpected character "${c}".`);
  }
  return tokens;
}

// --- parser (recursive descent, standard precedence) --------------------------

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[], private readonly allowed: Set<string>) {}

  parse(): Node {
    if (this.tokens.length === 0) throw new Error("Empty expression.");
    const node = this.parseExpr();
    if (this.pos < this.tokens.length) {
      throw new Error("Unexpected trailing input in the expression.");
    }
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  // expr := term (('+' | '-') term)*
  private parseExpr(): Node {
    let node = this.parseTerm();
    for (let tok = this.peek(); tok?.k === "op" && (tok.v === "+" || tok.v === "-"); tok = this.peek()) {
      this.pos++;
      node = { t: "binary", op: tok.v, l: node, r: this.parseTerm() };
    }
    return node;
  }

  // term := unary (('*' | '/' | '%') unary)*
  private parseTerm(): Node {
    let node = this.parseUnary();
    for (
      let tok = this.peek();
      tok?.k === "op" && (tok.v === "*" || tok.v === "/" || tok.v === "%");
      tok = this.peek()
    ) {
      this.pos++;
      node = { t: "binary", op: tok.v, l: node, r: this.parseUnary() };
    }
    return node;
  }

  // unary := ('-' | '+') unary | power
  // Unary binds looser than '^' so that `-2^2` is `-(2^2)` (standard convention).
  private parseUnary(): Node {
    const tok = this.peek();
    if (tok?.k === "op" && (tok.v === "-" || tok.v === "+")) {
      this.pos++;
      const e = this.parseUnary();
      return tok.v === "-" ? { t: "unary", op: "-", e } : e;
    }
    return this.parsePower();
  }

  // power := primary ('^' unary)?    (right-associative; exponent may be unary)
  private parsePower(): Node {
    const base = this.parsePrimary();
    const tok = this.peek();
    if (tok?.k === "op" && tok.v === "^") {
      this.pos++;
      return { t: "binary", op: "^", l: base, r: this.parseUnary() };
    }
    return base;
  }

  // primary := num | ident '(' args ')' | ident | '(' expr ')'
  private parsePrimary(): Node {
    const tok = this.peek();
    if (!tok) throw new Error("Unexpected end of expression.");
    if (tok.k === "num") {
      this.pos++;
      return { t: "num", v: tok.v };
    }
    if (tok.k === "lparen") {
      this.pos++;
      const e = this.parseExpr();
      const close = this.peek();
      if (close?.k !== "rparen") throw new Error("Missing closing parenthesis.");
      this.pos++;
      return e;
    }
    if (tok.k === "ident") {
      this.pos++;
      // A `(` immediately after the name makes it a function call; otherwise it
      // is a variable / constant. This is what lets `min` be both the stat
      // variable and the `min(a, b)` function unambiguously.
      if (this.peek()?.k === "lparen") {
        return this.parseCall(tok.v);
      }
      const name = tok.v.toLowerCase();
      // Own-property checks only: `"constructor" in CONSTANTS` is true via the
      // prototype chain, which would otherwise leak JS internals into a formula.
      if (has(CONSTANTS, name)) return { t: "const", v: CONSTANTS[name] };
      const canonical = has(STD_ALIASES, name) ? STD_ALIASES[name] : name;
      if (!this.allowed.has(canonical)) {
        throw new Error(
          `Unknown name "${tok.v}". Available variables: ${[...this.allowed].join(", ")}.`
        );
      }
      return { t: "var", name: canonical };
    }
    throw new Error("Expected a number, name or parenthesis in the expression.");
  }

  private parseCall(name: string): Node {
    const fname = name.toLowerCase();
    const spec = has(FUNCTIONS, fname) ? FUNCTIONS[fname] : undefined;
    if (!spec) {
      throw new Error(`Unknown function "${name}()". Available: ${Object.keys(FUNCTIONS).join(", ")}.`);
    }
    this.pos++; // consume '('
    const args: Node[] = [];
    if (this.peek()?.k !== "rparen") {
      args.push(this.parseExpr());
      while (this.peek()?.k === "comma") {
        this.pos++;
        args.push(this.parseExpr());
      }
    }
    const close = this.peek();
    if (close?.k !== "rparen") throw new Error(`Missing closing parenthesis in "${name}()".`);
    this.pos++;
    if (spec.arity !== "any" && args.length !== spec.arity) {
      throw new Error(`"${name}()" expects ${spec.arity} argument(s), got ${args.length}.`);
    }
    if (spec.arity === "any" && args.length === 0) {
      throw new Error(`"${name}()" needs at least one argument.`);
    }
    return { t: "call", name: fname, args };
  }
}

// --- evaluation ---------------------------------------------------------------

function evalNode(node: Node, scope: Record<string, number>): number {
  switch (node.t) {
    case "num":
    case "const":
      return node.v;
    case "var":
      return scope[node.name] ?? NaN;
    case "unary":
      return -evalNode(node.e, scope);
    case "binary": {
      const l = evalNode(node.l, scope);
      const r = evalNode(node.r, scope);
      switch (node.op) {
        case "+": return l + r;
        case "-": return l - r;
        case "*": return l * r;
        case "/": return l / r;
        case "%": return l % r;
        case "^": return Math.pow(l, r);
        default: return NaN;
      }
    }
    case "call":
      return FUNCTIONS[node.name].fn(node.args.map((a) => evalNode(a, scope)));
  }
}

function collectVars(node: Node, into: Set<string>): void {
  switch (node.t) {
    case "var":
      into.add(node.name);
      return;
    case "unary":
      collectVars(node.e, into);
      return;
    case "binary":
      collectVars(node.l, into);
      collectVars(node.r, into);
      return;
    case "call":
      for (const a of node.args) collectVars(a, into);
      return;
    default:
      return;
  }
}

/**
 * Parses `src` into a reusable, evaluable expression. `allowedVars` is the set
 * of bare variable names the expression may reference (the constants `pi`/`e`
 * and all functions are always available). Throws a descriptive `Error` on any
 * syntax error, unknown name, unknown function or wrong function arity.
 */
export function parseSizeExpr(
  src: string,
  allowedVars: readonly string[] | ReadonlySet<string> = SIZE_EXPR_VARIABLES
): CompiledExpr {
  const allowed = allowedVars instanceof Set ? allowedVars : new Set(allowedVars);
  const ast = new Parser(tokenize(src), allowed).parse();
  const used = new Set<string>();
  collectVars(ast, used);
  return {
    source: src,
    variablesUsed: [...used],
    evaluate: (scope) => evalNode(ast, scope),
  };
}

/**
 * Convenience validator: returns `undefined` when `src` parses, else the error
 * message. Used by the webview to show inline feedback before posting an op.
 */
export function validateSizeExpr(
  src: string,
  allowedVars: readonly string[] | ReadonlySet<string> = SIZE_EXPR_VARIABLES
): string | undefined {
  try {
    parseSizeExpr(src, allowedVars);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Rewords an "unknown name" validation error for the one variable users
 * actually go looking for: `d`. A bare `Unknown name "d"` reads as "you
 * typed it wrong" when the real problem is almost always "nothing named `d`
 * is on the mesh yet" — this only ever fires when `d` is NOT in the allowed
 * set, i.e. no field by that name exists (a field named `d` is an ordinary
 * variable via `remeshSizeExprVars`). Returns the original message unchanged
 * for any other name, so callers can apply it blindly to whatever
 * `validateSizeExpr` reported.
 */
export function describeUnknownRemeshVar(msg: string): string {
  const m = /^Unknown name "([^"]+)"\./.exec(msg);
  if (m && m[1].toLowerCase() === REMESH_DISTANCE_VAR) {
    return (
      `Unknown variable "d" — nothing named "d" is on the mesh yet. ` +
      `Compute one first in the Variables section (e.g. Distance to a surface, named "d"), ` +
      `then reference it here.`
    );
  }
  return msg;
}
