import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  BatchEntry,
  BatchManifest,
  parseBatchManifest,
  planBatch,
  runBatch,
  serializeBatchManifest,
} from "../parser/batchPlan";

const plan = (inputs: string[], extra = {}) =>
  planBatch({ inputs, outputDir: "/out", recipeName: "My Recipe", caseInsensitive: false, ...extra });

test("names are deterministic and sanitized", () => {
  const p = plan(["/in/a_0_1.vtu", "/in/a_0_2.vtu"]);
  assert.deepEqual(p.problems, []);
  assert.deepEqual(p.entries.map((e) => e.output), [
    path.resolve("/out/a_0_1_My_Recipe.vtu"),
    path.resolve("/out/a_0_2_My_Recipe.vtu"),
  ]);
});

test("an output that is another input is refused", () => {
  const p = planBatch({
    inputs: ["/out/a.vtu", "/out/a_r.vtu"],
    outputDir: "/out",
    recipeName: "r",
    caseInsensitive: false,
  });
  assert.match(p.problems.join("\n"), /also an input/);
});

test("same stem from two folders collides unless {index} is used", () => {
  const two = ["/x/a.vtu", "/y/a.vtu"];
  assert.match(plan(two).problems.join("\n"), /both map to/);
  assert.deepEqual(plan(two, { naming: "{index}_{stem}{ext}" }).problems, []);
});

test("existing outputs are refused unless overwrite", () => {
  const exists = () => true;
  assert.match(plan(["/in/a.vtu"], { exists }).problems.join("\n"), /already exists/);
  assert.deepEqual(plan(["/in/a.vtu"], { exists, overwrite: true }).problems, []);
});

test("case-insensitive comparison catches a differently-cased clash", () => {
  const p = planBatch({
    inputs: ["/out/A_r.vtu", "/in/a.vtu"],
    outputDir: "/out",
    recipeName: "r",
    caseInsensitive: true,
  });
  assert.match(p.problems.join("\n"), /also an input/);
});

test("template without {stem}/{index} is refused", () => {
  assert.match(plan(["/in/a.vtu"], { naming: "fixed.vtu" }).problems.join("\n"), /must contain/);
});

function runner(failOn?: string, abortAfter?: { ctl: AbortController; n: number }) {
  const saved: BatchManifest[] = [];
  const processed: string[] = [];
  const deps = {
    stampOf: () => "s1",
    save: (m: BatchManifest) => saved.push(JSON.parse(JSON.stringify(m))),
    process: async (e: BatchEntry) => {
      processed.push(e.input);
      if (e.input === failOn) throw new Error("boom");
      if (abortAfter && processed.length === abortAfter.n) abortAfter.ctl.abort();
    },
  };
  return { deps, saved, processed };
}

test("a failing file is recorded and the rest still run", async () => {
  const { deps, processed } = runner("/in/b.vtu");
  const entries = plan(["/in/a.vtu", "/in/b.vtu", "/in/c.vtu"]).entries;
  const r = await runBatch(entries, deps, { recipeName: "r", recipeHash: "h" });
  assert.equal(processed.length, 3);
  assert.deepEqual([r.done, r.failed], [2, 1]);
  assert.equal(r.manifest.entries[1].message, "boom");
});

test("cancel stops between files and leaves the rest pending", async () => {
  const ctl = new AbortController();
  const { deps, processed } = runner(undefined, { ctl, n: 1 });
  const entries = plan(["/in/a.vtu", "/in/b.vtu", "/in/c.vtu"]).entries;
  const r = await runBatch(entries, deps, { recipeName: "r", recipeHash: "h", signal: ctl.signal });
  assert.equal(r.cancelled, true);
  assert.equal(processed.length, 1);
  assert.equal(r.manifest.entries.filter((e) => e.status === "pending").length, 3);
});

test("resume skips done files with an unchanged input, redoes failed ones", async () => {
  const first = runner("/in/b.vtu");
  const entries = plan(["/in/a.vtu", "/in/b.vtu"]).entries;
  const r1 = await runBatch(entries, first.deps, { recipeName: "r", recipeHash: "h" });
  const second = runner();
  const r2 = await runBatch(plan(["/in/a.vtu", "/in/b.vtu"]).entries, second.deps, {
    recipeName: "r",
    recipeHash: "h",
    resume: r1.manifest,
  });
  assert.deepEqual(second.processed, ["/in/b.vtu"]);
  assert.equal(r2.skipped, 1);
});

test("resume is ignored when the recipe changed or the input changed", async () => {
  const a = runner();
  const r1 = await runBatch(plan(["/in/a.vtu"]).entries, a.deps, { recipeName: "r", recipeHash: "h" });
  const b = runner();
  const r2 = await runBatch(plan(["/in/a.vtu"]).entries, b.deps, {
    recipeName: "r",
    recipeHash: "other",
    resume: r1.manifest,
  });
  assert.equal(b.processed.length, 1);
  assert.match(r2.resumeNote ?? "", /different recipe/);
  const c = runner();
  c.deps.stampOf = () => "s2";
  await runBatch(plan(["/in/a.vtu"]).entries, c.deps, { recipeName: "r", recipeHash: "h", resume: r1.manifest });
  assert.equal(c.processed.length, 1);
});

test("manifest round trip and tolerant parse", () => {
  const m: BatchManifest = {
    version: 1,
    recipeName: "r",
    recipeHash: "h",
    entries: [{ input: "/a", output: "/b", status: "done", inputStamp: "s" }],
  };
  assert.deepEqual(JSON.parse(JSON.stringify(parseBatchManifest(serializeBatchManifest(m)).manifest)), m);
  assert.equal(parseBatchManifest("nope").manifest, undefined);
  const odd = parseBatchManifest('{"entries":[{"input":1},{"input":"/a","output":"/b","status":"weird"}]}');
  assert.equal(odd.manifest?.entries[0].status, "pending");
  assert.equal(odd.warnings.length, 1);
});
