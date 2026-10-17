import { test } from "node:test";
import assert from "node:assert/strict";
import { icosphere } from "./fixtures/shapes";
import { planWindTunnel, regionSizeExpr, checkRegion, describeRegion, summarizePlan } from "../problemtype/windTunnel/plan";
import type { RefinementRegion } from "../problemtype/windTunnel/plan";
import { validateSizeExpr } from "../parser/sizeExpr";
import { defaultWindTunnelForm, buildWindTunnelRequest, parseRegions } from "../problemtype/windTunnel/form";

const params = {
  flow: { speed: 10 },
  tunnel: { upstream: 1.5, downstream: 3, side: 2, top: 2, bottom: 2 },
  mesh: { surfaceSize: 0.12, farSize: 1.0, firstHeight: 0.012, growth: 1.3, maxAspect: 10, wakeLength: 2, wakeSize: 0.25, fit: 0.004 },
};

const box: RefinementRegion = { shape: "box", min: [-1, -0.5, 0], max: [3, 0.5, 1], size: 0.25 };
const cone: RefinementRegion = { shape: "cone", start: [0, 0, 0.5], end: [3, 0, 0.5], radiusStart: 0.3, radiusEnd: 0.8, size: 0.2 };
const ellipsoid: RefinementRegion = { shape: "ellipsoid", center: [1, 0, 0.5], radii: [1.5, 0.5, 0.5], size: 0.2, growth: 0.5 };

test("every region shape makes a size law the evaluator accepts", () => {
  for (const r of [box, cone, ellipsoid]) {
    assert.equal(checkRegion(r), undefined, describeRegion(r, 0));
    assert.equal(validateSizeExpr(regionSizeExpr(r, 0.25), ["x", "y", "z"]), undefined, describeRegion(r, 0));
  }
  const plan = planWindTunnel({ ...params, mesh: { ...params.mesh, regions: [box, cone, ellipsoid] } }, icosphere(0.5, 3));
  assert.deepEqual(plan.errors, []);
  assert.equal(validateSizeExpr(plan.sizeExpr, ["d", "x", "y", "z"]), undefined);
});

test("no regions keeps the wake byte-identical; an empty list drops it", () => {
  const legacy = planWindTunnel(params, icosphere(0.5, 3));
  const explicit = planWindTunnel({ ...params, mesh: { ...params.mesh, regions: undefined } }, icosphere(0.5, 3));
  assert.equal(explicit.sizeExpr, legacy.sizeExpr, "undefined regions keeps the wake");
  const none = planWindTunnel({ ...params, mesh: { ...params.mesh, regions: [] } }, icosphere(0.5, 3));
  const noWake = planWindTunnel({ ...params, mesh: { ...params.mesh, wakeLength: 0 } }, icosphere(0.5, 3));
  assert.equal(none.sizeExpr, noWake.sizeExpr, "an empty list replaces the wake with nothing");
  assert.ok(!none.sizeExpr.includes("wake"), "no wake left in the law");
  const wall = planWindTunnel({ ...params, mesh: { ...params.mesh, regions: [box] } }, icosphere(0.5, 3));
  assert.ok(wall.sizeExpr.includes(regionSizeExpr(box, 0.25).slice(0, 20)), "the region law is the cap");
});

test("a bad region is refused by name, not meshed", () => {
  const bad: RefinementRegion[] = [
    { shape: "box", min: [1, 0, 0], max: [0, 1, 1], size: 0.2 },
    { shape: "cone", start: [0, 0, 0], end: [0, 0, 0], radiusStart: 0.2, radiusEnd: 0.3, size: 0.2 },
    { shape: "ellipsoid", center: [0, 0, 0], radii: [1, 0, 1], size: 0.2 },
    { shape: "box", min: [0, 0, 0], max: [1, 1, 1], size: -1 },
    { shape: "nope", min: [0, 0, 0], max: [1, 1, 1], size: 0.2 } as unknown as RefinementRegion,
  ];
  const plan = planWindTunnel({ ...params, mesh: { ...params.mesh, regions: bad } }, icosphere(0.5, 3));
  assert.equal(plan.errors.length, 5, plan.errors.join("; "));
  assert.ok(plan.errors.every((e) => /^regions\[\d\]:/.test(e)), plan.errors.join("; "));
});

test("the wizard parses one region per line and refuses the bad line by number", () => {
  const r = parseRegions("box -1 -0.5 0 3 0.5 1 0.25\ncone 0 0 0.5 3 0 0.5 0.3 0.8 0.2 0.4\n# a comment\n\nellipsoid 1 0 0.5 1.5 0.5 0.5 0.2");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value!.length, 3);
    assert.deepEqual(r.value![0], box);
    assert.equal(r.value![1].growth, 0.4);
    assert.equal(r.value![2].growth, undefined);
  }
  assert.deepEqual(parseRegions(""), { ok: true, value: undefined });
  const bad = parseRegions("box 0 0 0 1 1 1 0.2\nbox 0 0");
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.error, /line 2/);
  const badValues = parseRegions("ellipsoid 1 0 0.5 1.5 0 0.5 0.2");
  assert.equal(badValues.ok, false);
  if (!badValues.ok) assert.match(badValues.error, /line 1: the radii must be above zero/);
});

test("the wizard request carries the regions and the plan summarizes them", () => {
  const form = {
    ...defaultWindTunnelForm(), bodyPath: "body.stl", outputFolder: "/tmp/vwt", regions: "box -1 -0.5 0 3 0.5 1 0.25",
    surfaceSize: "0.12", farSize: "1.0", firstHeight: "0.012", growth: "1.3", maxAspect: "10", wakeLength: "2", wakeSize: "0.25", fit: "0.004",
  };
  const req = buildWindTunnelRequest(form);
  assert.equal(req.ok, true);
  if (req.ok) {
    assert.deepEqual(req.value.mesh!.regions, [box]);
    const plan = planWindTunnel(req.value, icosphere(0.5, 3));
    assert.deepEqual(plan.errors, []);
    const summary = summarizePlan(plan) as unknown as { refinement: string[] };
    assert.deepEqual(summary.refinement, [describeRegion(box, 0)]);
  }
  const legacy = planWindTunnel(params, icosphere(0.5, 3));
  const summary = summarizePlan(legacy) as unknown as { refinement: string[] };
  assert.equal(summary.refinement.length, 1);
  assert.match(summary.refinement[0], /wake/);
});
