import assert from "node:assert/strict";
import test from "node:test";

import {
  completions,
  parseCommand,
  parseCommandLine,
  resolveCommand,
  splitSteps,
  tokenize,
  usageLine,
} from "../parser/commandParse";
import { COMMANDS } from "../parser/commandSpec";

function ok(line: string) {
  const r = parseCommandLine(line);
  assert.ok(r.ok, `"${line}" failed: ${r.ok ? "" : r.error}`);
  return r.ok ? r.steps : [];
}
function fail(line: string) {
  const r = parseCommandLine(line);
  assert.ok(!r.ok, `"${line}" should have failed`);
  return r.ok ? { error: "", hint: "" } : { error: r.error, hint: r.hint ?? "" };
}

test("splitSteps ignores ; inside quotes and brackets", () => {
  assert.deepEqual(splitSteps("a ; b;c"), ["a", "b", "c"]);
  assert.deepEqual(splitSteps('fieldCalc expr="a;b" ; undo'), ['fieldCalc expr="a;b"', "undo"]);
  assert.deepEqual(splitSteps('refine select={"by":"part","path":"x;y"}'), ['refine select={"by":"part","path":"x;y"}']);
  assert.deepEqual(splitSteps("  ;  ; "), []);
});

test("tokenize keeps quotes and brackets together", () => {
  const { tokens, unterminated } = tokenize('crop kind=bbox lo=[0, 0, 0] name="a b"');
  assert.deepEqual(tokens.map((t) => t.text), ["crop", "kind=bbox", "lo=[0, 0, 0]", 'name="a b"']);
  assert.equal(unterminated, false);
  assert.equal(tokenize('x "abc').unterminated, true);
});

test("key=value arguments are coerced by type", () => {
  const [a] = ok("translate dx=1.5 dy=-2");
  assert.deepEqual(a, { kind: "op", op: "translate", message: { type: "applyOp", op: "translate", dx: 1.5, dy: -2 } });
  const [b] = ok("smooth method=taubin iterations=5 fixBoundary=false");
  assert.equal(b.kind === "op" && b.message.fixBoundary, false, "the host's Boolean(\"false\") trap is avoided");
  const [c] = ok("addSubModelPartEntities path=A kind=nodes ids=1,2,5-7");
  assert.deepEqual(c.kind === "op" && c.message.ids, [1, 2, 5, 6, 7]);
  const [d] = ok("crop kind=bbox lo=0,0,0 hi=[1,2,3]");
  assert.deepEqual(d.kind === "op" && [d.message.lo, d.message.hi], [[0, 0, 0], [1, 2, 3]]);
  const [e] = ok("mergeMesh paths=a.mdpa,b.mdpa weld");
  assert.deepEqual(e.kind === "op" && [e.message.paths, e.message.weld], [["a.mdpa", "b.mdpa"], true]);
});

test("a JSON object supplies the arguments (CAD-Preview style)", () => {
  const [a] = ok('translate {"dx":1,"dz":3}');
  assert.deepEqual(a.kind === "op" && a.message, { type: "applyOp", op: "translate", dx: 1, dz: 3 });
  const [b] = ok('refine {"levels":2,"select":{"by":"part","path":"Inlet"}}');
  assert.deepEqual(b.kind === "op" && b.message.select, { by: "part", path: "Inlet" });
});

test("json-typed values try JSON, then fall back to text; quotes force text", () => {
  const num = ok("setProperty propertyId=1 name=E value=2.1e11")[0];
  assert.equal(num.kind === "op" && num.message.value, 2.1e11);
  const str = ok("setProperty propertyId=1 name=LAW value=LinearElastic3D")[0];
  assert.equal(str.kind === "op" && str.message.value, "LinearElastic3D");
  const forced = ok('setProperty propertyId=1 name=N value="5"')[0];
  assert.equal(forced.kind === "op" && forced.message.value, "5");
  const arr = ok("setProperty propertyId=1 name=V value=[1,2,3]")[0];
  assert.deepEqual(arr.kind === "op" && arr.message.value, [1, 2, 3]);
});

test("positional arguments, case-insensitivity and prefixes", () => {
  const [a] = ok("MERGENODES 1e-6");
  assert.deepEqual(a.kind === "op" && a.message.tolerance, 1e-6);
  const [b] = ok("rotate z 90");
  assert.deepEqual(b.kind === "op" && [b.message.axis, b.message.angle], ["z", 90]);
  const [c] = ok("view top");
  assert.deepEqual(c, { kind: "view", fn: "standardView", args: { name: "top" } });
  const [d] = ok("find element 12");
  assert.deepEqual(d, { kind: "view", fn: "find", args: { type: "Element", id: 12 } });
});

test("ambiguous prefix is reported, unique prefix resolves", () => {
  const r = resolveCommand("lin");
  assert.equal(r.ok, false);
  assert.ok(!r.ok && /linearToQuadratic|linearize/.test(r.hint ?? ""));
  assert.ok(resolveCommand("lineart").ok);
});

test("ui toggles accept on/off", () => {
  assert.deepEqual(ok("wireframe on")[0], { kind: "ui", action: "wireframe", state: true });
  assert.deepEqual(ok("wireframe off")[0], { kind: "ui", action: "wireframe", state: false });
  assert.deepEqual(ok("quality")[0], { kind: "ui", action: "quality", state: undefined });
  assert.deepEqual(ok("nodeids")[0], { kind: "ui", action: "nodeIds", state: undefined });
  assert.deepEqual(ok("reset")[0], { kind: "ui", action: "reset", state: undefined });
});

test("host messages: plain, with args, and nested options", () => {
  assert.deepEqual(ok("undo")[0], { kind: "post", message: { type: "opUndo" } });
  assert.deepEqual(ok("revert 3")[0], { kind: "post", message: { type: "opRevertTo", index: 3 } });
  assert.deepEqual(ok("export vtu")[0], { kind: "post", message: { type: "menuExport", format: ".vtu" } });
  assert.deepEqual(ok("exportTable csv Nodes membership")[0], {
    kind: "post",
    message: { type: "menuExportTable", format: ".csv", kind: "Nodes", opts: { membership: true } },
  });
});

test("steps run in order; the failing step is named", () => {
  const steps = ok("translate dx=1 ; scale sx=2 ; undo");
  assert.deepEqual(steps.map((s) => s.kind), ["op", "op", "post"]);
  const r = parseCommandLine("translate dx=1 ; scale sx=oops");
  assert.ok(!r.ok);
  assert.ok(!r.ok && r.error.startsWith("step 2:") && r.step === 1);
});

test("errors name the problem and give a hint", () => {
  assert.match(fail("tranlate dx=1").error, /unknown command|ambiguous/i);
  assert.match(fail("zzz").hint, /list/);
  const unknownKey = fail("translate dxx=1");
  assert.match(unknownKey.error, /unknown parameter "dxx"/);
  assert.match(unknownKey.hint, /did you mean dx/);
  assert.match(fail("rotate").error, /missing required parameter "axis"/);
  assert.match(fail("rotate axis=w").error, /not one of x \| y \| z/);
  assert.match(fail("translate dx=abc").error, /"abc" is not a number/);
  assert.match(fail("addSubModelPartEntities path=A kind=nodes ids=oops").error, /id list/);
  assert.match(fail('translate {"dx":').error, /invalid JSON|unbalanced/);
  assert.match(fail("translate 5").error, /unexpected "5"/);
  assert.match(fail('translate dx="1').error, /unbalanced/);
  assert.match(fail("").error, /empty/);
  assert.match(fail("rotate angle=3").hint, /rotate axis=<x\|y\|z>/);
});

test("usageLine shows required, optional and enum params", () => {
  const spec = COMMANDS.find((c) => c.name === "rotate")!;
  assert.equal(usageLine(spec), "rotate axis=<x|y|z> [angle=<number>] [cx=<number>] [cy=<number>] [cz=<number>]");
});

test("help resolves a command by name or via ?", () => {
  assert.deepEqual(ok("help rotate")[0], { kind: "meta", fn: "help", args: { command: "rotate" } });
  assert.deepEqual(ok("?rotate")[0], { kind: "meta", fn: "help", args: { command: "rotate" } });
  assert.deepEqual(ok("?")[0], { kind: "meta", fn: "help", args: {} });
});

test("completion: verbs, params, enum values, context-supplied names", () => {
  assert.deepEqual(completions("transl").candidates, ["translate"]);
  assert.ok(completions("").candidates.length > 50);
  assert.ok(completions("rotate ").candidates.includes("axis="));
  const params = completions("translate d");
  assert.deepEqual(params.candidates, ["dx=", "dy=", "dz="]);
  assert.equal(params.from, "translate ".length);
  const axis = completions("rotate axis=");
  assert.deepEqual(axis.candidates, ["x", "y", "z"]);
  assert.equal(axis.from, "rotate axis=".length);
  assert.deepEqual(completions("rotate axis=y").candidates, ["y"]);
  assert.deepEqual(completions("view t").candidates, ["top"]);
  const v = completions("fieldGradient variable=T", { fields: ["TEMPERATURE", "PRESSURE", "TEMP2"] });
  assert.deepEqual(v.candidates, ["TEMPERATURE", "TEMP2"]);
  const parts = completions("deleteSubModelPart path=", { parts: ["Inlet", "Outlet"] });
  assert.deepEqual(parts.candidates, ["Inlet", "Outlet"]);
  // Used parameters are not offered again; later steps complete independently.
  assert.ok(!completions("translate dx=1 d").candidates.includes("dx="));
  assert.deepEqual(completions("undo ; transl").candidates, ["translate"]);
  assert.deepEqual(completions("nonsense a").candidates, []);
});

test("parseCommand reports a command with no tokens", () => {
  assert.deepEqual(parseCommand("   "), { ok: false, error: "empty command" });
});
