import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverSeriesFiles, discoverSeriesSteps, collectFieldSeries } from "../parser/fieldSeriesScan";
import { parseMeshFile } from "../parser/meshFileParser";
import { writeMeshioBytes } from "../parser/meshio";
import { mergeSubparts } from "../parser/seriesSubparts";
import { groupVtkFiles } from "../parser/vtkFileGroup";
import { TIMELINE_EXTENSIONS } from "../parser/meshFormats";

function surface(ext: string, value: number): string {
  switch (ext) {
    case ".stl": return `solid m\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex ${value} 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid m\n`;
    case ".obj": return `v 0 0 0\nv ${value} 0 0\nv 0 1 0\ng Native\nf 1 2 3\n`;
    case ".ply": return `ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nproperty float TEMP\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0 ${value}\n1 0 0 ${value}\n0 1 0 ${value}\n3 0 1 2\n`;
    default: return `OFF\n3 1 0\n0 0 0\n${value} 0 0\n0 1 0\n3 0 1 2\n`;
  }
}

for (const ext of [".stl", ".obj", ".ply", ".off", ".msh", ".node", ".ele", ".case", ".med", ".cgns", ".h5m", ".hmf"]) {
  test(`${ext}: real per-frame readers, numeric order, rank and filename subparts`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "filename-series-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const base = path.join(dir, "base.off");
    fs.writeFileSync(base, surface(".off", 1));
    const nodeCount = ext === ".node" || ext === ".ele" ? 4 : 3;
    const native = [".stl", ".obj", ".ply", ".off"].includes(ext);
    for (const step of [10, 2]) {
      for (const prefix of ["Main", "Main_Edge"]) {
        const stem = `${prefix}_0_${step}`;
        if (ext === ".node" || ext === ".ele") {
          fs.writeFileSync(path.join(dir, stem + ".node"), `4 3 0 0\n1 0 0 0\n2 ${step} 0 0\n3 0 1 0\n4 0 0 1\n`);
          fs.writeFileSync(path.join(dir, stem + ".ele"), "1 4 0\n1 1 2 3 4\n");
        } else if (ext === ".case") {
          fs.writeFileSync(path.join(dir, stem + ".case"), `FORMAT\ntype: ensight gold\nGEOMETRY\nmodel: ${stem}.geo\n`);
          fs.writeFileSync(path.join(dir, stem + ".geo"), `Triangle\nFrame\nnode id assign\nelement id assign\npart\n1\nTriangle\ncoordinates\n3\n0\n${step}\n0\n0\n0\n1\n0\n0\n0\ntria3\n1\n1 2 3\n`);
        } else if (native) fs.writeFileSync(path.join(dir, stem + ext), surface(ext, step));
        else {
          const model = await parseMeshFile(base);
          model.coords[3] = step;
          const r = await writeMeshioBytes(model, ext as Parameters<typeof writeMeshioBytes>[1], { stem });
          fs.writeFileSync(path.join(dir, stem + ext), r.data);
          for (const c of r.companions) fs.writeFileSync(path.join(dir, c.name), c.data);
        }
      }
    }
    const opened = path.join(dir, `Main_0_2${ext}`);
    const { steps, source } = await discoverSeriesSteps(opened);
    assert.equal(source, "files");
    assert.deepEqual(steps.map((s) => s.label), ["2", "10"]);
    const models = await Promise.all(steps.map((s) => s.load!()));
    for (const model of models) assert.equal(model.nodeCount, nodeCount);
    if (ext === ".ply") {
      const series = await collectFieldSeries(steps, { kind: "Nodal", variable: "TEMP", entityId: 1 });
      assert.deepEqual(series.values, [[2], [10]]);
    } else assert.deepEqual(models.map((m) => m.bounds.max[0]), [2, 10]);
    const group = groupVtkFiles(fs.readdirSync(dir), TIMELINE_EXTENSIONS).find((g) => g.ext === ext)!;
    const merged = await mergeSubparts(models[0], group, dir, 0, "2", "Main");
    assert.ok(merged.some((p) => p.path === "Main.Edge" && p.elementIds.length === 1));
    for (const p of models[0].subModelParts) assert.ok(merged.includes(p));
    // Discovery does not parse bytes. An incomplete new step must not prevent
    // selecting an older frame, even when another rank/format shares the prefix.
    fs.writeFileSync(path.join(dir, `Main_0_20${ext}`), "incomplete");
    fs.writeFileSync(path.join(dir, `Main_1_2${ext}`), fs.readFileSync(opened));
    fs.writeFileSync(path.join(dir, "Main_0_999.vtk"), "incomplete");
    const grown = await discoverSeriesSteps(opened);
    assert.deepEqual(grown.steps.map((s) => s.label), ["2", "10", "20"]);
    assert.equal((await grown.steps[0].load!()).nodeCount, nodeCount);
    assert.equal((await discoverSeriesFiles(opened)).length, 3);
    const rank = await discoverSeriesSteps(path.join(dir, `Main_1_2${ext}`));
    assert.deepEqual(rank.steps.map((s) => s.label), ["2"]);
    assert.equal((await discoverSeriesSteps(base)).source, "single");
  });
}
