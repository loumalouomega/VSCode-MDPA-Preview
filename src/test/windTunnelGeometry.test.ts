import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { icosphere } from "./fixtures/shapes";
import { buildTunnelBackground, gradedAxis } from "../problemtype/windTunnel/backgroundMesh";
import { bodyMetrics, placeBody } from "../problemtype/windTunnel/body";
import { tunnelDomain } from "../problemtype/windTunnel/domain";
import { AIR_20C, MMG_CELL_K, MMG_CELL_P, boundaryLayerEstimate, estimateMesh, yPlusAt } from "../problemtype/windTunnel/estimate";
import { refinementRegionVolume } from "../problemtype/windTunnel/regions";

test("a graded axis ends exactly on its limits, holds the fine size in the focus and never exceeds the coarse size", () => {
  const xs = gradedAxis({ min: -3, max: 8, focusMin: -0.7, focusMax: 1.5, fine: 0.1, coarse: 1.2, growth: 1.25 });
  assert.equal(xs[0], -3);
  assert.equal(xs[xs.length - 1], 8);
  for (let i = 1; i < xs.length; i++) {
    assert.ok(xs[i] > xs[i - 1]);
    assert.ok(xs[i] - xs[i - 1] <= 1.2 + 1e-9);
  }
  const inFocus = xs.filter((x) => x >= -0.7 - 1e-9 && x <= 1.5 + 1e-9);
  for (let i = 1; i < inFocus.length; i++) assert.ok(Math.abs(inFocus[i] - inFocus[i - 1] - 0.1) < 0.011);
});

test("the background box is conforming, positively oriented and filled by exactly its volume", () => {
  const xs = [0, 1, 3];
  const ys = [0, 2];
  const zs = [0, 0.5, 1];
  const m = buildTunnelBackground(xs, ys, zs);
  const tets = m.blocks[0];
  assert.equal(tets.count, 6 * 2 * 1 * 2);
  const at = (id: number, a: number) => m.coords[(id - 1) * 3 + a];
  let vol = 0;
  const faces = new Map<string, number>();
  for (let c = 0; c < tets.count; c++) {
    const n = [0, 1, 2, 3].map((k) => tets.connectivity[c * 4 + k]);
    const u = [1, 2, 3].map((k) => [0, 1, 2].map((a) => at(n[k], a) - at(n[0], a)));
    const v6 = u[0][0] * (u[1][1] * u[2][2] - u[1][2] * u[2][1]) - u[0][1] * (u[1][0] * u[2][2] - u[1][2] * u[2][0]) + u[0][2] * (u[1][0] * u[2][1] - u[1][1] * u[2][0]);
    assert.ok(v6 > 0, "positive volume");
    vol += v6 / 6;
    for (const f of [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]]) {
      const key = f.map((i) => n[i]).sort((a, b) => a - b).join("_");
      faces.set(key, (faces.get(key) ?? 0) + 1);
    }
  }
  assert.ok(Math.abs(vol - 3 * 2 * 1) < 1e-9);
  const boundary = [...faces.values()].filter((c) => c === 1).length;
  assert.ok([...faces.values()].every((c) => c <= 2), "no face shared by three tetrahedra");
  assert.equal(boundary, m.blocks[1].count, "one condition per boundary face");
  // Outward normals: the inlet's triangles point to -x.
  const inlet = m.subModelParts.find((p) => p.name === "Inlet")!;
  const cond = m.blocks[1];
  for (const id of inlet.conditionIds) {
    const c = cond.entityIds.indexOf(id);
    const [a, b, d] = [0, 1, 2].map((k) => cond.connectivity[c * 3 + k]);
    const e1 = [0, 1, 2].map((t) => at(b, t) - at(a, t));
    const e2 = [0, 1, 2].map((t) => at(d, t) - at(a, t));
    assert.ok(e1[1] * e2[2] - e1[2] * e2[1] < 0, "inlet normal points out (-x)");
  }
  assert.deepEqual(m.subModelParts.map((p) => p.name), ["Fluid", "Inlet", "Outlet", "SideLow", "SideHigh", "Floor", "Ceiling"]);
});

test("body metrics of a sphere match the analytic values", () => {
  const b = bodyMetrics(icosphere(0.5, 4));
  assert.ok(Math.abs(b.surfaceArea - Math.PI) / Math.PI < 5e-3);
  assert.ok(Math.abs(b.signedVolume - (4 / 3) * Math.PI * 0.125) / ((4 / 3) * Math.PI * 0.125) < 1e-2);
  assert.ok(Math.abs(b.frontalArea - Math.PI * 0.25) / (Math.PI * 0.25) < 2e-2);
  assert.ok(b.closed);
  assert.ok(Math.abs(b.size[0] - 1) < 2e-2);
});

test("an inward-wound or open body is reported, not repaired silently", () => {
  assert.ok(bodyMetrics(icosphere(0.5, 3, true)).signedVolume < 0);
  const open = bodyMetrics(icosphere(0.5, 3, false, (p) => p[2] < 0.3));
  assert.equal(open.closed, false);
  assert.ok(open.problems.some((p) => /open edge/.test(p)));
});

test("placing a body scales it, turns it and centres it", () => {
  const m = placeBody(icosphere(500, 3), { scale: 0.001, rotation: [0, 0, 90] });
  const b = bodyMetrics(m);
  assert.ok(Math.abs(b.size[0] - 1) < 2e-2);
  assert.ok(Math.abs(b.min[0] + b.max[0]) < 1e-6 && Math.abs(b.min[2] + b.max[2]) < 1e-6);
});

test("the tunnel extends by multiples of the body and warns on blockage", () => {
  const b = bodyMetrics(icosphere(0.5, 4));
  const d = tunnelDomain(b, { upstream: 3, downstream: 6, side: 4, top: 5, bottom: 5 });
  assert.ok(Math.abs(d.min[0] - (b.min[0] - 3 * b.size[0])) < 1e-9);
  assert.ok(Math.abs(d.max[0] - (b.max[0] + 6 * b.size[0])) < 1e-9);
  assert.equal(d.warnings.length, 0);
  const tight = tunnelDomain(b, { side: 0.3, top: 0.3, bottom: 0.3 });
  assert.ok(tight.blockage > 0.05);
  assert.ok(tight.warnings.some((w) => /Blockage/.test(w)));
  const half = tunnelDomain(b, { halfModel: true });
  assert.equal(half.min[1], 0);
  assert.throws(() => tunnelDomain(b, { upstream: 0 }), /upstream/);
});

test("a turbulent plate gets a first height that round-trips to the target y+, a laminar one a layer stack", () => {
  const flow = { speed: 40, ...AIR_20C };
  const t = boundaryLayerEstimate(flow, 4.5, 30);
  assert.equal(t.regime, "turbulent");
  assert.ok(Math.abs(yPlusAt(flow, 4.5, t.firstHeight) - 30) < 1e-6 * 30 + 0.5, "y+ round trip (within the friction-law constant)");
  assert.ok(t.firstHeight > 1e-4 && t.firstHeight < 1e-2);
  assert.ok(t.layers > 5);
  const slow = boundaryLayerEstimate({ speed: 0.5, ...AIR_20C }, 0.1, 1);
  assert.equal(slow.regime, "laminar");
  assert.ok(slow.firstHeight < slow.thickness);
  assert.throws(() => boundaryLayerEstimate({ speed: 0, ...AIR_20C }, 1, 1), /above zero/);
});

test("the cell estimate grows when the first height shrinks and stays finite and bounded by the domain", () => {
  const base = { volume: 274, surfaceArea: Math.PI, wall: { firstHeight: 0.01, growth: 1.2, tangentialSize: 0.05, hmax: 1.2, maxAspect: 20 } };
  const coarse = estimateMesh(base);
  const fine = estimateMesh({ ...base, wall: { ...base.wall, firstHeight: 0.002, tangentialSize: 0.02 } });
  assert.ok(fine.expectedTetrahedra > coarse.expectedTetrahedra);
  assert.ok(Number.isFinite(coarse.expectedTetrahedra) && coarse.expectedTetrahedra > 1000);
  assert.ok(coarse.notes.length > 0);
});

test("a refinement region adds its own volume at its own size (roadmap item 21)", () => {
  const base = { volume: 274, surfaceArea: Math.PI, wall: { firstHeight: 0.01, growth: 1.2, tangentialSize: 0.05, hmax: 1.2, maxAspect: 20 } };
  const plain = estimateMesh(base);
  const regioned = estimateMesh({ ...base, regions: [{ volume: 13.52, size: 0.15 }] });
  assert.ok(regioned.expectedTetrahedra > plain.expectedTetrahedra);
  assert.ok(regioned.notes.some((n) => /refinement region/i.test(n)));
  const smaller = estimateMesh({ ...base, regions: [{ volume: 13.52, size: 0.06 }] });
  assert.ok(smaller.expectedTetrahedra > regioned.expectedTetrahedra);
  assert.ok(estimateMesh({ ...base, regions: [{ volume: -1, size: 0.15 }] }).expectedTetrahedra === plain.expectedTetrahedra);
});

test("refinement region volumes are the box product, the ellipsoid and the frustum (roadmap item 21)", () => {
  assert.equal(refinementRegionVolume({ shape: "box", min: [1.2, -0.8, -0.8], max: [3.2, 1.8, 1.8], size: 0.15 }), 2 * 2.6 * 2.6);
  const ball = refinementRegionVolume({ shape: "ellipsoid", center: [0, 0, 0], radii: [1, 2, 3], size: 0.1 });
  assert.ok(Math.abs(ball - (4 / 3) * Math.PI * 6) < 1e-9);
  const cone = refinementRegionVolume({ shape: "cone", start: [0, 0, 0], end: [0, 0, 2], radiusStart: 1, radiusEnd: 1, size: 0.1 });
  assert.ok(Math.abs(cone - Math.PI * 2) < 1e-9);
  assert.equal(refinementRegionVolume({ shape: "box", min: [0, 0, 0], max: [0, 0, 0], size: 0.1 }), 0);
});

test("the fitted estimate stays within a factor of two of the ten worker runs (roadmap item 21)", () => {
  const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../src/test/fixtures/windTunnel/estimate-refit-2026-10-20.json"), "utf8"));
  const measured = fixture.results.filter((r: { measured?: unknown }) => r.measured);
  assert.ok(measured.length >= 10);
  for (const row of measured) {
    const est = estimateMesh({
      volume: 273,
      surfaceArea: Math.PI,
      wall: { firstHeight: 0.01, growth: 1.2, tangentialSize: 0.05, hmax: 1.2, maxAspect: 20 },
    });
    assert.ok(Number.isFinite(est.expectedTetrahedra));
  }
  // The calibration itself: the power law through the fixture's ideal counts
  // lands within a factor of two of every measured run (see estimate.ts).
  const TET = Math.SQRT2 / 12;
  const sizes: Record<string, number> = { "box-s0.20-region": 0.15, "box-s0.10-region": 0.08, "sphere-s0.07-region": 0.06 };
  for (const row of measured as { id: string; planned: { ideal: number }; measured: { tetrahedra: number } }[]) {
    const size = sizes[row.id];
    const ideal = row.planned.ideal + (size ? 13.52 / (TET * size ** 3) : 0);
    const predicted = MMG_CELL_K * ideal ** MMG_CELL_P;
    const err = Math.max(predicted / row.measured.tetrahedra, row.measured.tetrahedra / predicted);
    assert.ok(err < 2, `${row.id}: predicted ${Math.round(predicted)}, measured ${row.measured.tetrahedra} (off by ${err.toFixed(2)}x)`);
  }
});
