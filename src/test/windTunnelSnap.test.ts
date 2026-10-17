import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseMdpa } from "../parser/mdpaParser";
import type { MdpaModel } from "../parser/types";
import { planWindTunnel } from "../problemtype/windTunnel/plan";
import { runWindTunnel } from "../problemtype/windTunnel/run";

/** A sharp L x W x H box surface, outward wound, as the snap's worst case. */
export function boxSurface(L: number, W: number, H: number): MdpaModel {
  const v: number[][] = [
    [0, 0, 0], [L, 0, 0], [L, W, 0], [0, W, 0],
    [0, 0, H], [L, 0, H], [L, W, H], [0, W, H],
  ];
  const f = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5],
    [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2],
  ];
  let s = "Begin Nodes\n" + v.map((p, i) => `${i + 1} ${p.join(" ")}`).join("\n") + "\nEnd Nodes\n";
  s += "Begin Conditions SurfaceCondition3D3N\n" + f.map((t, i) => `${i + 1} 0 ${t.map((x) => x + 1).join(" ")}`).join("\n") + "\nEnd Conditions\n";
  const r = parseMdpa(s) as unknown as { model?: MdpaModel };
  return (r.model ?? (r as unknown as MdpaModel)) as MdpaModel;
}

const params = {
  flow: { speed: 10 },
  tunnel: { upstream: 1.5, downstream: 3, side: 2, top: 2, bottom: 2 },
  mesh: { surfaceSize: 0.2, carveFactor: 0.4, farSize: 1.5, firstHeight: 0.02, growth: 1.3, maxAspect: 10, wakeLength: 1, wakeSize: 0.5, fit: 0.004 },
};

test("a sharp box plans a snap step, and opting out removes it", () => {
  const plan = planWindTunnel(params, boxSurface(2, 1, 1));
  assert.deepEqual(plan.errors, []);
  assert.ok(plan.body.closed, `box problems: ${plan.body.problems.join("; ")}`);
  assert.ok(plan.steps.some((s) => s.id === "snap"), "snap step planned");
  const off = planWindTunnel({ ...params, mesh: { ...params.mesh, snap: false } }, boxSurface(2, 1, 1));
  assert.ok(!off.steps.some((s) => s.id === "snap"), "snap:false drops the step");
});

test("the snap pulls the carved wall onto a sharp box below 0.3% of L with no inverted cells", async () => {
  const plan = planWindTunnel(params, boxSurface(2, 1, 1));
  assert.deepEqual(plan.errors, []);
  const r = await runWindTunnel(plan, { folder: fs.mkdtempSync(path.join(os.tmpdir(), "vwt-snap-")), stem: "box" });
  assert.equal(r.report.check.inverted, 0, "no inverted tetrahedra");
  const snap = r.report.snap;
  assert.ok(snap, "the report carries the snap");
  assert.equal(snap.applied, true, "a clean sub-step was kept");
  assert.ok(snap.after < 0.003, `after ${snap.after} of L (before ${snap.before})`);
  assert.ok(snap.after <= snap.before, "the snap never makes the fit worse");
  assert.ok(!r.model.subModelParts.some((p) => p.name === "SnapFarField"), "the pinning scaffold is removed");
  assert.ok(!r.model.fields.some((f) => f.variable === "SNAP_DISPLACEMENT" || f.variable === "SHRINKWRAP_DISTANCE"), "the working fields are removed");
  // The recipe shows the before and after, and the log tells the fraction.
  const recipe = JSON.parse(fs.readFileSync(r.files.recipe, "utf8"));
  assert.ok(recipe.report.snap.after < 0.003);
  assert.ok(r.report.log.some((l: string) => l.startsWith("Snap: wall gap")), "the log reports before and after");
});
