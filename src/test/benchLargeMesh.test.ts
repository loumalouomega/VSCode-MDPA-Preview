/** The verdict logic behind scripts/bench/large-mesh.mjs --check (the timing itself is not a unit test: it is flaky on shared CI). */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

interface Row { runs?: number; wallMs: number; maxStallMs: number; extra?: Record<string, number> }
interface Verdict { name: string; verdict: string; reason: string }
interface Stats {
  summarizeMeshRuns(runs: Row[]): Row;
  judgeMeshCase(name: string, row: Row | undefined): Verdict;
  largeMeshPasses(v: Verdict[], o?: { strict?: boolean }): boolean;
}
const importEsm = new Function("u", "return import(u)") as (u: string) => Promise<Stats>;
const load = (): Promise<Stats> => importEsm(pathToFileURL(path.resolve(__dirname, "..", "..", "scripts", "bench", "largeMeshStats.mjs")).href);
const row = (o: Partial<Row>): Row => ({ wallMs: 1, maxStallMs: 0, ...o });

test("runs fold to medians", async () => {
  const { summarizeMeshRuns } = await load();
  const s = summarizeMeshRuns([row({ wallMs: 10 }), row({ wallMs: 30 }), row({ wallMs: 20 })]);
  assert.equal(s.wallMs, 20);
  assert.equal(s.runs, 3);
});

test("wire conversion is judged per million field rows", async () => {
  const { judgeMeshCase } = await load();
  assert.equal(judgeMeshCase("wire-eager", row({ wallMs: 1000, extra: { fieldRows: 1_000_000 } })).verdict, "pass");
  assert.equal(judgeMeshCase("wire-eager", row({ wallMs: 9000, extra: { fieldRows: 1_000_000 } })).verdict, "fail");
});

test("LOD time and memory ratio have budgets; unmeasured is unverified", async () => {
  const { judgeMeshCase, largeMeshPasses } = await load();
  assert.equal(judgeMeshCase("lod", row({ wallMs: 500 })).verdict, "pass");
  assert.equal(judgeMeshCase("lod", row({ wallMs: 90_000 })).verdict, "fail");
  assert.equal(judgeMeshCase("memory", row({ extra: { peakRssMb: 500, modelMb: 100 } })).verdict, "pass");
  assert.equal(judgeMeshCase("memory", row({ extra: { peakRssMb: 5000, modelMb: 100 } })).verdict, "fail");
  assert.equal(judgeMeshCase("lod", undefined).verdict, "unverified");
  const v = [{ name: "a", verdict: "pass", reason: "" }, { name: "b", verdict: "unverified", reason: "" }];
  assert.equal(largeMeshPasses(v), true);
  assert.equal(largeMeshPasses(v, { strict: true }), false);
});
