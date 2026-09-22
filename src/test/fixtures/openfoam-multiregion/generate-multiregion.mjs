// Regenerate the multi-region OpenFOAM case fixture (roadmap item 3, Step 5):
// `constant/fluid/polyMesh` (hex box x∈[0,1]) and `constant/solid/polyMesh`
// (hex box x∈[1,2]), each written by meshio++'s own openfoam writer to its
// own throwaway root, then copied into the final tree — there is no way to
// point the writer directly at `constant/<region>/polyMesh` (it always
// derives `constant/polyMesh` relative to the written path's own parent).
// Each region also gets a uniform time-zero field (`0/<region>/T`) written
// by hand in the plain OpenFOAM ascii dictionary grammar, to exercise the
// region-aware field read (`readOpenFoamTimeFields(..., region)`).
//
// Run from the repo root: node src/test/fixtures/openfoam-multiregion/generate-multiregion.mjs
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadMeshioPlusPlus } from "@meshioplusplus/wasm";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "case");

function hexAt(x0) {
  const g = [
    [x0, 0, 0], [x0 + 1, 0, 0], [x0 + 1, 1, 0], [x0, 1, 0],
    [x0, 0, 1], [x0 + 1, 0, 1], [x0 + 1, 1, 1], [x0, 1, 1],
  ];
  const flat = [];
  for (const p of g) flat.push(...p);
  return {
    points: new Float64Array(flat),
    dim: 3,
    cells: [{ type: "hexahedron", data: new Int32Array([0, 1, 2, 3, 4, 5, 6, 7]), nodesPerCell: 8 }],
  };
}

const m = await loadMeshioPlusPlus({}, { variant: "seq" });

m.writeMesh("/fluid_root/case.foam", hexAt(0), "openfoam");
m.writeMesh("/solid_root/case.foam", hexAt(1), "openfoam");

function copyPolyMesh(memfsRoot, region) {
  const src = `${memfsRoot}/constant/polyMesh`;
  const destDir = path.join(OUT, "constant", region, "polyMesh");
  mkdirSync(destDir, { recursive: true });
  for (const f of m.FS.readdir(src)) {
    if (f === "." || f === "..") continue;
    writeFileSync(path.join(destDir, f), Buffer.from(m.FS.readFile(`${src}/${f}`)));
  }
}

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
copyPolyMesh("/fluid_root", "fluid");
copyPolyMesh("/solid_root", "solid");

const FIELD_HEADER = (obj) =>
  `FoamFile\n{\n    version     2.0;\n    format      ascii;\n    class       volScalarField;\n    object      ${obj};\n}\n`;

for (const [region, value] of [["fluid", 300], ["solid", 500]]) {
  const dir = path.join(OUT, "0", region);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "T"),
    FIELD_HEADER("T") + `internalField   uniform ${value};\n` + "boundaryField\n{\n}\n"
  );
}

writeFileSync(path.join(OUT, "case.foam"), "");

// Verify the shape this fixture exists to pin, before committing it: each
// region reads by its bare polyMesh DIRECTORY path directly (measured
// against the live wasm — see collectOpenFoamCase's own doc comment). The
// wasm module's own MEMFS is what readMesh reads from, not the real disk,
// so the just-written fixture files are staged there too (the exact staging
// collectOpenFoamCase performs).
for (const [region, expectedX] of [["fluid", 0], ["solid", 1]]) {
  const vdir = `/verify/${region}/polyMesh`;
  m.FS.mkdirTree(vdir);
  const dir = path.join(OUT, "constant", region, "polyMesh");
  for (const f of readdirSync(dir)) {
    m.FS.writeFile(`${vdir}/${f}`, readFileSync(path.join(dir, f)));
  }
  const mesh = m.readMesh(vdir, "openfoam");
  if (mesh.points.length / 3 !== 8) {
    throw new Error(`region ${region}: expected 8 points, got ${mesh.points.length / 3}`);
  }
  const xs = [];
  for (let i = 0; i < 8; i++) xs.push(mesh.points[i * 3]);
  const minX = Math.min(...xs);
  if (Math.abs(minX - expectedX) > 1e-9) {
    throw new Error(`region ${region}: expected min x ${expectedX}, got ${minX}`);
  }
}

console.log("wrote openfoam-multiregion/case/ (fluid x∈[0,1], solid x∈[1,2])");
