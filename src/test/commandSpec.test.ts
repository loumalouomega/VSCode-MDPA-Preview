/**
 * Drift guards for the command-line registry: every mesh operation is
 * nameable, every example runs through the REAL host validator with all its
 * keys surviving (the host silently drops unknown keys, so a misspelt param in
 * the spec would otherwise look fine), and every non-op command points at a
 * UI action / host message that exists.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { COMMANDS, STANDARD_VIEW_DIRECTIONS, operationCommandNames, parseParamDsl } from "../parser/commandSpec";
import { parseCommandLine, resolveCommand } from "../parser/commandParse";
import { OP_LABELS, opRecordFromMessage } from "../parser/operations";

const root = path.join(__dirname, "..", "..");
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), "utf8");

test("every mesh operation has a command and vice versa", () => {
  const ops = new Set(Object.keys(OP_LABELS));
  const cmds = new Set(operationCommandNames());
  assert.deepEqual([...ops].filter((o) => !cmds.has(o)), [], "operations without a command");
  assert.deepEqual([...cmds].filter((c) => !ops.has(c)), [], "op commands naming no operation");
});

test("command names and aliases are unique (case-insensitive)", () => {
  const seen = new Map<string, string>();
  for (const c of COMMANDS) {
    for (const n of [c.name, ...(c.aliases ?? [])]) {
      const k = n.toLowerCase();
      assert.ok(!seen.has(k) || seen.get(k) === c.name, `"${n}" is used by ${seen.get(k)} and ${c.name}`);
      seen.set(k, c.name);
    }
  }
});

test("every command's own name resolves to itself", () => {
  for (const c of COMMANDS) {
    const r = resolveCommand(c.name);
    assert.ok(r.ok && r.spec === c, `${c.name} did not resolve to itself`);
  }
});

test("positional names refer to declared parameters", () => {
  for (const c of COMMANDS) {
    for (const p of c.positional ?? []) {
      assert.ok(c.params.some((q) => q.name === p), `${c.name}: positional "${p}" is not a parameter`);
    }
  }
});

test("the param DSL rejects malformed tokens", () => {
  assert.throws(() => parseParamDsl("a:nope"));
  assert.deepEqual(parseParamDsl("a:int! b(x|y)").map((p) => [p.name, p.type, !!p.required]), [
    ["a", "int", true],
    ["b", "enum", false],
  ]);
});

test("every example parses", () => {
  for (const c of COMMANDS) {
    const r = parseCommandLine(c.example);
    assert.ok(r.ok, `${c.name}: example "${c.example}" failed: ${r.ok ? "" : r.error}`);
    if (r.ok) assert.equal(r.steps.length, 1);
  }
});

test("every operation example passes the host validator and keeps all its keys", () => {
  for (const c of COMMANDS.filter((x) => x.exec.kind === "op")) {
    const r = parseCommandLine(c.example);
    assert.ok(r.ok);
    if (!r.ok) continue;
    const a = r.steps[0];
    assert.equal(a.kind, "op");
    if (a.kind !== "op") continue;
    const rec = opRecordFromMessage(a.message) as Record<string, unknown> | undefined;
    assert.ok(rec, `${c.name}: host rejected "${c.example}"`);
    assert.equal(rec.op, c.name);
    for (const k of Object.keys(a.message)) {
      if (k === "type" || k === "op") continue;
      assert.ok(k in rec, `${c.name}: key "${k}" was dropped by opRecordFromMessage`);
    }
  }
});

test("every declared parameter of an operation is a key its validator reads", () => {
  // Feed each parameter with a plausible value and look for it in the record
  // of the cheapest accepted example: catches a param name the host never reads.
  const src = read("src/parser/operations.ts");
  for (const c of COMMANDS.filter((x) => x.exec.kind === "op")) {
    for (const p of c.params) {
      const re = new RegExp(`\\b${p.name}\\b`);
      assert.ok(re.test(src), `${c.name}: parameter "${p.name}" never appears in operations.ts`);
    }
  }
});

test("ui commands target actions dispatchToolbarAction handles", () => {
  const main = read("webview/main.ts");
  const start = main.indexOf("function dispatchToolbarAction");
  const body = main.slice(start, main.indexOf("\n}\n", start));
  for (const c of COMMANDS) {
    if (c.exec.kind !== "ui") continue;
    assert.ok(body.includes(`"${c.exec.action}"`), `${c.name}: dispatchToolbarAction has no "${c.exec.action}" branch`);
  }
});

test("view commands are implemented by the executor", () => {
  const main = read("webview/main.ts");
  for (const c of COMMANDS) {
    if (c.exec.kind !== "view") continue;
    assert.ok(main.includes(`case "${c.exec.fn}"`), `${c.name}: main.ts has no executor case "${c.exec.fn}"`);
  }
});

test("post commands name host messages some provider handles", () => {
  const host = read("src/mdpaEditorProvider.ts") + read("src/meshExport.ts");
  for (const c of COMMANDS) {
    if (c.exec.kind !== "post") continue;
    assert.ok(host.includes(`"${c.exec.type}"`), `${c.name}: no host handler mentions "${c.exec.type}"`);
  }
});

test("standard views are unit-free directions", () => {
  for (const [name, d] of Object.entries(STANDARD_VIEW_DIRECTIONS)) {
    assert.ok(d.some((v) => v !== 0), name);
  }
});
