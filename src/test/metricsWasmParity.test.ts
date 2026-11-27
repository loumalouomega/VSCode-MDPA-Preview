import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { computeSolverMetrics, computeSolverMetricsTs } from "../parser/elementMetrics";
import { isMdpaWasmAvailable, loadMdpaWasm } from "../parser/mdpaWasm";
import { parseMdpaTs } from "../parser/mdpaParser";
import { VtkCellType as C } from "../parser/geometryMap";
import type { MdpaModel } from "../parser/types";

// Roadmap item 87, Phase 2: the Rust solver-metrics kernels must agree with the
// TypeScript implementation, which stays as the oracle and the fallback.

const available = isMdpaWasmAvailable() && !!loadMdpaWasm()?.WasmMetricsMesh;
const opts = { skip: available ? false : "mdpa-core WASM with WasmMetricsMesh not built" };

let seed = 12345;
const rnd = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
};

type P = [number, number, number];
const unit = {
  tri: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] as P[],
  quad: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]] as P[],
  tet: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]] as P[],
  hex: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] as P[],
  wedge: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1]] as P[],
  pyramid: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0.5, 0.5, 1]] as P[],
};
const PAIRS = {
  tri: [[0, 1], [1, 2], [2, 0]],
  quad: [[0, 1], [1, 2], [2, 3], [3, 0]],
  tet: [[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]],
  hex: [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]],
};

interface Spec { name: string; type: number; base: P[]; pairs?: number[][]; }
const SPECS: Spec[] = [
  { name: "tri", type: C.TRIANGLE, base: unit.tri },
  { name: "tri6", type: C.QUADRATIC_TRIANGLE, base: unit.tri, pairs: PAIRS.tri },
  { name: "quad", type: C.QUAD, base: unit.quad },
  { name: "quad8", type: C.QUADRATIC_QUAD, base: unit.quad, pairs: PAIRS.quad },
  { name: "tet", type: C.TETRA, base: unit.tet },
  { name: "tet10", type: C.QUADRATIC_TETRA, base: unit.tet, pairs: PAIRS.tet },
  { name: "hex", type: C.HEXAHEDRON, base: unit.hex },
  { name: "hex20", type: C.QUADRATIC_HEXAHEDRON, base: unit.hex, pairs: PAIRS.hex },
  { name: "wedge", type: C.WEDGE, base: unit.wedge },
  { name: "pyramid", type: C.PYRAMID, base: unit.pyramid },
];

function jitter(p: P, amp: number): P {
  return [p[0] + (rnd() - 0.5) * amp, p[1] + (rnd() - 0.5) * amp, p[2] + (rnd() - 0.5) * amp];
}

function buildModel(spec: Spec, cells: number, amp: number, degenerate: boolean): MdpaModel {
  const per = spec.base.length + (spec.pairs?.length ?? 0);
  const pts: P[] = [];
  const conn: number[] = [];
  for (let c = 0; c < cells; c++) {
    const scale = 0.2 + rnd() * 3;
    const corners = spec.base.map((p) => jitter([p[0] * scale, p[1] * scale, p[2] * scale], amp));
    if (degenerate && c % 7 === 3) corners[1] = [...corners[0]] as P; // zero-length edge
    if (degenerate && c % 11 === 5) corners.forEach((p) => { p[2] = 0; }); // flat solid
    const all = [...corners];
    for (const [a, b] of spec.pairs ?? []) {
      all.push(jitter([(corners[a][0] + corners[b][0]) / 2, (corners[a][1] + corners[b][1]) / 2, (corners[a][2] + corners[b][2]) / 2], amp * 0.5));
    }
    for (const p of all) { pts.push(p); conn.push(pts.length); }
  }
  const coords = new Float32Array(pts.length * 3);
  const nodeIds = new Int32Array(pts.length);
  pts.forEach((p, i) => { nodeIds[i] = i + 1; coords.set(p, i * 3); });
  return {
    nodeCount: pts.length, nodeIds, coords,
    blocks: [{
      kind: "Elements", name: spec.name, vtkCellType: spec.type, count: cells, stride: per,
      entityIds: Int32Array.from({ length: cells }, (_, i) => 1000 + i),
      propertyIds: new Int32Array(cells), connectivity: Int32Array.from(conn),
    }],
    subModelParts: [], meta: [], fields: [], diagnostics: [], is3D: true,
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  };
}

function near(a: unknown, b: unknown, where: string): void {
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isNaN(a) && Number.isNaN(b)) return;
    if (a === b) return;
    const tol = 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
    assert.ok(Math.abs(a - b) <= tol, `${where}: ${a} vs ${b}`);
    return;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object);
    assert.deepEqual(ka, Object.keys(b as object), `${where}: keys`);
    for (const k of ka) near((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${where}.${k}`);
    return;
  }
  assert.deepEqual(a, b, where);
}

for (const spec of SPECS) {
  test(`solver metrics WASM matches TS: ${spec.name}`, opts, () => {
    for (const [amp, degenerate] of [[0.05, false], [0.6, false], [0.3, true]] as const) {
      const model = buildModel(spec, 40, amp, degenerate);
      near(computeSolverMetrics(model), computeSolverMetricsTs(model), `${spec.name} amp=${amp} deg=${degenerate}`);
    }
  });
}

test("solver metrics WASM matches TS: key subset and unsupported blocks", opts, () => {
  const model = buildModel(SPECS[4], 25, 0.4, false);
  near(computeSolverMetrics(model, ["radiusRatio", "volumeRatio"]), computeSolverMetricsTs(model, ["radiusRatio", "volumeRatio"]), "subset");
  // A truncated connectivity row (stride shorter than the quadratic shape needs) is skipped by both.
  const short = buildModel(SPECS[5], 10, 0.2, false);
  short.blocks[0] = { ...short.blocks[0], stride: 4, connectivity: short.blocks[0].connectivity.filter((_, i) => i % 10 < 4) };
  near(computeSolverMetrics(short), computeSolverMetricsTs(short), "short stride");
  // A node id missing from the table drops the cell in both.
  const missing = buildModel(SPECS[6], 10, 0.2, false);
  missing.blocks[0].connectivity[3] = 99999;
  near(computeSolverMetrics(missing), computeSolverMetricsTs(missing), "missing node");
});

test("solver metrics WASM matches TS on committed fixtures", opts, () => {
  const root = path.resolve(__dirname, "../../src/test/fixtures");
  const walk = (dir: string, out: string[]): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f, out);
      else if (e.name.endsWith(".mdpa")) out.push(f);
    }
    return out;
  };
  for (const f of walk(root, [])) {
    const model = parseMdpaTs(fs.readFileSync(f, "utf8"));
    near(computeSolverMetrics(model), computeSolverMetricsTs(model), f);
  }
});
