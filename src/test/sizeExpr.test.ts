import { test } from "node:test";
import assert from "node:assert";
import { parseSizeExpr, validateSizeExpr, SIZE_EXPR_VARIABLES } from "../parser/sizeExpr";

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
