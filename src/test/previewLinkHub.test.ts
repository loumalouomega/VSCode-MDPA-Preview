import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";

import { PreviewLinkHub, LinkMember } from "../parser/previewLinkHub";

function fake(id: string, fsPath: string | undefined, times?: number[]) {
  const posted: Record<string, unknown>[] = [];
  const m: LinkMember & { posted: Record<string, unknown>[]; fsPath: string | undefined } = {
    id,
    fsPath,
    fileName: fsPath ? path.basename(fsPath) : undefined,
    times: () => times,
    post: (msg) => posted.push(msg),
    posted,
  };
  return m;
}
const of = (m: { posted: Record<string, unknown>[] }, type: string) => m.posted.filter((p) => p.type === type);
const last = (m: { posted: Record<string, unknown>[] }, type: string) => { const all = of(m, type); return all[all.length - 1]; };
const cam = { position: [1, 2, 3], focalPoint: [0, 0, 0], viewUp: [0, 1, 0], parallelScale: 2 };

function pair(ta?: number[], tb?: number[]) {
  const hub = new PreviewLinkHub();
  const a = fake("a", path.resolve("/runs/one/out.vtu"), ta);
  const b = fake("b", path.resolve("/runs/two/out.vtu"), tb);
  hub.register(a);
  hub.register(b);
  hub.link(a, b);
  return { hub, a, b };
}

test("linking posts the state to both and lists relative peer paths", () => {
  const { a, b } = pair();
  const sa = last(a, "linkState") as { linked: boolean; peers: { name: string; path: string }[] };
  assert.equal(sa.linked, true);
  assert.deepEqual(sa.peers, [{ name: "out.vtu", path: "../two/out.vtu" }]);
  assert.equal((last(b, "linkState") as { linked: boolean }).linked, true);
});

test("a camera event reaches the peer only, only when that setting is on, and is validated", async () => {
  const { hub, a, b } = pair();
  await hub.handle(a, { type: "linkEvent", kind: "camera", payload: cam });
  assert.equal(of(b, "linkApply").length, 1);
  assert.equal(of(a, "linkApply").length, 0, "never echoed to the origin");
  await hub.handle(a, { type: "linkEvent", kind: "camera", payload: { position: [1] } });
  assert.equal(of(b, "linkApply").length, 1, "a malformed camera is dropped");
  await hub.handle(a, { type: "linkSettings", settings: { camera: false } });
  await hub.handle(a, { type: "linkEvent", kind: "camera", payload: cam });
  assert.equal(of(b, "linkApply").length, 1, "camera link switched off");
  assert.equal(((last(b, "linkState") as { settings: { camera: boolean } }).settings.camera), false, "the setting is shared by the group");
});

test("an unlinked member's events go nowhere", async () => {
  const hub = new PreviewLinkHub();
  const a = fake("a", "/x/a.vtu");
  const b = fake("b", "/x/b.vtu");
  hub.register(a);
  hub.register(b);
  await hub.handle(a, { type: "linkEvent", kind: "camera", payload: cam });
  assert.equal(of(b, "linkApply").length, 0);
});

test("time is matched by physical time, with the offset disclosed", async () => {
  const { hub, a, b } = pair([0, 1, 2], [0, 0.5, 1, 1.5, 2]);
  await hub.handle(a, { type: "linkEvent", kind: "time", payload: { time: 1 } });
  const apply = of(b, "linkApply")[0] as { payload: { index: number; delta: number } };
  assert.equal(apply.payload.index, 2, "frame INDEX 1 of A is physical time 1, which is index 2 of B");
  assert.equal(of(a, "linkNote").length, 0, "an exact match needs no disclosure");
});

test("an unmatched time is disclosed to both previews and nothing moves", async () => {
  const { hub, a, b } = pair([0, 1, 2], [0, 2]);
  await hub.handle(a, { type: "linkEvent", kind: "time", payload: { time: 1 } });
  assert.equal(of(b, "linkApply").length, 0);
  assert.match(String(of(a, "linkNote")[0].message), /no frame in out\.vtu/);
  assert.equal(of(b, "linkNote").length, 1);
});

test("nearest matching reports the offset it accepted", async () => {
  const { hub, a, b } = pair([0, 1], [0, 0.9]);
  await hub.handle(a, { type: "linkSettings", settings: { timeMethod: "nearest", timeTolerance: 0.2 } });
  await hub.handle(a, { type: "linkEvent", kind: "time", payload: { time: 1 } });
  assert.equal((of(b, "linkApply")[0] as { payload: { index: number } }).payload.index, 1);
  assert.match(String(of(a, "linkNote")[0].message), /nearest frame is t = 0\.9/);
});

test("a mapped time matches across time bases and discloses the mapping", async () => {
  // A runs in seconds, B in milliseconds.
  const { hub, a, b } = pair([0, 1, 2], [0, 1000, 2000]);
  await hub.handle(a, { type: "linkSettings", settings: { timeScale: 1000 } });
  await hub.handle(a, { type: "linkEvent", kind: "time", payload: { time: 1 } });
  assert.equal((of(b, "linkApply")[0] as { payload: { index: number } }).payload.index, 1);
  assert.match(String(of(a, "linkNote")[0].message), /t ×1000 \+ 0/);
});

test("an unmatched mapped time names the mapped time, not the raw one", async () => {
  const { hub, a, b } = pair([0, 1, 2], [0, 2000]);
  await hub.handle(a, { type: "linkSettings", settings: { timeScale: 1000 } });
  await hub.handle(a, { type: "linkEvent", kind: "time", payload: { time: 1 } });
  assert.equal(of(b, "linkApply").length, 0);
  // The lookup was for t = 1000, so the disclosure must say 1000, not 1.
  assert.match(String(of(a, "linkNote")[0].message), /t = 1000 \(mapped from 1/);
  assert.equal(of(b, "linkNote").length, 1);
});

test("identity mapping keeps the old disclosures word for word", async () => {
  const { hub, a, b } = pair([0, 1, 2], [0, 2]);
  await hub.handle(a, { type: "linkEvent", kind: "time", payload: { time: 1 } });
  assert.match(String(of(a, "linkNote")[0].message), /t = 1 has no frame/);
});

test("a series without physical times is never linked on time", async () => {
  const { hub, a, b } = pair([0, 1], undefined);
  await hub.handle(a, { type: "linkEvent", kind: "time", payload: { time: 1 } });
  assert.equal(of(b, "linkApply").length, 0);
  assert.match(String(of(a, "linkNote")[0].message), /no physical times/);
  await hub.handle(b, { type: "linkEvent", kind: "time", payload: { time: null } });
  assert.match(String(of(b, "linkNote")[0].message), /step numbers/);
});

test("unlink dissolves a pair, and closing a preview leaves its peer unlinked", async () => {
  const { hub, a, b } = pair();
  await hub.handle(a, { type: "linkUnlink" });
  assert.equal((last(b, "linkState") as { linked: boolean }).linked, false);
  hub.link(a, b);
  const off = hub.register(fake("c", "/x/c.vtu"));
  off();
  hub.register(a)(); // unregister a
  assert.equal(hub.peersOf("b").length, 0);
});

test("linkPick offers only other bound previews and links the chosen one", async () => {
  const hub = new PreviewLinkHub();
  const a = fake("a", "/x/a.vtu");
  const b = fake("b", "/x/b.vtu");
  const shell = fake("shell", undefined);
  [a, b, shell].forEach((m) => hub.register(m));
  let offered: string[] = [];
  hub.pickPeer = async (_r, c) => { offered = c.map((m) => m.id); return c[0]; };
  await hub.handle(a, { type: "linkPick" });
  assert.deepEqual(offered, ["b"], "the unbound shell and the requester are not candidates");
  assert.equal(hub.peersOf("a")[0].id, "b");
  const lonely = new PreviewLinkHub();
  const x = fake("x", "/x/x.vtu");
  lonely.register(x);
  lonely.pickPeer = async () => undefined;
  await lonely.handle(x, { type: "linkPick" });
  assert.match(String(of(x, "linkNote")[0].message), /second mesh or run/);
});

test("a saved link re-links now when the peer is open, or when it opens later", async () => {
  const hub = new PreviewLinkHub();
  const a = fake("a", path.resolve("/runs/one/out.vtu"));
  hub.register(a);
  await hub.handle(a, { type: "linkRestore", saved: { peers: ["../two/out.vtu"], settings: { camera: false } } });
  assert.equal(hub.peersOf("a").length, 0, "peer not open yet");
  const b = fake("b", undefined);
  hub.register(b);
  const bound = { ...b, fsPath: path.resolve("/runs/two/out.vtu"), fileName: "out.vtu" };
  hub.register(bound); // same id re-registers with its bound path (a session binds late)
  hub.rebind(bound);
  assert.equal(hub.peersOf("a")[0]?.id, "b");
  assert.equal(hub.groupOf("a")?.settings.camera, false, "the saved settings come back with the link");
});

test("only the preview that asked for the link reports its view first", () => {
  const { a, b } = pair();
  assert.equal((last(a, "linkState") as { initiator: boolean }).initiator, true);
  assert.equal((last(b, "linkState") as { initiator: boolean }).initiator, false);
});
