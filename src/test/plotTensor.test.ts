import assert from "node:assert/strict";
import test from "node:test";
import { tensorFromTuple, invariantOf, principalValues, validateTensorSpec } from "../parser/plot/tensorInvariants";
import { tensorInvariantsPreset, buildPlotPreset } from "../parser/plot/presets";
import { validatePlotRecipe } from "../parser/plot/recipe";
import { sampleRegion } from "../parser/plot/region";
import { flowDuct } from "./fixtures/shapes";
import type { PlotRegionSource } from "../parser/plot/types";

const close = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);
const T = (xx: number, yy: number, zz: number, xy: number, yz: number, xz: number) => [xx, xy, xz, xy, yy, yz, xz, yz, zz];

test("uniaxial stress: von Mises equals the stress, hydrostatic a third, principal (s,0,0)", () => {
  const t = T(90, 0, 0, 0, 0, 0);
  close(invariantOf(t, "vonMises"), 90); close(invariantOf(t, "hydrostatic"), 30); close(invariantOf(t, "trace"), 90);
  const [a, b, c] = principalValues(t); close(a, 90); close(b, 0); close(c, 0);
  close(invariantOf(t, "maxShear"), 45); close(invariantOf(t, "j2"), 90 * 90 / 3);
});
test("pure shear: von Mises is sqrt(3) tau and the principal values are (tau, 0, -tau)", () => {
  const t = T(0, 0, 0, 7, 0, 0);
  close(invariantOf(t, "vonMises"), Math.sqrt(3) * 7);
  const p = principalValues(t); close(p[0], 7); close(p[1], 0); close(p[2], -7);
  close(invariantOf(t, "maxShear"), 7);
});
test("hydrostatic state has zero deviator", () => {
  const t = T(5, 5, 5, 0, 0, 0);
  close(invariantOf(t, "vonMises"), 0); close(invariantOf(t, "j2"), 0); close(invariantOf(t, "deviatoricNorm"), 0);
});
test("invariants do not change under a rotation of the frame", () => {
  const t = T(120, -30, 45, 20, -15, 8);
  const c = Math.cos(0.7), s = Math.sin(0.7), R = [c, -s, 0, s, c, 0, 0, 0, 1];
  const mul = (A: number[], B: number[]) => { const o = new Array(9).fill(0); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[3 * i + j] += A[3 * i + k] * B[3 * k + j]; return o; };
  const Rt = [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
  const r = mul(mul(R, t), Rt);
  for (const k of ["trace", "vonMises", "j2", "principalMax", "principalMid", "principalMin", "maxShear"] as const) close(invariantOf(t, k), invariantOf(r, k), 1e-7);
});
test("explicit Voigt-style indices equal the full 3x3 for the same tensor; engineering shear halves off-diagonals", () => {
  const full = [10, 4, 2, 4, 20, 6, 2, 6, 30];
  const voigt = [10, 20, 30, 4, 6, 2]; // xx yy zz xy yz xz
  const layout = { xx: 0, yy: 1, zz: 2, xy: 3, yz: 4, xz: 5 };
  assert.deepEqual(tensorFromTuple(voigt, layout), tensorFromTuple(full, "full3x3"));
  const eng = tensorFromTuple([10, 20, 30, 8, 12, 4], layout, "engineering")!;
  assert.deepEqual(eng, tensorFromTuple(voigt, layout));
});
test("a plane layout takes missing zz/yz/xz as zero and bad widths/indices/non-finite are handled", () => {
  assert.deepEqual(tensorFromTuple([1, 2, 3], { xx: 0, yy: 1, xy: 2 }), [1, 3, 0, 3, 2, 0, 0, 0, 0]);
  assert.throws(() => tensorFromTuple([1, 2, 3], "full3x3"), /9-component/);
  assert.throws(() => tensorFromTuple([1, 2, 3], { xx: 0, yy: 1, xy: 5 }), /outside/);
  assert.equal(tensorFromTuple([1, NaN, 3, 4], "full2x2"), undefined);
  assert.match(validateTensorSpec({ layout: { xx: 0, yy: 1 }, invariant: "vonMises" })!, /xy/);
  assert.match(validateTensorSpec({ layout: "full3x3", invariant: "nope" })!, /Unknown/);
});

function ductWithTensor(width: number, fill: (id: number, x: number) => number[]) {
  const model = flowDuct();
  const ids = Array.from(model.nodeIds);
  const values = new Float64Array(ids.length * width);
  ids.forEach((id, i) => values.set(fill(id, model.coords[3 * i]), i * width));
  model.fields.push({ kind: "Nodal", variable: "STRESS", components: width, ids: Int32Array.from(ids), values } as any);
  return model;
}
test("the preset samples a uniform stress state and round-trips as a recipe", () => {
  const model = ductWithTensor(6, () => [90, 0, 0, 0, 0, 0]);
  const r = tensorInvariantsPreset({ path: "d.mdpa", variable: "STRESS", submodelpart: "Outlet", layout: { xx: 0, yy: 1, zz: 2, xy: 3, yz: 4, xz: 5 }, invariants: ["vonMises", "hydrostatic", "principalMax"] });
  assert.equal(r.series.length, 3);
  const vals = r.sources.map(s => sampleRegion(model, { ...(s as PlotRegionSource), scope: "current" }).values[0]!);
  close(vals[0], 90); close(vals[1], 30); close(vals[2], 90);
  assert.deepEqual(validatePlotRecipe(JSON.parse(JSON.stringify(r))), r);
  assert.deepEqual(buildPlotPreset("tensorInvariants", { path: "d.mdpa", variable: "STRESS", submodelpart: "Outlet", layout: "full3x3", invariants: ["trace"] }).series.length, 1);
});
test("sampling refuses a width mismatch and discloses the supplied layout; a gap row is excluded, never zero", () => {
  const model = ductWithTensor(6, () => [1, 2, 3, 4, 5, 6]);
  const bad = tensorInvariantsPreset({ path: "d", variable: "STRESS", submodelpart: "Outlet", layout: "full3x3", invariants: ["trace"] });
  assert.throws(() => sampleRegion(model, { ...(bad.sources[0] as PlotRegionSource), scope: "current" }), /9-component/);
  const ok = tensorInvariantsPreset({ path: "d", variable: "STRESS", submodelpart: "Outlet", layout: { xx: 0, yy: 1, zz: 2, xy: 3, yz: 4, xz: 5 }, invariants: ["j2"] });
  const out = sampleRegion(model, { ...(ok.sources[0] as PlotRegionSource), scope: "current" });
  assert.ok(out.diagnostics.some(d => /caller-supplied layout/.test(d)));
  const first = flowDuct().subModelParts.find(p => p.name === "Outlet")!.nodeIds[0];
  const nan = ductWithTensor(6, id => id === first ? [NaN, 0, 0, 0, 0, 0] : [90, 0, 0, 0, 0, 0]);
  const all = tensorInvariantsPreset({ path: "d", variable: "STRESS", submodelpart: "Outlet", layout: { xx: 0, yy: 1, zz: 2, xy: 3, yz: 4, xz: 5 }, invariants: ["vonMises"], operation: "max" });
  const res = sampleRegion(nan, { ...(all.sources[0] as PlotRegionSource), scope: "current" });
  close(res.values[0]!, 90); assert.ok(res.covered! < res.measure!, "the NaN row must be uncovered, not zero");
});
test("recipe validation rejects a tensor with a component or an unsupported operation, and presets reject misuse", () => {
  const r = tensorInvariantsPreset({ path: "d", variable: "S", submodelpart: "A", layout: "full3x3", invariants: ["trace"] });
  const src = r.sources[0] as any;
  assert.throws(() => validatePlotRecipe({ ...r, sources: [{ ...src, component: 1 }] }), /not both/);
  assert.throws(() => validatePlotRecipe({ ...r, sources: [{ ...src, operation: "flux" }] }), /mean, min and max/);
  assert.throws(() => tensorInvariantsPreset({ path: "d", variable: "S", submodelpart: "A", layout: "full3x3", invariants: [] }), /invariant/);
  assert.throws(() => tensorInvariantsPreset({ path: "d", variable: "S", submodelpart: "", layout: "full3x3", invariants: ["trace"] }), /SubModelPart/);
});
import { plotPreset } from "../mcp/tools";
test("plot_preset builds the tensorInvariants recipe and refuses a missing layout", async () => {
  const out = await plotPreset({ preset: "tensorInvariants", params: { path: "d.mdpa", variable: "STRESS", submodelpart: "Outlet", layout: "full3x3", invariants: ["vonMises", "principalMin"] } }) as any;
  assert.equal((out.recipe ?? out).series.length, 2);
  await assert.rejects(async () => { await plotPreset({ preset: "tensorInvariants", params: { path: "d.mdpa", variable: "S", submodelpart: "A", invariants: ["trace"] } }); });
});
