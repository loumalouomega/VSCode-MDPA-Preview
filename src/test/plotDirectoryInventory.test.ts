import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { plotDirectoryInventory, PLOT_INVENTORY_ENTRIES } from "../parser/plot/directoryInventory";
import { plotSourceIdentity, plotHash } from "../parser/plot/revision";
import { bindPlotRun, verifyPlotRun, plotReceiptRevision } from "../parser/plot/runs";
import { freezeExecutionResult } from "../problemtype/runResultInventory";
import { EXECUTION_FILE, type ExecutionReceipt } from "../problemtype/runReceipt";
import { PlotWorkerSession } from "../plotWorkerClient";
import { plotRunBind, plotDataset } from "../mcp/tools";
import { emptyPlotRecipe } from "../parser/plot/recipe";
import { collectPlot } from "../parser/plot/sources";
import { assertPlotDestination } from "../parser/plot/files";
import type { PlotDataset } from "../parser/plot/types";

async function fixture(relative = "openfoam-multiregion/case", entrypoint = "case.foam") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "plot-directory-")), caseDir = path.join(directory, "case");
  await fs.cp(path.resolve("src/test/fixtures", relative), caseDir, { recursive: true });
  const source = path.join(caseDir, entrypoint), mesh = path.join(directory, "input.mdpa"), recordPath = path.join(directory, EXECUTION_FILE);
  await fs.writeFile(mesh, "Begin Nodes\n1 0 0 0\nEnd Nodes\n");
  const receipt: ExecutionReceipt = {
    version: 1, requestId: "directory-request", ownerId: "directory-study", jobId: "directory-run", state: "succeeded",
    runDirectory: directory, meshPath: mesh, createdAt: 1, updatedAt: 2,
    artifacts: [{ role: "mesh", path: mesh, revision: plotHash(await fs.readFile(mesh)) }, ...await freezeExecutionResult(source)],
  };
  const save = () => fs.writeFile(recordPath, JSON.stringify(receipt));
  await save();
  return { directory, caseDir, source, mesh, recordPath, receipt, save, dispose: () => fs.rm(directory, { recursive: true, force: true }) };
}

test("OpenFOAM complete region inventories bind through the shared worker/MCP contract", async () => {
  const f = await fixture(), session = new PlotWorkerSession();
  try {
    const identity = await plotSourceIdentity(f.source), run = await bindPlotRun(f.recordPath, f.source);
    assert.ok(identity.inventoryRevision?.startsWith("sha256:"));
    assert.ok(identity.files.some(file => file.path.endsWith("/constant/solid/polyMesh/points")));
    assert.ok(identity.files.some(file => file.path.endsWith("/0/fluid/T")));
    assert.equal(new Set(identity.files.map(file => file.path)).size, identity.files.length);
    assert.deepEqual(await session.run({ bindRun: { recordPath: f.recordPath, path: f.source } }), run);
    assert.deepEqual(await plotRunBind({ recordPath: f.recordPath, path: f.source }), run);
    const recipe = emptyPlotRecipe({ id: "temperature", type: "mesh", path: f.source, kind: "Elements", run });
    const table = await session.run({ source: recipe.sources[0] }) as import("../parser/plot/types").PlotTable;
    const temperature = table.columns.find(c => c.label === "T")!;
    assert.ok(temperature); assert.equal(temperature.unit, undefined, "A field named T does not supply a thermal unit");
    recipe.series = [{ id: "t", source: "temperature", name: "T (unknown unit)", x: table.columns[0].id, y: temperature.id }];
    const dataset = await collectPlot(recipe), mcp = await plotDataset({ recipe }) as PlotDataset;
    assert.equal(dataset.partial, false); assert.deepEqual(mcp.series[0].points, dataset.series[0].points);
    assert.deepEqual(dataset.series[0].points.map(p => p.y).sort((a,b)=>a!-b!), [300, 500]);
    assert.ok(dataset.series[0].points.every(p => p.origin?.runId === run.runId));
    for (const file of identity.files) await assert.rejects(() => assertPlotDestination(file.path, { recipe }), /cannot overwrite/);
  } finally { session.dispose(); await f.dispose(); }
});

test("marker and file hashes alone cannot retroactively establish directory-run ownership", async () => {
  const f = await fixture();
  try {
    const result = f.receipt.artifacts.find(a => a.role === "result")!;
    delete result.inventoryRevision; await f.save();
    await assert.rejects(() => bindPlotRun(f.recordPath, f.source), /frozen complete inventoryRevision/);
    result.inventoryRevision = "sha256:" + "0".repeat(64); await f.save();
    await assert.rejects(() => plotRunBind({ recordPath: f.recordPath, path: f.source }), /frozen complete inventoryRevision/);
  } finally { await f.dispose(); }
});

test("all regions, fields, dictionaries, moving overlays and compressed files participate", async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.caseDir, "system")); await fs.writeFile(path.join(f.caseDir, "system/controlDict"), "configuration");
    await fs.mkdir(path.join(f.caseDir, "1/fluid/polyMesh"), { recursive: true });
    await fs.writeFile(path.join(f.caseDir, "1/fluid/polyMesh/points.gz"), gzipSync("moving mesh"));
    await fs.writeFile(path.join(f.caseDir, "1/fluid/T.gz"), gzipSync("temperature field"));
    f.receipt.artifacts = [f.receipt.artifacts[0], ...await freezeExecutionResult(f.source)]; await f.save();
    const run = await bindPlotRun(f.recordPath, f.source);
    for (const name of ["constant/solid/polyMesh/points", "0/fluid/T", "system/controlDict", "1/fluid/polyMesh/points.gz", "1/fluid/T.gz"]) {
      const file = path.join(f.caseDir, name), original = await fs.readFile(file), stat = await fs.stat(file);
      await fs.writeFile(file, Buffer.from(original).fill(32)); await fs.utimes(file, stat.atime, stat.mtime);
      await assert.rejects(() => verifyPlotRun(run, f.source), /inventoryRevision/); await fs.writeFile(file, original);
    }
    // Arbitrary unrelated top-level export files do not become case inputs.
    await fs.writeFile(path.join(f.caseDir, "report.csv"), "unrelated");
    assert.equal((await verifyPlotRun(run, f.source)).revision, run.sourceRevision);
  } finally { await f.dispose(); }
});

test("removed fields and added empty time/region trees refuse new binding, not only old recipes", async () => {
  const f = await fixture();
  try {
    const field = path.join(f.caseDir, "0/fluid/T"), bytes = await fs.readFile(field);
    await fs.unlink(field); await assert.rejects(() => bindPlotRun(f.recordPath, f.source), /inventoryRevision/);
    await fs.writeFile(field, bytes);
    const time = path.join(f.caseDir, "2"); await fs.mkdir(time);
    await assert.rejects(() => bindPlotRun(f.recordPath, f.source), /inventoryRevision/); await fs.rmdir(time);
    const region = path.join(f.caseDir, "constant/empty-region"); await fs.mkdir(region);
    await assert.rejects(() => bindPlotRun(f.recordPath, f.source), /inventoryRevision/);
  } finally { await f.dispose(); }
});

test("portable frozen closure survives moving an isolated run, with explicit rebinding", async () => {
  const f = await fixture(), moved = f.directory + "-moved";
  try {
    const before = await plotSourceIdentity(f.source), run = await bindPlotRun(f.recordPath, f.source), receiptRevision = plotReceiptRevision(f.receipt);
    await fs.rename(f.directory, moved);
    const source = path.join(moved, "case/case.foam"), recordPath = path.join(moved, EXECUTION_FILE);
    const after = await plotSourceIdentity(source);
    assert.equal(after.inventoryRevision, before.inventoryRevision); assert.notEqual(after.revision, before.revision);
    const rebound = await bindPlotRun(recordPath, source); assert.equal(rebound.receiptRevision, receiptRevision);
    await assert.rejects(() => verifyPlotRun({ ...run, recordPath }, source), /identity changed/);
  } finally { await fs.rm(moved, { recursive: true, force: true }); await f.dispose(); }
});

for (const [relative, entrypoint, changed] of [
  ["openfoam-decomposed/case", "case.foam", "processor1/constant/polyMesh/faceProcAddressing"],
  ["cae/elmer", "mesh.header", "mesh.nodes"],
  ["cae/elmer-binary", "mesh.header", "mesh.nodes.bin"],
  ["cae/elmer-partitioned", "parts.elmer", "partitioning.2/part.2.shared"],
  ["cae/mfem-ranks", "rank.mesh.000000", "rank.mesh.000001"],
]) test(`${relative}: companions are frozen once, without recursive rediscovery`, async () => {
  const f = await fixture(relative, entrypoint);
  try {
    const run = await bindPlotRun(f.recordPath, f.source), file = path.join(f.caseDir, changed);
    const identity = await verifyPlotRun(run, f.source); assert.ok(identity.files.some(f => f.path === file));
    await fs.appendFile(file, "\n"); await assert.rejects(() => bindPlotRun(f.recordPath, f.source), /inventoryRevision/);
  } finally { await f.dispose(); }
});

test("Elmer/MFEM additions and symlinked dependencies cannot be hidden by the staging collector", async () => {
  for (const [relative, entrypoint, companion] of [
    ["cae/elmer", "tetra.elmer", "mesh.nodes"], ["cae/mfem-ranks", "rank.mesh.000000", "rank.mesh.000001"],
  ]) {
    const f = await fixture(relative, entrypoint);
    try {
      const file = path.join(f.caseDir, companion); await fs.rename(file, file + ".original"); await fs.symlink(file + ".original", file);
      await assert.rejects(() => plotSourceIdentity(f.source), /symlinked dependencies/);
    } finally { await f.dispose(); }
  }
});

test("OpenFOAM inventories refuse linked fields/directories, marker-only cases and partial baselines", async () => {
  const f = await fixture();
  try {
    const field = path.join(f.caseDir, "0/fluid/linked"); await fs.symlink(path.join(f.caseDir, "0/fluid/T"), field);
    await assert.rejects(() => plotSourceIdentity(f.source), /symlinked dependencies/); await fs.unlink(field);
    const linked = path.join(f.caseDir, "3"); await fs.symlink(path.join(f.caseDir, "0"), linked);
    await assert.rejects(() => plotSourceIdentity(f.source), /symlinked dependencies/); await fs.unlink(linked);
    await fs.unlink(path.join(f.caseDir, "constant/solid/polyMesh/owner"));
    await assert.rejects(() => plotSourceIdentity(f.source), /missing.*solid.*owner/);
    const empty = path.join(f.directory, "empty"); await fs.mkdir(empty); await fs.writeFile(path.join(empty, "case.foam"), "");
    await assert.rejects(() => plotSourceIdentity(path.join(empty, "case.foam")), /marker-only/);
  } finally { await f.dispose(); }
});

test("bounded directory inventories are cancellable and detect enumeration changes", async t => {
  const f = await fixture();
  try {
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(() => plotDirectoryInventory(f.source, aborted.signal), /abort/i);
    const tooDeep = path.join(f.caseDir, "system", ...new Array(21).fill("nested")); await fs.mkdir(tooDeep, { recursive: true });
    await assert.rejects(() => plotSourceIdentity(f.source), /20 directory levels/);
    await fs.rm(path.join(f.caseDir, "system"), { recursive: true });
    const fsModule = require("node:fs/promises"), original = fsModule.opendir; let rootReads = 0;
    const mocked = t.mock.method(fsModule, "opendir", async (dir: string) => {
      if (dir === f.caseDir && ++rootReads === 2) await fs.mkdir(path.join(f.caseDir, "2"));
      return original(dir);
    });
    await assert.rejects(() => plotSourceIdentity(f.source), /inventory changed/); mocked.mock.restore();
    t.mock.method(fsModule, "opendir", async () => ({
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i <= PLOT_INVENTORY_ENTRIES; i++) yield { name: String(i), isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false };
      },
    }));
    await assert.rejects(() => plotDirectoryInventory(f.source), /50000 entries/);
  } finally { t.mock.restoreAll(); await f.dispose(); }
});
