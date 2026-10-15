import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { PersistentPlotCache } from "../parser/plot/persistentCache";
import { PlotTableCache } from "../parser/plot/cache";
import { collectPlot, loadPlotSource } from "../parser/plot/sources";
import { emptyPlotRecipe } from "../parser/plot/recipe";
import { runPlotWorker } from "../plotWorkerClient";
import { removeScratchDir } from "./scratchCleanup";
import type { PlotSource, PlotTable } from "../parser/plot/types";

const NOTE = /Persistent extraction cache hit/;
const hit = (t: PlotTable) => t.diagnostics.some(d => NOTE.test(d));
const mdpa = (x: number) => `Begin Nodes\n1 0 0 0\n2 ${x} 0 0\n3 0 1 0\nEnd Nodes\nBegin Elements Element2D3N\n1 0 1 2 3\nEnd Elements\nBegin NodalData TEMP\n1 0 1\n2 0 2\n3 0 3\nEnd NodalData\n`;
async function scratch(): Promise<string> { return fs.mkdtemp(path.join(os.tmpdir(), "kratos-plotcache-")); }

test("a persistent hit survives a restart; a changed source file is a miss", async () => {
  const dir = await scratch();
  try {
    const file = path.join(dir, "m.mdpa"), cacheDir = path.join(dir, "cache");
    await fs.writeFile(file, mdpa(1));
    const source: PlotSource = { id: "n", type: "mesh", kind: "Nodes", path: file };
    const first = await loadPlotSource(source, { persistent: new PersistentPlotCache(cacheDir) });
    assert.equal(hit(first), false);
    // New cache object over the same directory = a restarted worker/session.
    const second = await loadPlotSource(source, { persistent: new PersistentPlotCache(cacheDir) });
    assert.equal(hit(second), true);
    assert.deepEqual(second.rows, first.rows);
    await fs.writeFile(file, mdpa(5));
    const third = await loadPlotSource(source, { persistent: new PersistentPlotCache(cacheDir) });
    assert.equal(hit(third), false);
    assert.notDeepEqual(third.rows, first.rows);
    // A different extraction setting never shares an entry.
    const other = await loadPlotSource({ ...source, ids: [1] } as PlotSource, { persistent: new PersistentPlotCache(cacheDir) });
    assert.equal(hit(other), false);
  } finally { await removeScratchDir(dir); }
});

test("histories are cached per source and invalidated by a changed or missing timeline companion", async () => {
  const dir = await scratch();
  try {
    const cacheDir = path.join(dir, "cache");
    for (const step of [2, 4, 6]) await fs.copyFile(path.resolve(__dirname, `../../example/VTK/Main_0_${step}.vtk`), path.join(dir, `Main_0_${step}.vtk`));
    const source: PlotSource = { id: "h", type: "history", path: path.join(dir, "Main_0_2.vtk"), kind: "Nodal", entityId: 4, variable: "PRESSURE" };
    const first = await loadPlotSource(source, { persistent: new PersistentPlotCache(cacheDir) });
    assert.equal(first.rows.length, 3);
    assert.equal(hit(first), false);
    const second = await loadPlotSource(source, { persistent: new PersistentPlotCache(cacheDir) });
    assert.equal(hit(second), true);
    assert.deepEqual(second.rows, first.rows);
    // Touching a LATER step changes the timeline identity: the earlier-frame extraction is not reused.
    await fs.appendFile(path.join(dir, "Main_0_6.vtk"), "\n");
    assert.equal(hit(await loadPlotSource(source, { persistent: new PersistentPlotCache(cacheDir) })), false);
    // A missing step is a different timeline too.
    await fs.rm(path.join(dir, "Main_0_4.vtk"));
    const gone = await loadPlotSource(source, { persistent: new PersistentPlotCache(cacheDir) });
    assert.equal(hit(gone), false);
    assert.equal(gone.rows.length, 2);
  } finally { await removeScratchDir(dir); }
});

test("live snapshots are never cached on disk", async () => {
  const dir = await scratch();
  try {
    const file = path.join(dir, "m.mdpa"), cacheDir = path.join(dir, "cache");
    await fs.writeFile(file, mdpa(1));
    const { parseMdpaFile } = await import("../parser/mdpaParser");
    const model = await parseMdpaFile(file);
    await loadPlotSource({ id: "n", type: "mesh", kind: "Nodes", path: file }, { models: { n: model }, persistent: new PersistentPlotCache(cacheDir) });
    await assert.rejects(fs.readdir(cacheDir), /ENOENT/);
  } finally { await removeScratchDir(dir); }
});

test("a persistent entry never feeds the retained fixed-snapshot cache", async () => {
  const dir = await scratch();
  try {
    const file = path.join(dir, "m.mdpa"), cacheDir = path.join(dir, "cache");
    await fs.writeFile(file, mdpa(1));
    const recipe = emptyPlotRecipe({ id: "n", type: "mesh", kind: "Nodes", path: file });
    const persistent = new PersistentPlotCache(cacheDir);
    await collectPlot(recipe, { persistent }); // populates the persistent cache only
    const retained = new PlotTableCache();
    await assert.rejects(
      collectPlot(recipe, { persistent }, undefined, { cache: retained, reuseSources: ["n"] }),
      /fixed extraction is unavailable/
    );
  } finally { await removeScratchDir(dir); }
});

test("the cache is bounded by entry count, evicts the least recently used, and drops corrupt entries", async () => {
  const dir = await scratch();
  try {
    const cache = new PersistentPlotCache(dir, { maxEntries: 2 });
    const table = (n: number): PlotTable => ({ columns: [{ id: "a", label: "a", type: "number" }], rows: [[n]], diagnostics: [] });
    const k = (c: string) => c.repeat(64);
    await cache.set(k("a"), table(1));
    await new Promise(r => setTimeout(r, 20));
    await cache.set(k("b"), table(2));
    await new Promise(r => setTimeout(r, 20));
    assert.ok(await cache.get(k("a"))); // a is now more recent than b
    await new Promise(r => setTimeout(r, 20));
    await cache.set(k("c"), table(3));
    assert.equal(await cache.get(k("b")), undefined, "least recently used entry evicted");
    assert.ok(await cache.get(k("a")));
    assert.ok(await cache.get(k("c")));
    await fs.writeFile(path.join(dir, `v1-${k("c")}.json`), "{not json");
    assert.equal(await cache.get(k("c")), undefined);
    assert.equal((await fs.readdir(dir)).some(n => n.includes(k("c"))), false, "corrupt entry removed");
    // Non-finite values cannot round-trip through JSON, so such a table is not stored.
    assert.equal(await cache.set(k("d"), { ...table(0), rows: [[NaN]] }), false);
  } finally { await removeScratchDir(dir); }
});

test("the plot worker reuses the persistent cache across sessions", async () => {
  const dir = await scratch();
  try {
    const file = path.join(dir, "m.mdpa"), cacheDir = path.join(dir, "cache");
    await fs.writeFile(file, mdpa(1));
    const source: PlotSource = { id: "n", type: "mesh", kind: "Nodes", path: file };
    const first = await runPlotWorker({ source, cacheDir }) as PlotTable;
    const second = await runPlotWorker({ source, cacheDir }) as PlotTable;
    assert.equal(hit(first), false);
    assert.equal(hit(second), true);
    assert.deepEqual(second.rows, first.rows);
    assert.equal(hit(await runPlotWorker({ source }) as PlotTable), false, "no cacheDir = no cache");
  } finally { await removeScratchDir(dir); }
});

test("the stat shortcut skips rehashing untouched files and never survives a change", async () => {
  const dir = await scratch();
  try {
    const file = path.join(dir, "m.mdpa"), cacheDir = path.join(dir, "cache");
    await fs.writeFile(file, mdpa(1));
    await new Promise(r => setTimeout(r, 30)); // let the file settle past the (test-sized) trust window
    const source: PlotSource = { id: "n", type: "mesh", kind: "Nodes", path: file };
    const options = { statSettleMs: 10 };
    const cold = new PersistentPlotCache(cacheDir, options);
    assert.equal(hit(await loadPlotSource(source, { persistent: cold })), false);
    assert.ok(cold.counters.fullIdentities >= 1);
    // A restarted session: lookup is served from the stat manifest with no content hash at all.
    const warm = new PersistentPlotCache(cacheDir, options);
    assert.equal(hit(await loadPlotSource(source, { persistent: warm })), true);
    assert.equal(warm.counters.fullIdentities, 0);
    assert.equal(warm.counters.statHits, 1);
    // Same size, different bytes: ctime changes even if mtime is restored, so the shortcut misses.
    const before = await fs.stat(file);
    await fs.writeFile(file, mdpa(2));
    await fs.utimes(file, before.atime, before.mtime);
    const changed = new PersistentPlotCache(cacheDir, options);
    const table = await loadPlotSource(source, { persistent: changed });
    assert.equal(hit(table), false);
    assert.equal(changed.counters.statHits, 0);
    assert.equal(table.rows.find(r => r[0] === 2)?.some(v => v === 2), true);
    // An added sibling file changes the directory listing and defeats the shortcut too.
    await new Promise(r => setTimeout(r, 30));
    const settle = new PersistentPlotCache(cacheDir, options);
    await loadPlotSource(source, { persistent: settle });
    await fs.writeFile(path.join(dir, "m_0_1.mdpa"), mdpa(1));
    const listed = new PersistentPlotCache(cacheDir, options);
    await loadPlotSource(source, { persistent: listed });
    assert.equal(listed.counters.statHits, 0);
    // Opt-out and the default trust window: a just-written file is never trusted.
    const off = new PersistentPlotCache(cacheDir, { statFastPath: false });
    await loadPlotSource(source, { persistent: off });
    assert.equal(off.counters.statHits, 0);
    await fs.writeFile(file, mdpa(3));
    const fresh = new PersistentPlotCache(cacheDir);
    await loadPlotSource(source, { persistent: fresh });
    const again = new PersistentPlotCache(cacheDir);
    await loadPlotSource(source, { persistent: again });
    assert.equal(again.counters.statHits, 0, "a file written within the default settle window is rehashed");
  } finally { await removeScratchDir(dir); }
});
