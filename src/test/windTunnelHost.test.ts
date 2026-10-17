import { test } from "node:test";
import assert from "node:assert/strict";

import { createWindTunnelHost } from "../windTunnelHost";
import { buildWindTunnelRequest, defaultWindTunnelForm, planRequestOf } from "../problemtype/windTunnel/form";

function harness(overrides: Partial<Parameters<typeof createWindTunnelHost>[0]> = {}) {
  const posted: Record<string, unknown>[] = [];
  let opened: string | undefined;
  const host = createWindTunnelHost({
    fsPath: () => "/data/car.stl",
    post: (m) => posted.push(m),
    pickBody: async () => "/data/other.stl",
    pickFolder: async () => "/out",
    open: (p) => { opened = p; },
    plan: async () => ({ runnable: true }),
    generate: async (_r, ex) => {
      ex.progress?.(1, 3, "step one");
      return { files: { mesh: "/out/t.mdpa" } };
    },
    ...overrides,
  });
  return { host, posted, opened: () => opened };
}
const tick = () => new Promise((r) => setImmediate(r));

test("hello offers a surface file as the body and a folder beside it", () => {
  const h = harness();
  assert.equal(h.host.handle({ type: "windTunnelHello" }), true);
  assert.deepEqual(h.posted[0], { type: "windTunnelState", bodyPath: "/data/car.stl", folder: "/data/car_tunnel", stem: "car", building: false });
  const mdpa = harness({ fsPath: () => "/data/m.mdpa" });
  mdpa.host.handle({ type: "windTunnelHello" });
  assert.equal(mdpa.posted[0].bodyPath, undefined, "a volume mesh is not offered as a body");
  assert.equal(harness().host.handle({ type: "somethingElse" }), false);
});

test("a plan replies with its sequence tag, and a superseded plan is never reported", async () => {
  let release: (() => void) | undefined;
  let calls = 0;
  const h = harness({
    plan: (_r, ex) => {
      calls++;
      if (calls === 1) {
        return new Promise((resolve) => {
          release = () => resolve({ stale: true });
          ex.signal?.addEventListener("abort", () => resolve({ stale: true }));
        });
      }
      return Promise.resolve({ fresh: true });
    },
  });
  h.host.handle({ type: "windTunnelPlan", seq: 1, request: { bodyPath: "x" } });
  h.host.handle({ type: "windTunnelPlan", seq: 2, request: { bodyPath: "x" } });
  release?.();
  await tick();
  await tick();
  const replies = h.posted.filter((m) => m.type === "windTunnelPlanResult");
  assert.deepEqual(replies.map((m) => m.seq), [2]);
  assert.deepEqual(replies[0].plan, { fresh: true });
  h.host.handle({ type: "windTunnelPlan", seq: 3, request: 5 });
  await tick();
  assert.equal(h.posted[h.posted.length - 1].message, "No request.");
});

test("a build streams progress, replies once and refuses a second at the same time", async () => {
  let finish: (() => void) | undefined;
  const h = harness({
    generate: (_r, ex) => new Promise((resolve) => {
      ex.progress?.(2, 5, "carving");
      finish = () => resolve({ files: { mesh: "/out/t.mdpa" } });
    }),
  });
  h.host.handle({ type: "windTunnelRun", seq: 7, request: { bodyPath: "x" } });
  h.host.handle({ type: "windTunnelRun", seq: 8, request: { bodyPath: "x" } });
  await tick();
  assert.ok(h.posted.some((m) => m.type === "windTunnelProgress" && m.seq === 7 && m.label === "carving"));
  assert.ok(h.posted.some((m) => m.type === "windTunnelResult" && m.seq === 8 && /already being built/.test(String(m.message))));
  finish?.();
  await tick();
  const done = h.posted.filter((m) => m.type === "windTunnelResult" && m.seq === 7);
  assert.equal(done.length, 1);
  h.host.handle({ type: "windTunnelOpen", path: "/out/t.mdpa" });
  assert.equal(h.opened(), "/out/t.mdpa");
});

test("cancelling aborts the build and reports it as cancelled, not as a failure", async () => {
  const h = harness({
    generate: (_r, ex) => new Promise((_resolve, reject) => ex.signal?.addEventListener("abort", () => reject(new Error("cancelled")))),
  });
  h.host.handle({ type: "windTunnelRun", seq: 1, request: { bodyPath: "x" } });
  h.host.handle({ type: "windTunnelCancel" });
  await tick();
  const result = h.posted.find((m) => m.type === "windTunnelResult")!;
  assert.equal(result.cancelled, true);
  const failing = harness({ generate: async () => { throw new Error("The mesh could not be built."); } });
  failing.host.handle({ type: "windTunnelRun", seq: 2, request: { bodyPath: "x" } });
  await tick();
  const bad = failing.posted.find((m) => m.type === "windTunnelResult")!;
  assert.equal(bad.cancelled, false);
  assert.equal(bad.message, "The mesh could not be built.");
});

test("the dialogs answer through their own messages and a disposed host posts nothing", async () => {
  const h = harness();
  h.host.handle({ type: "windTunnelPickBody" });
  h.host.handle({ type: "windTunnelPickFolder", folder: "/x" });
  await tick();
  assert.deepEqual(h.posted.map((m) => [m.type, m.path]), [["windTunnelBody", "/data/other.stl"], ["windTunnelFolder", "/out"]]);
  h.host.dispose();
  h.host.handle({ type: "windTunnelHello" });
  assert.equal(h.posted.length, 2);
});

test("the form turns text into a request and names the field that is wrong", () => {
  const form = { ...defaultWindTunnelForm(), bodyPath: "/data/car.stl", outputFolder: "/out", unit: "mm", speed: "40", surfaceSize: "0.05", rotation: ["0", "0", "90"] as [string, string, string], halfModel: true, ground: "moving" as const, clearance: "0.1" };
  const r = buildWindTunnelRequest(form);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.value.unit, "mm");
  assert.deepEqual(r.value.rotation, [0, 0, 90]);
  assert.deepEqual(r.value.tunnel, { ground: "moving", halfModel: true, clearance: 0.1 });
  assert.equal(r.value.mesh!.surfaceSize, 0.05);
  assert.equal(r.value.flow.speed, 40);
  assert.equal(r.value.stem, "tunnel");
  const bad = buildWindTunnelRequest({ ...form, growth: "0.5" });
  assert.ok(!bad.ok && bad.field === "growth");
  assert.ok(!buildWindTunnelRequest({ ...form, speed: "fast" }).ok);
  assert.ok(!buildWindTunnelRequest({ ...form, bodyPath: " " }).ok);
  assert.equal(buildWindTunnelRequest({ ...form, unit: "0.0254" }).ok && (buildWindTunnelRequest({ ...form, unit: "0.0254" }) as { value: { unit: unknown } }).value.unit, 0.0254);
  // A plan does not need an output folder.
  const p = planRequestOf({ ...form, outputFolder: "" });
  assert.ok(p.ok && !("outputFolder" in p.value));
});
