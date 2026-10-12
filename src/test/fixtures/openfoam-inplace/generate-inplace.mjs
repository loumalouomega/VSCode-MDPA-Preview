// Regenerates src/test/fixtures/openfoam-inplace/case — the fixture for roadmap
// item 13 (in-place save). Run after `npm run compile && npm run build:tests`:
//
//   node src/test/fixtures/openfoam-inplace/generate-inplace.mjs
//
// A single-region case of two hexahedra stacked along x. The polyMesh comes from
// this extension's own writer (with `bottom`/`top` as a CYCLIC pair, carrying
// neighbourPatch/transform/inGroups, and `walls` as a wall), then the rest of a
// real case is added by hand: three time directories (0, 0.5, 1) with uniform
// and nonuniform fields, system/controlDict, constant/transportProperties and a
// faceZones file. The script verifies what it wrote before finishing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../..");
const require = createRequire(import.meta.url);
const { parseMdpa } = require(path.join(root, "out/parser/mdpaParser"));
const { writeMeshFileAsync } = require(path.join(root, "out/parser/writers/meshWriter"));
const { parseMeshFile } = require(path.join(root, "out/parser/meshFileParser"));

const n = (x, y, z) => 1 + x + 3 * y + 6 * z;
const nodes = [];
for (let z = 0; z < 2; z++) for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) nodes.push(` ${n(x, y, z)} ${x} ${y} ${z}`);
const hex = (x0) => [n(x0, 0, 0), n(x0 + 1, 0, 0), n(x0 + 1, 1, 0), n(x0, 1, 0), n(x0, 0, 1), n(x0 + 1, 0, 1), n(x0 + 1, 1, 1), n(x0, 1, 1)];
const quads = [];
const part = {};
const addQuad = (name, q) => { quads.push(q); (part[name] ??= []).push(quads.length); };
addQuad("inlet", [n(0, 0, 0), n(0, 1, 0), n(0, 1, 1), n(0, 0, 1)]);
addQuad("outlet", [n(2, 0, 0), n(2, 0, 1), n(2, 1, 1), n(2, 1, 0)]);
for (const x0 of [0, 1]) {
  addQuad("bottom", [n(x0, 0, 0), n(x0 + 1, 0, 0), n(x0 + 1, 0, 1), n(x0, 0, 1)]);
  addQuad("top", [n(x0, 1, 0), n(x0, 1, 1), n(x0 + 1, 1, 1), n(x0 + 1, 1, 0)]);
  addQuad("walls", [n(x0, 0, 0), n(x0, 1, 0), n(x0 + 1, 1, 0), n(x0 + 1, 0, 0)]);
  addQuad("walls", [n(x0, 0, 1), n(x0 + 1, 0, 1), n(x0 + 1, 1, 1), n(x0, 1, 1)]);
}
const lines = ["Begin Nodes", ...nodes, "End Nodes", "Begin Elements Element3D8N",
  ` 1 0 ${hex(0).join(" ")}`, ` 2 0 ${hex(1).join(" ")}`, "End Elements", "Begin Conditions SurfaceCondition3D4N",
  ...quads.map((q, i) => ` ${i + 1} 0 ${q.join(" ")}`), "End Conditions"];
for (const [name, ids] of Object.entries(part)) {
  lines.push(`Begin SubModelPart ${name}`, "Begin SubModelPartConditions", ...ids.map((i) => ` ${i}`), "End SubModelPartConditions", "End SubModelPart");
}
const model = parseMdpa(lines.join("\n") + "\n");
model.source = {
  format: "openfoam",
  openfoam: {
    patchTypes: { bottom: "cyclic", top: "cyclic", walls: "wall" },
    patchDictionaries: {
      bottom: "inGroups List<word> 1(cyclic);\nneighbourPatch top;\ntransform translational;\nseparationVector (0 1 0);",
      top: "inGroups List<word> 1(cyclic);\nneighbourPatch bottom;\ntransform translational;\nseparationVector (0 -1 0);",
    },
  },
};

const out = path.join(here, "case");
fs.rmSync(out, { recursive: true, force: true });
const { data, companions } = await writeMeshFileAsync(model, ".foam", { name: "case" });
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "case.foam"), data);
for (const c of companions) {
  if (c.name.startsWith("0/")) continue; // fields are written by hand below
  const p = path.join(out, c.name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, c.data);
}

const header = (cls, obj) => `FoamFile\n{\n    version     2.0;\n    format      ascii;\n    class       ${cls};\n    object      ${obj};\n}\n\n`;
const bnd = `boundaryField\n{\n    inlet { type fixedValue; value uniform 5; }\n    outlet { type zeroGradient; }\n    bottom { type cyclic; }\n    top { type cyclic; }\n    walls { type zeroGradient; }\n}\n`;
const field = (time, name, cls, dims, internal) => {
  const dir = path.join(out, time);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), header(cls, name) + `dimensions      [${dims}];\n\ninternalField   ${internal};\n\n${bnd}`);
};
field("0", "p", "volScalarField", "0 2 -2 0 0 0 0", "nonuniform List<scalar>\n2\n(\n1\n2\n)");
field("0", "U", "volVectorField", "0 1 -1 0 0 0 0", "uniform (1 0 0)");
field("0", "T", "volScalarField", "0 0 0 1 0 0 0", "uniform 300");
field("0.5", "p", "volScalarField", "0 2 -2 0 0 0 0", "nonuniform List<scalar>\n2\n(\n3\n4\n)");
field("1", "p", "volScalarField", "0 2 -2 0 0 0 0", "nonuniform List<scalar>\n2\n(\n5\n6\n)");
fs.mkdirSync(path.join(out, "system"), { recursive: true });
fs.writeFileSync(path.join(out, "system/controlDict"), header("dictionary", "controlDict") + "application icoFoam;\nstartTime 0;\nendTime 1;\ndeltaT 0.5;\n");
fs.writeFileSync(path.join(out, "constant/transportProperties"), header("dictionary", "transportProperties") + "nu [0 2 -1 0 0 0 0] 0.01;\n");

fs.writeFileSync(path.join(out, "constant/polyMesh/faceZones"), header("regIOobject", "faceZones") + "1\n(\ninternalFace\n{\n    type faceZone;\n    faceLabels List<label> 1(0);\n    flipMap List<bool> 1(0);\n}\n)\n");

// ---- verify what was written ---------------------------------------------------
const boundary = fs.readFileSync(path.join(out, "constant/polyMesh/boundary"), "utf8");
for (const needle of ["neighbourPatch top;", "neighbourPatch bottom;", "type            cyclic;", "type            wall;"]) {
  if (!boundary.includes(needle)) throw new Error(`boundary is missing "${needle}"`);
}
const read = await parseMeshFile(path.join(out, "case.foam"));
if (read.nodeCount !== 12) throw new Error(`expected 12 nodes, read ${read.nodeCount}`);
const names = read.subModelParts.map((p) => p.name).sort();
for (const want of ["bottom", "inlet", "outlet", "top", "walls"]) if (!names.includes(want)) throw new Error(`patch ${want} not read back (${names})`);
console.log("wrote", out, "- patches:", names.join(", "));
