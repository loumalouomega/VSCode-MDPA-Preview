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
  allowedVars: readonly string[] = SIZE_EXPR_VARIABLES
): CompiledExpr {
  const allowed = new Set(allowedVars);
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
  allowedVars: readonly string[] = SIZE_EXPR_VARIABLES
): string | undefined {
  try {
    parseSizeExpr(src, allowedVars);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
