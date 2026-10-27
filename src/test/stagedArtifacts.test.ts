/** The rules behind scripts/staged/check-staged-mcp.mjs; the spawning itself is not a unit test. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

interface Staged {
  REQUIRED_ARTIFACTS: string[];
  REMOVABLE: Record<string, (p: string) => boolean>;
  missingArtifacts(files: string[], required?: string[]): string[];
  bareRequires(text: string): string[];
  unexpectedRequires(text: string, allowed?: Record<string, string>): string[];
  pathsUnder(root: string, paths: string[]): string[];
  createFramer(): { push(c: string): { messages: unknown[]; malformed: string[] }; pendingBytes(): number };
  diffInvariants(a: unknown, b: unknown, o?: { abs?: number; rel?: number; ignore?: string[] }): string[];
  summarize(r: { status: string }[]): { pass: number; fail: number; unverified: number; ok: boolean; verified: boolean };
}
const importEsm = new Function("u", "return import(u)") as (u: string) => Promise<Staged>;
const load = (): Promise<Staged> =>
  importEsm(pathToFileURL(path.resolve(__dirname, "..", "..", "scripts", "staged", "stagedCheck.mjs")).href);

test("a complete stage has nothing missing and each removable name hits real artifacts", async () => {
  const s = await load();
  assert.deepEqual(s.missingArtifacts(s.REQUIRED_ARTIFACTS), []);
  for (const [name, hit] of Object.entries(s.REMOVABLE)) {
    const gone = s.REQUIRED_ARTIFACTS.filter(hit);
    assert.ok(gone.length > 0, `${name} matches no required artifact`);
    assert.deepEqual(s.missingArtifacts(s.REQUIRED_ARTIFACTS.filter((p) => !hit(p))), gone);
  }
});

test("missing artifacts are found with Windows separators too", async () => {
  const s = await load();
  const files = s.REQUIRED_ARTIFACTS.filter((p) => p !== "dist/mmg-core.wasm").map((p) => p.replace(/\//g, "\\"));
  assert.deepEqual(s.missingArtifacts(files), ["dist/mmg-core.wasm"]);
});

test("bare requires ignore builtins and relative paths and report the package", async () => {
  const s = await load();
  const text = [
    'const a = require("node:fs"); const b = require("path"); const c = require("./local");',
    'const d = require("pyodide"); const e = require("@scope/pkg/deep/file"); const f = require("lodash/fp");',
    "const g = require('fs/promises'); const h = require(\"../up\");",
  ].join("\n");
  assert.deepEqual(s.bareRequires(text), ["@scope/pkg", "lodash", "pyodide"]);
});

test("only unlisted packages are unexpected", async () => {
  const s = await load();
  assert.deepEqual(s.unexpectedRequires('require("pyodide"); require("ajv/dist/runtime/equal");'), []);
  assert.deepEqual(s.unexpectedRequires('require("pyodide"); require("express");'), ["express"]);
});

test("paths under the repo root are found, siblings with the same prefix are not", async () => {
  const s = await load();
  assert.deepEqual(
    s.pathsUnder("/home/u/repo", ["/home/u/repo/node_modules/x/index.js", "/home/u/repo-other/y.js", "/tmp/stage/z.js"]),
    ["/home/u/repo/node_modules/x/index.js"],
  );
});

test("the framer reassembles split chunks and reports stray stdout lines", async () => {
  const s = await load();
  const f = s.createFramer();
  assert.deepEqual(f.push('{"jsonrpc":"2.0","id":1,"res'), { messages: [], malformed: [] });
  assert.ok(f.pendingBytes() > 0);
  const r = f.push('ult":{}}\r\nnot json\n\n{"id":2}\n');
  assert.deepEqual(r.messages, [{ jsonrpc: "2.0", id: 1, result: {} }, { id: 2 }]);
  assert.deepEqual(r.malformed, ["not json"]);
  assert.equal(f.pendingBytes(), 0);
});

test("invariant diffs honour tolerance, ignore keys and name the path", async () => {
  const s = await load();
  const a = { n: 5, bounds: [0, 1.0000000001], t: 12, name: "x" };
  assert.deepEqual(s.diffInvariants(a, { n: 5, bounds: [0, 1], t: 99, name: "x" }, { abs: 1e-6, ignore: ["t"] }), []);
  const d = s.diffInvariants({ n: 5, bounds: [0, 2], extra: 1 }, { n: 6, bounds: [0, 1] });
  assert.deepEqual(d.map((x) => x.split(":")[0]), ["$.bounds[1]", "$.extra", "$.n"]);
});

test("a run with nothing verified, or any failure, is not ok", async () => {
  const s = await load();
  assert.deepEqual(s.summarize([{ status: "PASS" }, { status: "UNVERIFIED" }]), { pass: 1, fail: 0, unverified: 1, ok: true, verified: true });
  assert.equal(s.summarize([{ status: "PASS" }, { status: "FAIL" }]).ok, false);
  assert.equal(s.summarize([{ status: "UNVERIFIED" }]).verified, false);
});
