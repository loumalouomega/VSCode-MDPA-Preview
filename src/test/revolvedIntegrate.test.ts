import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseMdpa } from "../parser/mdpaParser";
import { integrateFields } from "../parser/fieldIntegrate";
import { meshFieldIntegrate } from "../mcp/tools";
import { nodalRevolvedWeights } from "../parser/revolvedIntegrate";

const R = 2;
const H = 3;
function mdpa(z4: number): string {
  return `Begin Properties 0
End Properties
Begin Nodes
1 0 0 0
2 ${R} 0 0
3 ${R} ${H / 2} 0
4 0 ${H / 2} ${z4}
5 ${R} ${H} 0
6 0 ${H} 0
End Nodes
Begin Elements Element2D4N
1 0 1 2 3 4
2 0 4 3 5 6
End Elements
Begin ElementalData DENSITY
1 1.0
2 1.0
End ElementalData
`;
}

test("revolving a rectangle about y integrates field 1 to pi R^2 H", async () => {
  const model = parseMdpa(mdpa(0));
  const r = await integrateFields(model, ["DENSITY"], [], { revolveAbout: "y" });
  assert.equal(r.length, 1);
  assert.equal(r[0].revolvedAbout, "y");
  assert.ok(Math.abs(r[0].domain.total[0] - Math.PI * R * R * H) < 1e-9, String(r[0].domain.total[0]));
  assert.ok(Math.abs(r[0].domain.mean[0] - 1) < 1e-12);
  assert.ok(r[0].regions.some((g) => g.name === "Element2D4N"));
});

test("revolving about x uses r = y", async () => {
  const model = parseMdpa(mdpa(0));
  const r = await integrateFields(model, ["DENSITY"], [], { revolveAbout: "x" });
  assert.ok(Math.abs(r[0].domain.total[0] - Math.PI * H * H * R) < 1e-9);
});

test("the axis is explicit: other axes and 3D meshes are refused by name", async () => {
  await assert.rejects(
    () => integrateFields(parseMdpa(mdpa(0)), [], [], { revolveAbout: "z" }),
    /revolveAbout must be "x" or "y"/
  );
  await assert.rejects(
    () => integrateFields(parseMdpa(mdpa(1)), [], [], { revolveAbout: "y" }),
    /3D/
  );
});

test("mesh_field_integrate labels revolved and plane results", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "revolve-"));
  const p = path.join(dir, "rect.mdpa");
  fs.writeFileSync(p, mdpa(0));
  const rev = (await meshFieldIntegrate({ path: p, variables: ["DENSITY"], revolveAbout: "y" })) as {
    frame: string;
    integrals: { revolvedAbout: string; domain: { total: number[] } }[];
  };
  assert.match(rev.frame, /revolved about y/);
  assert.ok(Math.abs(rev.integrals[0].domain.total[0] - Math.PI * R * R * H) < 1e-9);
  const plain = (await meshFieldIntegrate({ path: p, variables: ["DENSITY"] })) as { frame: string; integrals: { domain: { total: number[] } }[] };
  assert.match(plain.frame, /NOT revolved/);
  assert.ok(Math.abs(plain.integrals[0].domain.total[0] - R * H) < 1e-9);
});

test("the Field integrals panel's request carries the axis through runMeshAnalysis", async () => {
  const { runMeshAnalysis } = await import("../meshAnalysis");
  const model = parseMdpa(mdpa(0));
  const reply = (await runMeshAnalysis({ type: "meshAnalysis", kind: "integrate", variables: ["DENSITY"], revolveAbout: "y" }, model)) as {
    integrals: { revolvedAbout?: string; domain: { total: number[] } }[];
    revolveAbout?: string;
  };
  assert.equal(reply.revolveAbout, "y");
  assert.ok(Math.abs(reply.integrals[0].domain.total[0] - Math.PI * R * R * H) < 1e-9);
  const plane = (await runMeshAnalysis({ type: "meshAnalysis", kind: "integrate", variables: ["DENSITY"] }, model)) as { integrals: { domain: { total: number[] } }[] };
  assert.ok(Math.abs(plane.integrals[0].domain.total[0] - R * H) < 1e-9, "no axis: the plane integral");
});

function withNodal(name: string, rows: string[]): string {
  return mdpa(0) + `Begin NodalData ${name}\n${rows.join("\n")}\nEnd NodalData\n`;
}

test("a Nodal field revolves with lumped weights: phi = 1 gives pi R^2 H, phi = r gives 2 pi R^3 H / 3 (item 44)", async () => {
  const ones = parseMdpa(withNodal("PHI", [1, 2, 3, 4, 5, 6].map((i) => `${i} 0 1.0`)));
  const a = await integrateFields(ones, ["PHI"], [], { revolveAbout: "y" });
  assert.equal(a[0].revolvedAbout, "y");
  assert.ok(Math.abs(a[0].domain.total[0] - Math.PI * R * R * H) < 1e-9, String(a[0].domain.total[0]));
  assert.ok(Math.abs(a[0].domain.mean[0] - 1) < 1e-12);
  // phi = x = r about y: nodes 1,4,6 at x = 0, nodes 2,3,5 at x = R.
  const xs = parseMdpa(withNodal("PHI", [[1, 0], [2, R], [3, R], [4, 0], [5, R], [6, 0]].map(([i, v]) => `${i} 0 ${v}`)));
  const b = await integrateFields(xs, ["PHI"], [], { revolveAbout: "y" });
  assert.ok(Math.abs(b[0].domain.total[0] - (2 * Math.PI * R ** 3 * H) / 3) < 1e-9, String(b[0].domain.total[0]));
  assert.ok(b[0].regions.some((g) => g.name === "Element2D4N"));
});

test("nodalRevolvedWeights: axis nodes stay positive and the weights sum to the revolved measure", () => {
  // Triangle (0,0)-(1,0)-(0,1) about y: r = 0, 1, 0; area 1/2.
  const w = nodalRevolvedWeights([0, 1, 0], 0.5);
  assert.ok(w[0] > 0 && w[2] > 0, "axis nodes keep a positive weight");
  assert.ok(Math.abs(w[0] + w[1] + w[2] - Math.PI / 3) < 1e-12, "sums to 2 pi * integral(r dA) = pi/3");
  // Line from the axis out to r = l: 2 pi l L / 6 and 2 pi l L / 3.
  const l = nodalRevolvedWeights([0, 2], 2);
  assert.ok(Math.abs(l[0] - (2 * Math.PI * 2 * 2) / 6) < 1e-12);
  assert.ok(Math.abs(l[1] - (2 * Math.PI * 2 * 4) / 6) < 1e-12);
});

test("a Nodal gap is excluded from numerator and measure, never read as 0", async () => {
  const m = parseMdpa(`Begin Nodes
1 0 0 0
2 1 0 0
3 0 1 0
End Nodes
Begin Elements Element2D3N
1 0 1 2 3
End Elements
Begin NodalData PHI
2 0 1.0
End NodalData
`);
  const r = await integrateFields(m, ["PHI"], [], { revolveAbout: "y" });
  assert.ok(Math.abs(r[0].domain.total[0] - Math.PI / 6) < 1e-12);
  assert.ok(Math.abs(r[0].domain.measure[0] - Math.PI / 6) < 1e-12);
  assert.ok(Math.abs(r[0].domain.mean[0] - 1) < 1e-12);
});

test("a Nodal field is still refused without revolveAbout, pointing at Average field", async () => {
  const m = parseMdpa(withNodal("PHI", ["1 0 1.0"]));
  await assert.rejects(() => integrateFields(m, ["PHI"], []), /Average field|nodalToElemental|averageField/i);
});

test("mesh_field_integrate accepts a Nodal field when revolveAbout is given (item 44)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "revolve-nodal-"));
  const p = path.join(dir, "rect.mdpa");
  fs.writeFileSync(p, withNodal("PHI", [1, 2, 3, 4, 5, 6].map((i) => `${i} 0 1.0`)));
  const rev = (await meshFieldIntegrate({ path: p, variables: ["PHI"], revolveAbout: "y" })) as {
    integrals: { revolvedAbout: string; domain: { total: number[]; mean: number[] } }[];
  };
  assert.ok(Math.abs(rev.integrals[0].domain.total[0] - Math.PI * R * R * H) < 1e-9);
  assert.ok(Math.abs(rev.integrals[0].domain.mean[0] - 1) < 1e-12);
});
