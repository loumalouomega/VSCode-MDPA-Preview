import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  BatchEntry,
  BatchManifest,
  outputCompanions,
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

test("companion paths are predicted per extension", () => {
  assert.deepEqual(outputCompanions("/out/a.xdmf"), { paths: [path.resolve("/out/a.h5")], unpredictable: false });
  assert.deepEqual(outputCompanions("/out/a.xmf"), { paths: [path.resolve("/out/a.h5")], unpredictable: false });
  assert.deepEqual(outputCompanions("/out/a.ele"), { paths: [path.resolve("/out/a.node")], unpredictable: false });
  assert.deepEqual(outputCompanions("/out/a.case"), { paths: [path.resolve("/out/a.geo")], unpredictable: false });
  assert.deepEqual(outputCompanions("/out/a.post.msh"), {
    paths: [path.resolve("/out/a.post.res")],
    unpredictable: false,
  });
  assert.deepEqual(outputCompanions("/out/x.foam"), {
    paths: [path.resolve("/out/constant")],
    unpredictable: false,
  });
  assert.deepEqual(outputCompanions("/out/a.vtm").unpredictable, true);
  assert.deepEqual(outputCompanions("/out/a.xml").unpredictable, true);
  assert.deepEqual(outputCompanions("/out/a.vtu"), { paths: [], unpredictable: false });
});

test("an existing companion is refused unless overwrite", () => {
  const exists = (p: string) => p.endsWith(".h5");
  const p = plan(["/in/a.vtu"], { outputExt: ".xdmf", exists });
  assert.match(p.problems.join("\n"), /Companion .*\.h5.* already exists/);
  assert.deepEqual(plan(["/in/a.vtu"], { outputExt: ".xdmf", exists, overwrite: true }).problems, []);
});

test("a companion that is another input is refused", () => {
  const p = plan(["/out/a.vtu", "/out/a.h5"], { outputDir: "/out", recipeName: "r", caseInsensitive: false, naming: "{stem}{ext}", outputExt: ".xdmf" });
  // "/out/a.vtu" -> "/out/a.xdmf" (+ companion "/out/a.h5", which is an input);
  // "/out/a.h5" -> "/out/a.xdmf" as well, so the outputs also collide.
  assert.match(p.problems.join("\n"), /Companion .*\.h5.*also an input/);
});

test("two .foam outputs in one directory collide on constant/", () => {
  const p = plan(["/in/a.vtu", "/in/b.vtu"], { naming: "{stem}{ext}", outputExt: ".foam" });
  assert.match(p.problems.join("\n"), /both map to .*constant/);
  // Structural collisions are not lifted by overwrite (only existence checks are):
  // two markers in one directory would still share one constant/ tree, and no
  // naming template can fix that — batch at most one .foam per outputDir.
  assert.match(
    plan(["/in/a.vtu", "/in/b.vtu"], { naming: "{stem}{ext}", outputExt: ".foam", overwrite: true }).problems.join("\n"),
    /both map to .*constant/
  );
  assert.match(
    plan(["/in/a.vtu", "/in/b.vtu"], { naming: "{index}{ext}", outputExt: ".foam" }).problems.join("\n"),
    /at most one \.foam per outputDir/
  );
});

test("a .foam output inside an input's own case directory is refused", () => {
  const p = planBatch({
    inputs: ["/c/run.foam"],
    outputDir: "/c",
    recipeName: "r",
    caseInsensitive: false,
  });
  assert.match(p.problems.join("\n"), /would rewrite the OpenFOAM case/);
  const elsewhere = planBatch({
    inputs: ["/c/run.foam"],
    outputDir: "/out",
    recipeName: "r",
    caseInsensitive: false,
    outputExt: ".foam",
  });
  assert.deepEqual(elsewhere.problems, []);
});

test("model-dependent companions warn instead of refusing", () => {
  const p = plan(["/in/a.vtu"], { outputExt: ".vtm" });
  assert.deepEqual(p.problems, []);
  assert.match(p.warnings.join("\n"), /model-dependent companions/);
  const q = plan(["/in/a.vtu"], { outputExt: ".vtu" });
  assert.deepEqual(q.warnings, []);
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

test("an abort mid-file leaves the entry pending, not failed, and stops the run", async () => {
  const ctl = new AbortController();
  const saved: BatchManifest[] = [];
  let calls = 0;
  const deps = {
    stampOf: () => "s1",
    save: (m: BatchManifest) => saved.push(JSON.parse(JSON.stringify(m))),
    process: async () => {
      calls++;
      if (calls === 2) {
        // An in-flight op interrupted: the worker is terminated and the op
        // rejects, exactly as a mid-remesh cancel does.
        ctl.abort();
        throw new Error("cancelled");
      }
    },
  };
  const entries = plan(["/in/a.vtu", "/in/b.vtu", "/in/c.vtu"]).entries;
  const r = await runBatch(entries, deps, { recipeName: "r", recipeHash: "h", signal: ctl.signal });
  assert.equal(r.cancelled, true);
  assert.equal(calls, 2);
  assert.deepEqual(
    r.manifest.entries.map((e) => [e.status, e.message]),
    [
      ["done", undefined],
      ["pending", "Cancelled mid-file; nothing was recorded for this file."],
      ["pending", undefined],
    ]
  );
  // The manifest was persisted after the abort, so a resume retries file two.
  assert.equal(saved.length, 2);
  assert.equal(saved[1].entries[1].status, "pending");
});

test("a genuine failure while uncancelled is still recorded as failed", async () => {
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

test("a failed entry without a report parses tolerantly", () => {
  const parsed = parseBatchManifest(
    '{"version":1,"recipeName":"r","recipeHash":"h","entries":[{"input":"/a","output":"/b","status":"failed","message":"boom"}]}'
  );
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.manifest?.entries[0].status, "failed");
  assert.equal(parsed.manifest?.entries[0].report, undefined);
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
