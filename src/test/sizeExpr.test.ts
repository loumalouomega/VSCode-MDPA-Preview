import { test } from "node:test";
import assert from "node:assert";
import {
  parseSizeExpr,
  validateSizeExpr,
  validateSizeExprLenient,
  SIZE_EXPR_VARIABLES,
  remeshSizeExprVars,
  describeUnknownRemeshVar,
} from "../parser/sizeExpr";

const evalExpr = (src: string, scope: Record<string, number> = {}): number =>
  parseSizeExpr(src).evaluate(scope);

test("evaluates arithmetic with correct precedence", () => {
  assert.strictEqual(evalExpr("1 + 2 * 3"), 7);
  assert.strictEqual(evalExpr("(1 + 2) * 3"), 9);
  assert.strictEqual(evalExpr("10 - 4 - 2"), 4); // left-assoc subtraction
  assert.strictEqual(evalExpr("8 / 4 / 2"), 1); // left-assoc division
  assert.strictEqual(evalExpr("7 % 3"), 1);
});

test("power is right-associative and binds tighter than unary minus", () => {
  assert.strictEqual(evalExpr("2 ^ 3 ^ 2"), 512); // 2^(3^2) = 2^9
  assert.strictEqual(evalExpr("2 ^ 2 * 3"), 12);
  assert.strictEqual(evalExpr("-2 ^ 2"), -4); // -(2^2), standard math convention
  assert.strictEqual(evalExpr("2 ^ -2"), 0.25); // exponent may be unary
});

test("unary minus and scientific notation", () => {
  assert.strictEqual(evalExpr("-5"), -5);
  assert.strictEqual(evalExpr("--5"), 5);
  assert.strictEqual(evalExpr("1.5e-3"), 0.0015);
  assert.strictEqual(evalExpr("2.5E2"), 250);
  assert.ok(Math.abs(evalExpr(".5 + .25") - 0.75) < 1e-12);
});

test("variables resolve from the scope", () => {
  assert.strictEqual(evalExpr("0.5 * h", { h: 4 }), 2);
  assert.strictEqual(evalExpr("h + x + y + z", { h: 1, x: 2, y: 3, z: 4 }), 10);
  assert.strictEqual(evalExpr("mean - 1.5 * std", { mean: 10, std: 2 }), 7);
});

test("std aliases stdev and sigma", () => {
  assert.strictEqual(evalExpr("stdev", { std: 3 }), 3);
  assert.strictEqual(evalExpr("sigma * 2", { std: 3 }), 6);
});

test("constants pi and e are available and case-insensitive", () => {
  assert.ok(Math.abs(evalExpr("pi") - Math.PI) < 1e-12);
  assert.ok(Math.abs(evalExpr("E") - Math.E) < 1e-12);
});

test("math functions evaluate", () => {
  assert.strictEqual(evalExpr("min(3, 1, 2)"), 1);
  assert.strictEqual(evalExpr("max(3, 1, 2)"), 3);
  assert.strictEqual(evalExpr("clamp(5, 0, 3)"), 3);
  assert.strictEqual(evalExpr("clamp(-1, 0, 3)"), 0);
  assert.strictEqual(evalExpr("abs(-4)"), 4);
  assert.strictEqual(evalExpr("sqrt(9)"), 3);
  assert.strictEqual(evalExpr("pow(2, 10)"), 1024);
  assert.strictEqual(evalExpr("floor(2.9)"), 2);
  assert.strictEqual(evalExpr("ceil(2.1)"), 3);
  assert.strictEqual(evalExpr("round(2.5)"), 3);
});

test("min/max are both stat variables and functions (disambiguated by paren)", () => {
  // Bare `min`/`max` read the distribution stats from the scope...
  assert.strictEqual(evalExpr("min", { min: 7 }), 7);
  assert.strictEqual(evalExpr("max", { max: 9 }), 9);
  // ...while `min(...)`/`max(...)` call the functions.
  assert.strictEqual(evalExpr("min(min, 2)", { min: 7 }), 2);
  assert.strictEqual(evalExpr("clamp(0.5 * h, min, max)", { h: 100, min: 2, max: 8 }), 8);
});

test("the user's headline example compiles and evaluates", () => {
  const expr = parseSizeExpr("clamp(0.5*h, mean-1.5*std, mean+1.5*std)");
  assert.strictEqual(expr.evaluate({ h: 4, mean: 3, std: 1 }), 2); // 0.5*4=2 within [1.5,4.5]
  assert.strictEqual(expr.evaluate({ h: 100, mean: 3, std: 1 }), 4.5); // clamped to upper fence
  assert.strictEqual(expr.evaluate({ h: 0.1, mean: 3, std: 1 }), 1.5); // clamped to lower fence
});

test("variablesUsed reports only referenced variables", () => {
  const expr = parseSizeExpr("0.5 * h + x");
  assert.deepStrictEqual([...expr.variablesUsed].sort(), ["h", "x"]);
  assert.deepStrictEqual(parseSizeExpr("min(1, 2)").variablesUsed, []);
});

test("rejects unknown variables with a helpful message", () => {
  assert.throws(() => parseSizeExpr("foo + 1"), /Unknown name "foo"/);
  // A variable not in a restricted allow-list is rejected.
  assert.throws(() => parseSizeExpr("h + x", ["h"]), /Unknown name "x"/);
});

test("rejects unknown functions and wrong arity", () => {
  assert.throws(() => parseSizeExpr("frobnicate(1)"), /Unknown function "frobnicate/);
  assert.throws(() => parseSizeExpr("clamp(1, 2)"), /expects 3 argument/);
  assert.throws(() => parseSizeExpr("sqrt(1, 2)"), /expects 1 argument/);
  assert.throws(() => parseSizeExpr("min()"), /at least one argument/);
});

test("rejects malformed input", () => {
  assert.throws(() => parseSizeExpr(""), /Empty expression/);
  assert.throws(() => parseSizeExpr("1 +"), /Unexpected end/);
  assert.throws(() => parseSizeExpr("(1 + 2"), /closing parenthesis/);
  assert.throws(() => parseSizeExpr("1 2"), /trailing input/);
  assert.throws(() => parseSizeExpr("1 @ 2"), /Unexpected character/);
});

test("cannot reach the JS scope (no eval / property access)", () => {
  assert.throws(() => parseSizeExpr("constructor"), /Unknown name/);
  assert.throws(() => parseSizeExpr("__proto__"), /Unknown name/);
  assert.throws(() => parseSizeExpr("hasOwnProperty(1)"), /Unknown function/);
  assert.throws(() => parseSizeExpr("h.constructor"), /Unexpected character/);
  assert.throws(() => parseSizeExpr("global"), /Unknown name/);
});

test("validateSizeExpr returns undefined on success, message on failure", () => {
  assert.strictEqual(validateSizeExpr("0.5 * h"), undefined);
  assert.match(validateSizeExpr("0.5 * bogus") ?? "", /Unknown name "bogus"/);
});

test("SIZE_EXPR_VARIABLES lists the documented remesh scope", () => {
  assert.deepStrictEqual(
    [...SIZE_EXPR_VARIABLES],
    ["h", "x", "y", "z", "mean", "std", "min", "max", "median", "q1", "q3", "iqr"]
  );
});

test("remeshSizeExprVars adds `d` only when a distance surface is attached", () => {
  assert.deepStrictEqual([...remeshSizeExprVars(false)], [...SIZE_EXPR_VARIABLES]);
  assert.deepStrictEqual(
    [...remeshSizeExprVars(true)],
    [...SIZE_EXPR_VARIABLES, "d"]
  );
  assert.match(validateSizeExpr("0.1 + 0.4*d", remeshSizeExprVars(false)) ?? "", /Unknown name "d"/);
  assert.strictEqual(validateSizeExpr("0.1 + 0.4*d", remeshSizeExprVars(true)), undefined);
});

test("remeshSizeExprVars appends extra (field-derived) names, dropping any reserved collision", () => {
  assert.deepStrictEqual(
    [...remeshSizeExprVars(false, ["temperature", "d_x"])],
    [...SIZE_EXPR_VARIABLES, "temperature", "d_x"]
  );
  // A field literally named the same as a reserved variable must not shadow
  // it — "h" and "d" here are dropped, not appended a second time.
  assert.deepStrictEqual(
    [...remeshSizeExprVars(true, ["h", "d", "porosity"])],
    [...SIZE_EXPR_VARIABLES, "d", "porosity"]
  );
  assert.deepStrictEqual([...remeshSizeExprVars(false, [])], [...SIZE_EXPR_VARIABLES]);
});

test("remeshSizeExprVars: a plain field named \"d\" is usable when no distance surface is attached", () => {
  // "d" carries no built-in meaning unless THIS call attaches a distance
  // surface — otherwise a field by that name (e.g. one an earlier sdfDistance
  // step in the same mesh_transform sequence just computed) is an ordinary
  // variable, which is the whole point of the chaining story.
  assert.deepStrictEqual(
    [...remeshSizeExprVars(false, ["d"])],
    [...SIZE_EXPR_VARIABLES, "d"]
  );
  assert.strictEqual(validateSizeExpr("0.1 + 0.4*d", remeshSizeExprVars(false, ["d"])), undefined);
  // But a REAL attached surface still wins over a same-named stale field —
  // no duplicate, and the surface's own meaning is what "d" resolves to.
  assert.deepStrictEqual(
    [...remeshSizeExprVars(true, ["d"])],
    [...SIZE_EXPR_VARIABLES, "d"]
  );
});

test("validateSizeExprLenient accepts any well-formed name but still gates `d` on hasDistanceSurface", () => {  // A model-dependent field name unknown to this (model-free) layer is
  // accepted here — full resolution happens later, against the real mesh.
  assert.strictEqual(validateSizeExprLenient("0.5 * temperature", false), undefined);
  assert.strictEqual(validateSizeExprLenient("0.1 + 0.4*d", true), undefined);
  assert.match(validateSizeExprLenient("0.1 + 0.4*d", false) ?? "", /Unknown name "d"/);
  // Genuine syntax errors are still caught.
  assert.match(validateSizeExprLenient("1 +", false) ?? "", /./);
  assert.match(validateSizeExprLenient("clamp(1, 2)", false) ?? "", /expects 3 argument/);
  // JS-unsafe identifiers are refused even though they are not in the
  // reserved set — a plain {} scope object is built from these names.
  assert.match(validateSizeExprLenient("__proto__ + 1", false) ?? "", /Unknown name/);
  assert.match(validateSizeExprLenient("constructor", false) ?? "", /Unknown name/);
});

test("describeUnknownRemeshVar points a missing `d` at the Variables section, nothing else", () => {
  // The exact error the user reported: the base-only scope has no `d` and no
  // field names, so the message must say where to compute one — not just
  // repeat the unknown name.
  const raw = validateSizeExpr("clamp(0.001 + 0.05*d, 0.001, 0.02)", remeshSizeExprVars(false)) ?? "";
  assert.match(raw, /Unknown name "d"/);
  const hinted = describeUnknownRemeshVar(raw);
  assert.match(hinted, /Unknown variable "d"/);
  assert.match(hinted, /Variables section/);
  // Any other unknown name passes through untouched.
  const other = validateSizeExpr("0.5*bogus", remeshSizeExprVars(false)) ?? "";
  assert.strictEqual(describeUnknownRemeshVar(other), other);
  // Case-insensitive: a formula written with uppercase D names the same slot.
  assert.match(describeUnknownRemeshVar('Unknown name "D". Available variables: h.'), /Variables section/);
});

test("remeshSizeExprVars appends globals, dropping reserved and field collisions", () => {
  assert.deepStrictEqual(
    [...remeshSizeExprVars(false, [], ["max_temp"])],
    [...SIZE_EXPR_VARIABLES, "max_temp"]
  );
  // Reserved names never admit a global…
  assert.deepStrictEqual([...remeshSizeExprVars(false, [], ["h", "mean", "d"])], [
    ...SIZE_EXPR_VARIABLES,
    "d",
  ]);
  // …and neither does a name a field already claims (fields win).
  assert.deepStrictEqual(
    [...remeshSizeExprVars(false, ["temp"], ["temp", "max_temp"])],
    [...SIZE_EXPR_VARIABLES, "temp", "max_temp"]
  );
  assert.strictEqual(
    validateSizeExpr("0.5*h + 0.001*max_temp", remeshSizeExprVars(false, [], ["max_temp"])),
    undefined
  );
});
