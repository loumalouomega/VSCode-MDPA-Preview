import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseMdpa } from "../parser/mdpaParser";
import { integrateFields } from "../parser/fieldIntegrate";
import { meshFieldIntegrate } from "../mcp/tools";

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
