/**
 * flowBalance.ts — signed boundary flux, area-weighted pressure, imbalance and
 * pressure drop, checked against fields whose exact answer is known.
 *
 * The fixture is a 2 x 1 x 1 duct of two unit hexahedra along +x, with a quad
 * Condition on the x = 0 face (Inlet), the x = 2 face (Outlet) and — for the
 * internal-facet case — the x = 1 mid plane. Every quad is listed in the SAME
 * node order, which gives an area vector pointing +x: INWARD at the inlet and
 * OUTWARD at the outlet, so `winding` and `outward` orientation disagree at the
 * inlet and the tests can tell them apart.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { describeFlowBalance, flowBalance, flowBalanceSeries } from "../parser/flowBalance";
import { flowBalanceToCsv, flowSeriesToCsv } from "../parser/analysisExport";
import { SeriesStep } from "../parser/fieldSeries";
import { parseMdpa } from "../parser/mdpaParser";
import { FieldData, MdpaModel } from "../parser/types";
import { at, flowDuct as duct } from "./fixtures/shapes";

const two = [{ name: "in", part: "Inlet" }, { name: "out", part: "Outlet" }];
const close = (a: number | null, b: number, eps = 1e-9): void => {
  assert.ok(a !== null && Math.abs(a - b) < eps, `expected ${b}, got ${a}`);
};

test("uniform flow: inlet reads negative, outlet positive, net zero", () => {
  const r = flowBalance(duct({ velocity: () => [1, 0, 0] }), { sections: two });
  close(r.sections[0].flux, -1);
  close(r.sections[1].flux, 1);
  close(r.sections[0].area, 1);
  close(r.netFlux, 0);
  close(r.imbalance, 0);
  assert.equal(r.dimension, 3);
  assert.equal(r.sections[0].unoriented, 0);
});

test("reversing the field flips every sign", () => {
  const r = flowBalance(duct({ velocity: () => [-2, 0, 0] }), { sections: two });
  close(r.sections[0].flux, 2);
  close(r.sections[1].flux, -2);
  close(r.netFlux, 0);
});

test("winding orientation follows the file, outward does not", () => {
  const m = duct({ velocity: () => [1, 0, 0] });
  const w = flowBalance(m, { sections: two, orientation: "winding" });
  // The inlet quad is wound with its normal pointing INTO the duct.
  close(w.sections[0].flux, 1);
  close(w.sections[1].flux, 1);
  close(w.netFlux, 2);
  const o = flowBalance(m, { sections: two, orientation: "outward" });
  close(o.sections[0].flux, -1);
});

test("a linear field integrates exactly: u = (x,0,0) gives 2 out and 0 in", () => {
  const r = flowBalance(duct({ velocity: (x) => [x, 0, 0] }), { sections: two });
  close(r.sections[0].flux, 0);
  close(r.sections[1].flux, 2);
  close(r.inflow, 0);
  close(r.outflow, 2);
  close(r.netFlux, 2);
  close(r.imbalance, 1); // net / max(in, out)
});

test("the flux is the normal component, not the vector's magnitude", () => {
  const r = flowBalance(duct({ velocity: () => [0, 3, 0] }), { sections: two });
  close(r.sections[0].flux, 0);
  close(r.sections[1].flux, 0);
  const tilted = flowBalance(duct({ velocity: () => [1, 3, 4] }), { sections: two });
  close(tilted.sections[1].flux, 1);
});

test("zero flow gives an unavailable imbalance with a reason, never infinity", () => {
  const r = flowBalance(duct({ velocity: () => [0, 0, 0] }), { sections: two });
  assert.equal(r.imbalance, null);
  assert.match(r.imbalanceNote, /zero denominator/);
  close(r.netFlux, 0);
});

test("a corner with no velocity is a gap: excluded, reported, never read as zero", () => {
  const r = flowBalance(duct({ velocity: () => [1, 0, 0], dropVelocity: [at(0, 0, 0)] }), { sections: two });
  assert.equal(r.sections[0].flux, null);
  close(r.sections[0].fluxUncoveredArea, 1);
  close(r.sections[1].flux, 1);
  assert.match(r.warnings.join("\n"), /no velocity at a corner/);
  assert.equal(r.imbalance !== null, true); // the covered section still counts
  assert.match(r.imbalanceNote, /1 section has no flux/);
});

test("mass flux exists only with an explicit positive density", () => {
  const m = duct({ velocity: () => [1, 0, 0] });
  assert.equal(flowBalance(m, { sections: two }).sections[1].massFlux, null);
  close(flowBalance(m, { sections: two, density: 998 }).sections[1].massFlux, 998);
  assert.throws(() => flowBalance(m, { sections: two, density: 0 }), /positive/);
  assert.throws(() => flowBalance(m, { sections: two, density: NaN }), /positive/);
});

test("area-weighted pressure and the pressure drop between two named sections", () => {
  const m = duct({ velocity: () => [1, 0, 0], pressure: (x) => 100 - 5 * x });
  const r = flowBalance(m, { sections: two, pressureDrop: { from: "in", to: "out" } });
  close(r.sections[0].meanPressure, 100);
  close(r.sections[1].meanPressure, 90);
  close(r.pressureDrop!.value, 10);
  assert.match(r.pressureDrop!.note!, /no conversion/);
});

test("pressure drop is unavailable, with a reason, without a pressure field or a matching name", () => {
  const noP = flowBalance(duct({ velocity: () => [1, 0, 0] }), { sections: two, pressureDrop: { from: "in", to: "out" } });
  assert.equal(noP.pressureDrop!.value, null);
  assert.match(noP.pressureDrop!.note!, /no pressure/);
  const wrong = flowBalance(duct({ velocity: () => [1, 0, 0], pressure: () => 1 }), { sections: two, pressureDrop: { from: "in", to: "nope" } });
  assert.equal(wrong.pressureDrop!.value, null);
  assert.match(wrong.pressureDrop!.note!, /nope/);
});

test("a default field the mesh lacks is a warning; an explicit one is an error", () => {
  const m = duct({ pressure: () => 1 });
  const r = flowBalance(m, { sections: two });
  assert.equal(r.velocity, null);
  assert.equal(r.sections[0].flux, null);
  assert.equal(r.netFlux, null);
  assert.match(r.warnings.join("\n"), /No flux/);
  assert.throws(() => flowBalance(m, { sections: two, velocity: "U" }), /No Nodal field "U"/);
});

test("field shape errors say what to do", () => {
  const m = duct({ velocity: () => [1, 0, 0], pressure: () => 1 });
  assert.throws(() => flowBalance(m, { sections: two, velocity: "PRESSURE" }), /velocity must be a 2- or 3-component/);
  assert.throws(() => flowBalance(m, { sections: two, pressure: "VELOCITY" }), /pressure must be a scalar/);
  const elemental: FieldData = { kind: "Elemental", variable: "U", components: 3, ids: Int32Array.from([1]), values: Float64Array.from([1, 0, 0]) };
  assert.throws(() => flowBalance({ ...m, fields: [...m.fields, elemental] }, { sections: two, velocity: "U" }), /Elemental field.*Average field/);
});

test("unknown sections, empty specs and duplicate names are refused", () => {
  const m = duct({ velocity: () => [1, 0, 0] });
  assert.throws(() => flowBalance(m, { sections: [{ part: "Nope" }] }), /No SubModelPart "Nope".*Inlet/);
  assert.throws(() => flowBalance(m, { sections: [] }), /at least one section/);
  assert.throws(() => flowBalance(m, { sections: [{ name: "a", part: "Inlet" }, { name: "a", part: "Outlet" }] }), /used twice/);
});

test("overlapping sections are warned about", () => {
  const r = flowBalance(duct({ velocity: () => [1, 0, 0] }), { sections: [{ name: "a", part: "Inlet" }, { name: "b", part: "Inlet" }] });
  assert.match(r.warnings.join("\n"), /share 1 Condition id/);
});

test("an internal facet (shared by two elements) is excluded and reported", () => {
  const r = flowBalance(duct({ velocity: () => [1, 0, 0] }), { sections: [{ name: "mid", part: "Mid" }] });
  assert.equal(r.sections[0].internal, 1);
  assert.equal(r.sections[0].flux, null);
  assert.match(r.warnings.join("\n"), /internal/);
  // Under `winding` no adjacency is consulted, so the same facet integrates.
  close(flowBalance(duct({ velocity: () => [1, 0, 0] }), { sections: [{ name: "mid", part: "Mid" }], orientation: "winding" }).sections[0].flux, 1);
});

test("a condition with no adjacent element cannot be oriented and is counted", () => {
  // Sanity: the untouched mesh orients everything.
  assert.equal(flowBalance(duct({ velocity: () => [1, 0, 0] }), { sections: two }).sections[1].unoriented, 0);
  // A part listing a condition id that no Element borders: an isolated quad.
  const lone = duct({ velocity: () => [1, 0, 0] });
  const b = lone.blocks.find((x) => x.kind === "Conditions")!;
  const isolated = { ...lone, blocks: lone.blocks.map((x) => (x === b ? { ...x, connectivity: Int32Array.from([...x.connectivity.slice(0, 4), at(1, 0, 0), at(1, 1, 0), at(2, 1, 1), at(0, 0, 1), ...x.connectivity.slice(8)]) } : x)) };
  const r = flowBalance(isolated, { sections: [{ name: "out", part: "Outlet" }] });
  assert.equal(r.sections[0].unoriented, 1);
  assert.equal(r.sections[0].flux, null);
  assert.match(r.warnings.join("\n"), /could not be oriented outward/);
});

function square2d(velocityX: number): MdpaModel {
  const s =
    "Begin Properties 1\nEnd Properties\n" +
    "Begin Nodes\n1 0 0 0\n2 1 0 0\n3 1 1 0\n4 0 1 0\nEnd Nodes\n" +
    "Begin Elements Element2D3N\n1 1 1 2 3\n2 1 1 3 4\nEnd Elements\n" +
    // Left edge listed UPWARD (right-hand normal +x, i.e. inward); right edge upward too (+x, outward).
    "Begin Conditions LineCondition2D2N\n10 1 1 4\n11 1 2 3\nEnd Conditions\n" +
    "Begin SubModelPart Left\n Begin SubModelPartNodes\n1\n4\n End SubModelPartNodes\n Begin SubModelPartConditions\n10\n End SubModelPartConditions\nEnd SubModelPart\n" +
    "Begin SubModelPart Right\n Begin SubModelPartNodes\n2\n3\n End SubModelPartNodes\n Begin SubModelPartConditions\n11\n End SubModelPartConditions\nEnd SubModelPart\n" +
    "Begin NodalData VELOCITY\n" + [1, 2, 3, 4].map((id) => `${id} 0 [3] (${velocityX},0,0)`).join("\n") + "\nEnd NodalData\n";
  const r = parseMdpa(s) as unknown as { model?: MdpaModel };
  return (r.model ?? (r as unknown as MdpaModel)) as MdpaModel;
}

test("2D: line conditions give a per-unit-depth flux and say so", () => {
  const r = flowBalance(square2d(1), { sections: [{ name: "l", part: "Left" }, { name: "r", part: "Right" }] });
  assert.equal(r.dimension, 2);
  close(r.sections[0].flux, -1);
  close(r.sections[1].flux, 1);
  close(r.sections[0].area, 1);
  close(r.netFlux, 0);
  assert.match(r.fluxUnit, /per unit depth/);
  assert.match(describeFlowBalance(r), /per unit depth/);
  // Winding follows the file: the left edge was listed pointing inward.
  close(flowBalance(square2d(1), { sections: [{ name: "l", part: "Left" }], orientation: "winding" }).sections[0].flux, 1);
});

test("series: one model at a time, a failing step is recorded and skipped, a gap is blank", async () => {
  const steps: SeriesStep[] = [
    { label: "0.1", frameIndex: 0, load: async () => duct({ velocity: () => [1, 0, 0], pressure: (x) => 10 - x }) },
    { label: "0.2", frameIndex: 1, load: async () => { throw new Error("half-written"); } },
    { label: "0.3", frameIndex: 2, load: async () => duct({ velocity: () => [2, 0, 0], pressure: (x) => 10 - 2 * x }) },
  ];
  const seen: string[] = [];
  const s = await flowBalanceSeries(steps, { sections: two, pressureDrop: { from: "in", to: "out" } }, { onProgress: (_d, _t, l) => seen.push(l) });
  assert.equal(s.cancelled, false);
  assert.equal(s.rows.length, 3);
  assert.equal(s.rows[1].error, "half-written");
  close(s.rows[0].result!.sections[1].flux, 1);
  close(s.rows[2].result!.sections[1].flux, 2);
  close(s.rows[2].result!.pressureDrop!.value, 4);
  const csv = flowSeriesToCsv(s).trim().split("\n");
  assert.equal(csv[0], "step,flux:in,flux:out,net,imbalance,pressure_drop");
  assert.equal(csv[2], "0.2,,,,,"); // the failed step is blank, not zero
  assert.match(csv[3], /^0\.3,-2,2,0,0,4$/);
});

test("series: cancelling returns the steps already done", async () => {
  const ctl = new AbortController();
  const steps: SeriesStep[] = [0, 1, 2].map((i) => ({
    label: String(i),
    frameIndex: i,
    load: async () => {
      if (i === 1) ctl.abort();
      return duct({ velocity: () => [1, 0, 0] });
    },
  }));
  const s = await flowBalanceSeries(steps, { sections: two }, { signal: ctl.signal });
  assert.equal(s.cancelled, true);
  assert.equal(s.rows.length, 2);
});

test("single-balance CSV: blank cells for gaps, net and imbalance rows", () => {
  const r = flowBalance(duct({ velocity: () => [1, 0, 0], dropVelocity: [at(0, 0, 0)] }), { sections: two });
  const lines = flowBalanceToCsv(r).trim().split("\n");
  assert.match(lines[0], /^section,part,area,flux,/);
  assert.match(lines[1], /^in,Inlet,1,,/); // gap → blank flux
  assert.match(lines[2], /^out,Outlet,1,1,/);
  assert.match(lines[3], /^net,/);
  assert.match(lines[4], /^imbalance,/);
});

const stampDims = (m: MdpaModel, variable: string, exponents: number[]): MdpaModel => ({
  ...m,
  fields: m.fields.map((f) => (f.variable === variable ? { ...f, dimensions: { exponents } } : f)),
});

test("pressureDensity converts a kinematic pressure to Pa, nothing else", () => {
  const kin = stampDims(duct({ velocity: () => [1, 0, 0], pressure: (x) => 10 - x }), "PRESSURE", [0, 2, -2, 0, 0, 0, 0]);
  const r = flowBalance(kin, { sections: two, pressureDrop: { from: "in", to: "out" }, pressureDensity: 1000, pressureReference: "gauge" });
  assert.equal(r.pressureUnit, "m²/s²");
  const conv = r.pressureConversion!;
  assert.equal(conv.unit, "Pa");
  assert.equal(conv.density, 1000);
  assert.equal(conv.reference, "gauge");
  close(conv.means.find((x) => x.section === "in")!.value, 10000);
  close(conv.means.find((x) => x.section === "out")!.value, 8000);
  close(conv.drop, 2000);
  // The field-unit numbers are untouched: only the conversion is scaled.
  close(r.sections[0].meanPressure, 10);
  close(r.pressureDrop!.value, 2);
  assert.match(describeFlowBalance(r), /2000.*Pa/);

  // Unknown dimensions: reported unavailable, never rescaled.
  const unknown = flowBalance(duct({ velocity: () => [1, 0, 0], pressure: (x) => 10 - x }), { sections: two, pressureDensity: 1000 });
  assert.equal(unknown.pressureUnit, undefined);
  assert.ok(unknown.pressureConversion!.means.every((x) => x.value === null));
  assert.match(unknown.pressureConversion!.note, /no recorded dimensions/);

  // Already Pa: reported as-is.
  const pa = stampDims(duct({ velocity: () => [1, 0, 0], pressure: (x) => 10 - x }), "PRESSURE", [1, -1, -2, 0, 0, 0, 0]);
  const already = flowBalance(pa, { sections: two, pressureDensity: 1000 });
  assert.equal(already.pressureUnit, "Pa");
  close(already.pressureConversion!.means[0].value, 10);
  assert.match(already.pressureConversion!.note, /already \[Pa\]/);

  // Other dimensions: refused by name.
  const other = stampDims(duct({ velocity: () => [1, 0, 0], pressure: (x) => 10 - x }), "PRESSURE", [1, -3, 0, 0, 0, 0, 0]);
  const refused = flowBalance(other, { sections: two, pressureDensity: 1000 });
  assert.ok(refused.pressureConversion!.means.every((x) => x.value === null));
  assert.match(refused.pressureConversion!.note, /not a kinematic pressure/);

  // Bad densities and references throw; the two densities never mix.
  assert.throws(() => flowBalance(kin, { sections: two, pressureDensity: 0 }), /pressureDensity/);
  assert.throws(() => flowBalance(kin, { sections: two, pressureDensity: -2 }), /pressureDensity/);
  assert.throws(() => flowBalance(kin, { sections: two, pressureDensity: 1000, pressureReference: "vacuum" as never }), /pressureReference/);
  const massOnly = flowBalance(kin, { sections: two, density: 1000 });
  assert.equal(massOnly.pressureConversion, undefined);
});

test("a higher-order facet integrates as its linear skeleton and says so", () => {
  const s =
    "Begin Properties 1\nEnd Properties\n" +
    "Begin Nodes\n1 0 0 0\n2 1 0 0\n3 0 1 0\n4 0 0 1\n5 0.5 0 0\n6 0.5 0.5 0\n7 0 0.5 0\nEnd Nodes\n" +
    "Begin Elements Element3D4N\n1 1 1 2 3 4\nEnd Elements\n" +
    "Begin Conditions SurfaceCondition3D6N\n10 1 1 2 3 5 6 7\nEnd Conditions\n" +
    "Begin SubModelPart Base\n Begin SubModelPartNodes\n1\n2\n3\n End SubModelPartNodes\n Begin SubModelPartConditions\n10\n End SubModelPartConditions\nEnd SubModelPart\n" +
    "Begin NodalData VELOCITY\n" + [1, 2, 3, 4, 5, 6, 7].map((id) => `${id} 0 [3] (0,0,1)`).join("\n") + "\nEnd NodalData\n";
  const r0 = parseMdpa(s) as unknown as { model?: MdpaModel };
  const m = (r0.model ?? (r0 as unknown as MdpaModel)) as MdpaModel;
  const r = flowBalance(m, { sections: [{ name: "base", part: "Base" }] });
  // The bottom face (area 1/2) faces -z while the flow is +z: flux -1/2.
  close(r.sections[0].flux, -0.5);
  assert.match(r.warnings.join("\n"), /linear skeleton/);
});

test("series CSV carries the converted drop only when a conversion was asked for", async () => {
  const kin = (v: number): MdpaModel =>
    stampDims(duct({ velocity: () => [v, 0, 0], pressure: (x) => 10 - x }), "PRESSURE", [0, 2, -2, 0, 0, 0, 0]);
  const steps: SeriesStep[] = [1, 2].map((v) => ({ label: `s${v}`, frameIndex: v - 1, load: async () => kin(v) }));
  const s = await flowBalanceSeries(steps, { sections: two, pressureDrop: { from: "in", to: "out" }, pressureDensity: 2 });
  const csv = flowSeriesToCsv(s).trim().split("\n");
  assert.match(csv[0], /pressure_drop_Pa$/);
  assert.match(csv[1], /4$/); // drop 2 × density 2
});
