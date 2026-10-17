import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

const SCRIPT = path.join(__dirname, "..", "..", "scripts", "verify-fluid", "run.mjs");

const EXPECTED = [
  "fluid-monolithic",
  "fluid-fractional-step",
  "fluid-stokes",
  "fluid-weakly-compressible",
  "embedded",
  "two-fluids",
  "rans-k-epsilon",
  "rans-k-omega",
  "rans-k-omega-sst",
  "tunnel-sphere",
];

function run(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 120_000 });
  return { code: r.status, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
}

test("verify-fluid --list names one family per formulation and RANS model", () => {
  const r = run(["--list"]);
  assert.equal(r.code, 0, r.stderr);
  const ids = r.stdout.trim().split("\n").map((l) => l.split("\t")[0]);
  assert.deepEqual(ids, EXPECTED);
});

test("verify-fluid refuses an unknown family", () => {
  const r = run(["--family", "nope"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr + r.stdout, /unknown families: nope/);
});

test("verify-fluid reports an environment error without a Kratos Python", () => {
  const r = run(["--family", "fluid-monolithic", "--python", "/nonexistent/python-xyz-verify-fluid"]);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /environment-error|cannot probe|not importable/);
});
