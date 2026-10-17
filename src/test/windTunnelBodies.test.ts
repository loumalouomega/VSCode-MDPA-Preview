import { test } from "node:test";
import assert from "node:assert/strict";
import { icosphere } from "./fixtures/shapes";
import { parseMdpa } from "../parser/mdpaParser";
import type { MdpaModel } from "../parser/types";
import { bodyMetrics } from "../problemtype/windTunnel/body";
import type { Vec3 } from "../problemtype/windTunnel/body";
import {
  checkBodyGaps,
  describeBody,
  mergeBodySurfaces,
  placeBodies,
  planTunnelBodies,
  splitWallByBodies,
  trianglesIntersect,
} from "../problemtype/windTunnel/bodies";
import type { PlacedBody } from "../problemtype/windTunnel/bodies";
import { referenceQuantities } from "../problemtype/windTunnel/plan";
import { unitScale } from "../problemtype/windTunnel/plan";

const parseModel = (text: string): MdpaModel => {
  const r = parseMdpa(text) as unknown as { model?: MdpaModel };
  return (r.model ?? (r as unknown as MdpaModel)) as MdpaModel;
};

const tri = (a: Vec3, b: Vec3, c: Vec3): { a: Vec3; b: Vec3; c: Vec3 } => ({ a, b, c });

test("triangle intersection finds overlap and touch, and clears separation", () => {
  const t = tri([0, 0, 0], [1, 0, 0], [0, 1, 0]);
  assert.equal(trianglesIntersect(t, tri([0.2, 0.2, -1], [0.2, 0.2, 1], [0.8, 0.2, 0])), true, "a spike through the face");
  assert.equal(trianglesIntersect(t, tri([0, 0, 0], [1, 0, 0], [0, 1, 0])), true, "coincident");
  assert.equal(trianglesIntersect(t, tri([2, 0, 0], [3, 0, 0], [2, 1, 0])), false, "separate");
  assert.equal(trianglesIntersect(t, tri([1, 0, 0], [2, 0, 0], [1, 1, 0])), true, "touching at an edge");
});

const sphereAt = (x: number): MdpaModel => {
  const m = icosphere(0.5, 1);
  const coords = Float32Array.from(m.coords);
  for (let i = 0; i < m.nodeCount; i++) coords[3 * i] += x;
  return { ...m, coords };
};

const placedPair = (gap: number): PlacedBody[] =>
  placeBodies([icosphere(0.5, 1), icosphere(0.5, 1)], [{}, { position: [1 + gap, 0, 0] }], () => 1);

const placedAt = (x: number): PlacedBody[] =>
  placeBodies([icosphere(0.5, 1), icosphere(0.5, 1)], [{}, { position: [x, 0, 0] }], () => 1);

test("separated bodies pass the gap check, overlapping or touching ones are refused", () => {
  assert.deepEqual(checkBodyGaps(placedPair(2), 0.1), []);
  const overlap = checkBodyGaps(placedAt(0.2), 0.1);
  assert.equal(overlap.length, 1, overlap.join("; "));
  assert.match(overlap[0], /overlap/);
  const touching = checkBodyGaps(placedAt(1), 0.2);
  assert.equal(touching.length, 1, touching.join("; "));
  assert.match(touching[0], /below the minimum gap/);
  const near = checkBodyGaps(placedAt(1.05), 0.2);
  assert.equal(near.length, 1, near.join("; "));
  assert.match(near[0], /below the minimum gap/);
});

test("bodies are placed by unit, rotation and position", () => {
  const raw = icosphere(0.5, 0);
  const expected = bodyMetrics(raw).size[0] * 1000;
  const [a] = placeBodies([raw], [{ unit: 1000, position: [10, 0, 0], name: "nose" }], (s) => unitScale(s.unit));
  assert.equal(a.name, "nose");
  assert.ok(Math.abs(a.metrics.size[0] - expected) < 1, `mm read as metres: ${a.metrics.size}`);
  assert.ok(Math.abs(a.center[0] - 10) < 1e-9, `centre moved to the position: ${a.center}`);
  const [r] = placeBodies([raw], [{ rotation: [0, 0, 90] }], (s) => unitScale(s.unit));
  assert.ok(Math.abs(r.metrics.size[0] - bodyMetrics(raw).size[1]) < 1e-9, "a 90° yaw swaps length and width");
});

test("merged surfaces concatenate the triangles", () => {
  const bodies = placedPair(2);
  const merged = mergeBodySurfaces(bodies);
  const tris = bodies.reduce((s, b) => s + bodyMetrics(b.model).triangles, 0);
  let count = 0;
  for (const blk of merged.blocks) count += blk.count;
  assert.equal(count, tris);
});

const WALL_MDPA = `Begin Properties 0
End Properties
Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 1.0 1.0 0.0
4 0.0 1.0 0.0
5 5.0 0.0 0.0
6 6.0 0.0 0.0
7 6.0 1.0 0.0
8 5.0 1.0 0.0
End Nodes
Begin Conditions SurfaceCondition3D3N
1 0 1 2 3
2 0 1 3 4
3 0 5 6 7
4 0 5 7 8
End Conditions
Begin SubModelPart Body
Begin SubModelPartNodes
1
2
3
4
5
6
7
8
End SubModelPartNodes
Begin SubModelPartConditions
1
2
3
4
End SubModelPartConditions
End SubModelPart
`;

const tinyAt = (x: number, y: number): MdpaModel =>
  parseModel(`Begin Properties 0
End Properties
Begin Nodes
1 ${x} ${y} 0.5
2 ${x + 0.1} ${y} 0.5
3 ${x} ${y + 0.1} 0.5
End Nodes
Begin Conditions SurfaceCondition3D3N
1 0 1 2 3
End Conditions
`);

const tinyBodies = (): PlacedBody[] => {
  const a = tinyAt(0.5, 0.5);
  const b = tinyAt(5.5, 0.5);
  const ma = bodyMetrics(a);
  const mb = bodyMetrics(b);
  const center = (m: typeof ma): Vec3 => [(m.min[0] + m.max[0]) / 2, (m.min[1] + m.max[1]) / 2, (m.min[2] + m.max[2]) / 2];
  return [
    { name: "left", model: a, metrics: ma, center: center(ma) },
    { name: "right", model: b, metrics: mb, center: center(mb) },
  ];
};

test("the carved wall splits into Body_1, Body_2 and a Bodies parent", () => {
  const { model, matched, problems } = splitWallByBodies(parseModel(WALL_MDPA), tinyBodies());
  assert.deepEqual(problems, []);
  assert.deepEqual(matched, ['Body_1 ("left")', 'Body_2 ("right")']);
  const names = model.subModelParts.map((p) => p.name);
  assert.ok(!names.includes("Body"), "the merged wall is gone");
  for (const n of ["Body_1", "Body_2", "Bodies"]) assert.ok(names.includes(n), `${n} present: ${names.join(",")}`);
  const one = model.subModelParts.find((p) => p.name === "Body_1")!;
  const two = model.subModelParts.find((p) => p.name === "Body_2")!;
  assert.deepEqual([...one.conditionIds].sort((x, y) => x - y), [1, 2]);
  assert.deepEqual([...two.conditionIds].sort((x, y) => x - y), [3, 4]);
  const parent = model.subModelParts.find((p) => p.name === "Bodies")!;
  assert.equal(parent.conditionIds.length, 4, "the parent holds the whole wall");
});

const params = {
  flow: { speed: 10 },
  tunnel: { upstream: 1.5, downstream: 3, side: 2, top: 2, bottom: 2 },
  mesh: { surfaceSize: 0.12, farSize: 1.0, firstHeight: 0.012, growth: 1.3, maxAspect: 10, wakeLength: 1, wakeSize: 0.25, fit: 0.004 },
};

test("a multi-body plan references the first body and splits the wall after the carve", () => {
  const plan = planTunnelBodies(
    { ...params, bodies: [{ name: "nose" }, { name: "tail", position: [3, 0, 0] }] },
    [icosphere(0.5, 1), icosphere(0.5, 1)],
    (s) => unitScale(s.unit)
  );
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.bodies!.length, 2);
  assert.equal(plan.bodies![0].name, "nose");
  assert.deepEqual(plan.steps.map((s) => s.id).filter((i) => !i.startsWith("size-")), ["body", "lattice", "carve", "tidy", "snap", "split", "wall", "check", "write"]);
  const ref = referenceQuantities(plan);
  assert.ok(Math.abs(ref.length - plan.bodies![0].size[0]) < 1e-9, "the first body gives the reference length");
  assert.ok(Math.abs(ref.area - plan.bodies![0].frontalArea) < 1e-12, "the first body gives the reference area");
  assert.ok(plan.bodies![0].center[0] < plan.bodies![1].center[0], "centres follow the positions");
  assert.match(describeBody(plan.bodies![0], 0), /nose/);
});

test("overlapping bodies and doubled names refuse to plan", () => {
  const overlapping = planTunnelBodies({ ...params, bodies: [{}, { position: [0.2, 0, 0] }] }, [icosphere(0.5, 1), icosphere(0.5, 1)], (s) => unitScale(s.unit));
  assert.ok(overlapping.errors.some((e) => /overlap|below the minimum gap/.test(e)), overlapping.errors.join("; "));
  const dupes = planTunnelBodies({ ...params, bodies: [{ name: "x" }, { name: "x", position: [5, 0, 0] }] }, [icosphere(0.5, 1), icosphere(0.5, 1)], (s) => unitScale(s.unit));
  assert.ok(dupes.errors.some((e) => /unique/.test(e)), dupes.errors.join("; "));
  assert.throws(() => planTunnelBodies({ ...params, bodies: [] }, [], (s) => unitScale(s.unit)), /at least one body/);
});

test("the wizard maps extra bodies, and a lone body stays the legacy single", async () => {
  const { defaultWindTunnelForm, buildWindTunnelRequest } = await import("../problemtype/windTunnel/form");
  const single = buildWindTunnelRequest({ ...defaultWindTunnelForm(), bodyPath: "a.stl", outputFolder: "/tmp/vwt" });
  assert.equal(single.ok, true);
  if (single.ok) {
    assert.equal(single.value.bodyPath, "a.stl");
    assert.ok(!("bodies" in single.value), "no bodies key for one body");
  }
  const multi = buildWindTunnelRequest({
    ...defaultWindTunnelForm(),
    bodyPath: "a.stl",
    outputFolder: "/tmp/vwt",
    extraBodies: [
      { bodyPath: "b.stl", unit: "mm", rotation: ["", "", "90"], position: ["2", "0", "0"], name: "" },
      { bodyPath: "", unit: "m", rotation: ["", "", ""], position: ["5", "0", "0"], name: "tail" },
    ],
  });
  assert.equal(multi.ok, false, "an extra body without a file is refused");
  const good = buildWindTunnelRequest({
    ...defaultWindTunnelForm(),
    bodyPath: "a.stl",
    outputFolder: "/tmp/vwt",
    extraBodies: [{ bodyPath: "b.stl", unit: "mm", rotation: ["", "", "90"], position: ["2", "0", "0"], name: "" }],
  });
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.ok(!("bodyPath" in good.value), "multi drops the single path");
    assert.deepEqual(good.value.bodies, [
      { path: "a.stl", unit: "m", position: [0, 0, 0], name: "a" },
      { path: "b.stl", unit: "mm", rotation: [0, 0, 90], position: [2, 0, 0], name: "b" },
    ]);
  }
});

test("a multi-body plan carries per-body references and the RANS wall on Bodies", async () => {
  const { windTunnelCase } = await import("../problemtype/windTunnel/caseState");
  const plan = planTunnelBodies(
    { ...params, flow: { speed: 10, turbulence: "k_epsilon" }, bodies: [{ name: "nose" }, { name: "tail", position: [3, 0, 0] }] },
    [icosphere(0.5, 1), icosphere(0.5, 1)],
    (s) => unitScale(s.unit)
  );
  assert.deepEqual(plan.errors, []);
  const c = windTunnelCase(plan);
  assert.equal(c.problemtypeId, "rans");
  assert.deepEqual(c.state.assignments.filter((a) => a.conditionId === "ransWall").map((a) => a.smpPath), ["Bodies"]);
  assert.ok(c.state.materials.some((m) => m.smpPath === "Bodies" && m.lawId === "rans_wall"));
  assert.ok(!c.state.assignments.some((a) => a.smpPath === "Body"), "no single Body part");
  const forced = c.state.assignments.filter((a) => a.conditionId === "flowForces").map((a) => a.smpPath).sort();
  assert.deepEqual(forced, ["Body_1", "Body_2"]);
  const plain = planTunnelBodies({ ...params, bodies: [{}, { position: [4, 0, 0] }] }, [icosphere(0.5, 1), icosphere(0.5, 1)], (s) => unitScale(s.unit));
  const fc = windTunnelCase(plain);
  assert.equal(fc.problemtypeId, "fluid");
  assert.deepEqual(fc.state.assignments.filter((a) => a.conditionId === "wallLaw").map((a) => a.smpPath), ["Body_1", "Body_2"]);
});

test("two spheres mesh with per-body walls, monitors and a measured fit", async () => {
  const { runWindTunnel } = await import("../problemtype/windTunnel/run");
  const { promises: fsp } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const plan = planTunnelBodies(
    {
      flow: { speed: 5 },
      tunnel: { upstream: 1.5, downstream: 3, side: 2, top: 2, bottom: 2 },
      mesh: { surfaceSize: 0.3, farSize: 1.5, firstHeight: 0.03, growth: 1.3, maxAspect: 10, wakeLength: 1, wakeSize: 0.5, fit: 0.01 },
      bodies: [{ name: "fore" }, { name: "aft", position: [3, 0, 0] }],
    },
    [icosphere(0.5, 1), icosphere(0.5, 1)],
    (s) => unitScale(s.unit)
  );
  assert.deepEqual(plan.errors, []);
  const folder = await fsp.mkdtemp(join(tmpdir(), "vwt-multi-"));
  const r = await runWindTunnel(plan, { folder, stem: "tunnel" });
  assert.equal(r.report.check.inverted, 0, "no inverted tetrahedra");
  const names = r.model.subModelParts.map((p) => p.name);
  for (const n of ["Fluid", "Body_1", "Body_2", "Bodies", "Inlet", "Outlet"]) assert.ok(names.includes(n), `${n} present: ${names.join(",")}`);
  assert.ok(!names.includes("Body"), "the merged wall is split");
  assert.equal(r.report.bodies!.length, 2);
  assert.ok(r.report.bodies!.every((b) => b.wallFit && b.wallFit.max < 0.05), `per-body fits: ${JSON.stringify(r.report.bodies)}`);
  const forced = r.case.state.assignments.filter((a) => a.conditionId === "flowForces").map((a) => a.smpPath).sort();
  assert.deepEqual(forced, ["Body_1", "Body_2"]);
  assert.ok(r.case.notes.some((n) => /first body/.test(n)), r.case.notes.join("; "));
});
