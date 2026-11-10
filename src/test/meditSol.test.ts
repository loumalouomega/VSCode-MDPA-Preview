import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseMeditSol, meditSolCompanionNames, meditMeshForSolNames } from "../parser/meditSol";
import { parseMeshFile } from "../parser/meshFileParser";

const MESH = `MeshVersionFormatted 2
Dimension 3
Vertices
4
0 0 0 1
1 0 0 1
0 1 0 1
0 0 1 1
Tetrahedra
1
1 2 3 4 1
End
`;
const sol = (n: number) => `MeshVersionFormatted 2
Dimension 3
SolAtVertices
${n}
2 1 2
0.5 1 2 3
0.6 4 5 6
0.7 7 8 9
0.8 10 11 12
End
`;

test("companion names pair .mesh with .sol and back", () => {
  assert.deepStrictEqual(meditSolCompanionNames("a.mesh"), ["a.sol", "a.solb"]);
  assert.deepStrictEqual(meditSolCompanionNames("a.meshb"), ["a.solb", "a.sol"]);
  assert.deepStrictEqual(meditMeshForSolNames("a.sol"), ["a.mesh", "a.meshb"]);
  assert.deepStrictEqual(meditSolCompanionNames("a.vtu"), []);
});

test("parseMeditSol reads a scalar and a vector field in vertex order", () => {
  const r = parseMeditSol(sol(4), [10, 11, 12, 13]);
  assert.strictEqual(r.fields.length, 2);
  assert.strictEqual(r.fields[0].variable, "SOL_1");
  assert.deepStrictEqual(Array.from(r.fields[0].ids), [10, 11, 12, 13]);
  assert.deepStrictEqual(Array.from(r.fields[0].values), [0.5, 0.6, 0.7, 0.8]);
  assert.strictEqual(r.fields[1].components, 3);
  assert.deepStrictEqual(Array.from(r.fields[1].values.slice(3, 6)), [4, 5, 6]);
});

test("a vertex-count mismatch yields no fields and a named diagnostic", () => {
  const r = parseMeditSol(sol(4), [1, 2, 3]);
  assert.strictEqual(r.fields.length, 0);
  assert.match(r.diagnostics[0].message, /declares 4 vertices but the mesh has 3/);
});

test("binary data is refused by name", () => {
  const r = parseMeditSol("Medit\u0000\u0001", [1]);
  assert.strictEqual(r.fields.length, 0);
  assert.match(r.diagnostics[0].message, /binary/);
});

test("a .mesh opened with a sibling .sol carries the fields; a mismatch opens the mesh alone", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "medit-sol-"));
  fs.writeFileSync(path.join(dir, "a.mesh"), MESH);
  fs.writeFileSync(path.join(dir, "a.sol"), sol(4));
  const ok = await parseMeshFile(path.join(dir, "a.mesh"));
  assert.ok(ok.fields.some((f) => f.variable === "SOL_1" && f.kind === "Nodal"));
  const viaSol = await parseMeshFile(path.join(dir, "a.sol"));
  assert.ok(viaSol.fields.some((f) => f.variable === "SOL_2"));

  fs.writeFileSync(path.join(dir, "a.sol"), sol(3));
  const bad = await parseMeshFile(path.join(dir, "a.mesh"));
  assert.strictEqual(bad.fields.filter((f) => f.variable.startsWith("SOL")).length, 0);
  assert.ok(bad.diagnostics.some((d) => /ignored/.test(d.message)));
});

test("a lone .sol explains the missing mesh instead of opening empty", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "medit-sol-"));
  fs.writeFileSync(path.join(dir, "b.sol"), sol(4));
  await assert.rejects(() => parseMeshFile(path.join(dir, "b.sol")), /no geometry/);
});
