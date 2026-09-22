// Regenerate the decomposed (`processorN/`) OpenFOAM case fixture (roadmap
// item 3, Step 5): two hexahedra sharing one face (cube A: x∈[0,1], points
// 0-7; cube B: x∈[1,2], sharing points 1,2,5,6 at x=1 with cube A), split by
// hand into one cell per processor — following meshio++'s own
// `tests/python/test_openfoam.py::TestDecomposedCase` recipe (same
// geometry, same `*ProcAddressing` construction), since a real
// `decomposePar` toolchain is not available in this environment.
//
// Each processor's own `constant/polyMesh/*` is written by meshio++'s own
// openfoam writer (never hand-built byte-for-byte); only the four small
// `*ProcAddressing` labelList files are written by hand, because that is
// exactly the information `decomposePar` adds on top of an ordinary
// per-processor mesh.
//
// Run from the repo root: node src/test/fixtures/openfoam-decomposed/generate-decomposed.mjs
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadMeshioPlusPlus } from "@meshioplusplus/wasm";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "case");

const g = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
  [2, 0, 0], [2, 1, 0], [2, 0, 1], [2, 1, 1],
];
const flat = (idxs) => {
  const out = [];
  for (const i of idxs) out.push(...g[i]);
  return new Float64Array(out);
};
const connA = [0, 1, 2, 3, 4, 5, 6, 7];
const bGlobal = [1, 2, 6, 5, 8, 9, 11, 10];
const connB = [0, 1, 2, 3, 4, 5, 6, 7];

const m = await loadMeshioPlusPlus({}, { variant: "seq" });
m.writeMesh("/p0/case.foam", { points: flat([0, 1, 2, 3, 4, 5, 6, 7]), dim: 3, cells: [{ type: "hexahedron", data: new Int32Array(connA), nodesPerCell: 8 }] }, "openfoam");
m.writeMesh("/p1/case.foam", { points: flat(bGlobal), dim: 3, cells: [{ type: "hexahedron", data: new Int32Array(connB), nodesPerCell: 8 }] }, "openfoam");

function readTxt(p) {
  return Buffer.from(m.FS.readFile(p)).toString("utf8");
}
// Small local reader for the writer's own faces/points ascii format,
// mirroring test_openfoam.py's _read_faces/_read_points closely enough to
// find the interface face — not a general-purpose parser.
function parseFaces(text) {
  const head = /\n(\d+)\n\(/.exec(text);
  const rest = text.slice(head.index + head[0].length);
  const faces = [];
  for (const line of rest.split("\n")) {
    const t = line.trim();
    if (t === ")") break;
    const fm = /^(\d+)\(([^)]*)\)$/.exec(t);
    if (fm) faces.push(fm[2].trim().split(/\s+/).map(Number));
  }
  return faces;
}
function parsePoints(text) {
  const head = /\n(\d+)\n\(/.exec(text);
  const rest = text.slice(head.index + head[0].length);
  const pts = [];
  for (const line of rest.split("\n")) {
    const t = line.trim();
    if (t === ")") break;
    const pm = /^\(([^)]*)\)$/.exec(t);
    if (pm) pts.push(pm[1].trim().split(/\s+/).map(Number));
  }
  return pts;
}
function interfaceFace(faces, pts) {
  for (let i = 0; i < faces.length; i++) {
    if (faces[i].every((n) => Math.abs(pts[n][0] - 1.0) < 1e-9)) return i;
  }
  throw new Error("no interface face found");
}

const facesA = parseFaces(readTxt("/p0/constant/polyMesh/faces"));
const ptsA = parsePoints(readTxt("/p0/constant/polyMesh/points"));
const facesB = parseFaces(readTxt("/p1/constant/polyMesh/faces"));
const ptsB = parsePoints(readTxt("/p1/constant/polyMesh/points"));
const ifaceA = interfaceFace(facesA, ptsA);
const ifaceB = interfaceFace(facesB, ptsB);

let nextId = 1;
function faceAddr(n, iface, flip) {
  const out = [];
  for (let f = 0; f < n; f++) {
    if (f === iface) out.push(flip ? -1 : 1); // global face id 0
    else {
      out.push(nextId + 1);
      nextId++;
    }
  }
  return out;
}
const faceAddrA = faceAddr(6, ifaceA, false);
const faceAddrB = faceAddr(6, ifaceB, true);

const HEADER = (cls, obj) =>
  `FoamFile\n{\n    version     2.0;\n    format      ascii;\n    class       ${cls};\n    object      ${obj};\n}\n`;
function writeLabelList(memfsDir, name, vals) {
  const text = `${HEADER("labelList", name)}${vals.length}\n(\n${vals.map(String).join("\n")}\n)\n`;
  m.FS.writeFile(`${memfsDir}/${name}`, text);
}
writeLabelList("/p0/constant/polyMesh", "pointProcAddressing", [0, 1, 2, 3, 4, 5, 6, 7]);
writeLabelList("/p0/constant/polyMesh", "cellProcAddressing", [0]);
writeLabelList("/p0/constant/polyMesh", "faceProcAddressing", faceAddrA);
writeLabelList("/p0/constant/polyMesh", "boundaryProcAddressing", [0]);
writeLabelList("/p1/constant/polyMesh", "pointProcAddressing", bGlobal);
writeLabelList("/p1/constant/polyMesh", "cellProcAddressing", [1]);
writeLabelList("/p1/constant/polyMesh", "faceProcAddressing", faceAddrB);
writeLabelList("/p1/constant/polyMesh", "boundaryProcAddressing", [0]);

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
for (const [proc, memfsDir] of [[0, "/p0/constant/polyMesh"], [1, "/p1/constant/polyMesh"]]) {
  const destDir = path.join(OUT, `processor${proc}`, "constant", "polyMesh");
  mkdirSync(destDir, { recursive: true });
  for (const f of m.FS.readdir(memfsDir)) {
    if (f === "." || f === "..") continue;
    writeFileSync(path.join(destDir, f), Buffer.from(m.FS.readFile(`${memfsDir}/${f}`)));
  }
}
writeFileSync(path.join(OUT, "case.foam"), "");

// Verify the shape this fixture exists to pin, before committing it: stage
// the just-written files back into the wasm's own MEMFS (the exact staging
// collectDecomposedOpenFoamCase performs) and read them by the case-root
// `.foam` marker path.
m.FS.mkdirTree("/verify");
for (const proc of [0, 1]) {
  const destDir = path.join(OUT, `processor${proc}`, "constant", "polyMesh");
  const vdir = `/verify/processor${proc}/constant/polyMesh`;
  m.FS.mkdirTree(vdir);
  for (const f of ["points", "faces", "owner", "neighbour", "boundary", "pointProcAddressing", "cellProcAddressing", "faceProcAddressing", "boundaryProcAddressing"]) {
    const p = path.join(destDir, f);
    if (!existsSync(p)) continue;
    m.FS.writeFile(`${vdir}/${f}`, readFileSync(p));
  }
}
const merged = m.readMesh("/verify/case.foam", "openfoam");
if (merged.points.length / 3 !== 12) {
  throw new Error(`expected 12 points, got ${merged.points.length / 3}`);
}
const nHex = merged.cells.filter((c) => c.type === "hexahedron").reduce((n, c) => n + c.data.length / 8, 0);
const nQuad = merged.cells.filter((c) => c.type === "quad").reduce((n, c) => n + c.data.length / 4, 0);
if (nHex !== 2 || nQuad !== 10) {
  throw new Error(`expected 2 hexahedra / 10 quads, got ${nHex} / ${nQuad}`);
}

console.log("wrote openfoam-decomposed/case/ (2 processors, 12 points, 2 hex, 10 boundary quads)");
