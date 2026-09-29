import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RecordingStore, RecordingOutput } from "../recordingStore";
import { DEFAULT_CAPTURE_SETTINGS } from "../parser/capturePlan";
import { DEFAULT_RECORD_SETTINGS, buildRecordPlan } from "../parser/recordPlan";
import { gifDelayMs, includedFrames, validateReview } from "../parser/recordSession";

const png = (width = 32): string => {
  const bytes = Buffer.alloc(24); Buffer.from("89504e470d0a1a0a", "hex").copy(bytes); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(24, 20);
  return `data:image/png;base64,${bytes.toString("base64")}`;
};
test("selection uses inclusive source positions; GIF rounding does not drift", () => {
  const plan = buildRecordPlan({ ...DEFAULT_RECORD_SETTINGS, source: "timeline", firstStep: 2, lastStep: 8, stride: 3 }, 10);
  assert.deepEqual(plan.steps, [1, 4, 7].map(frameIndex => ({ kind: "timeline", frameIndex })));
  assert.throws(() => buildRecordPlan({ ...DEFAULT_RECORD_SETTINGS, source: "timeline", stride: 0 }, 10));
  for (const fps of [12, 24, 30, 50]) {
    const delays = Array.from({ length: fps * 10 }, (_, i) => gifDelayMs(i, fps));
    assert.equal(delays.reduce((sum, d) => sum + d, 0), 10_000);
    assert.ok(delays.every(d => d >= 20 && d % 10 === 0));
  }
});
test("disk drafts acknowledge ordered frames, recover partial captures, retain source metadata and export review selection", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recording-store-"));
  try {
    const store = new RecordingStore(path.join(root, "drafts"), "/mesh/result.vtu");
    const m = await store.create(DEFAULT_RECORD_SETTINGS, DEFAULT_CAPTURE_SETTINGS, 32, 24);
    for (let i = 0; i < 4; i++) assert.equal(await store.append(m.id, { index: i, sourceIndex: 2 * i, label: `${i / 10}`, labelKind: "time", timeUnit: "s" }, png()), i + 1);
    await assert.rejects(store.append(m.id, { index: 3, label: "bad", labelKind: "step" }, png()), /order/);
    await assert.rejects(store.append(m.id, { index: 4, label: "bad", labelKind: "step" }, png(64)), /dimensions/);
    const recovered = (await new RecordingStore(store.root, store.source).list())[0];
    assert.equal(recovered.status, "partial"); assert.equal(recovered.frames.length, 4);
    const review = { ...recovered.review, first: 1, last: 3, excluded: [2], fps: 24 };
    const reviewed = await store.review(m.id, review);
    assert.deepEqual(includedFrames(reviewed).map(f => f.sourceIndex), [2, 6]);
    assert.throws(() => validateReview({ ...review, first: 4 }, 4), /trim/);
    const exportResult = await store.exportPng(m.id, root);
    const destination = exportResult.destination;
    assert.deepEqual((await fs.readdir(destination)).sort(), ["README.txt", "frame_0000.png", "frame_0001.png", "manifest.json"]);
    const exported = JSON.parse(await fs.readFile(path.join(destination, "manifest.json"), "utf8"));
    assert.equal(exported.frames[1].sourceIndex, 6); assert.equal(exported.frames[1].timestamp, 1 / 24); assert.equal(exported.frames[1].timeUnit, "s"); assert.equal(exported.playback.fps, 24);
    assert.match(await fs.readFile(path.join(destination, "README.txt"), "utf8"), /-framerate 24/);
    await assert.rejects(new RecordingStore(store.root, "/another.vtu").read(m.id, 0), /document/);
    await assert.rejects(store.read("../../private", 0), /identifier/);
    await assert.rejects(store.read(m.id, 999), /Unknown/);
    await assert.rejects(store.exportPng(m.id, path.join(root, "missing")));
    const partialExport = await store.exportPng(m.id, root, () => true);
    assert.equal(partialExport.frames, 0); assert.equal(partialExport.total, 2);
    assert.match(await fs.readFile(path.join(partialExport.destination, "README.txt"), "utf8"), /PARTIAL.*0 of 2/);
    assert.equal(JSON.parse(await fs.readFile(path.join(partialExport.destination, "manifest.json"), "utf8")).status, "partial");
    assert.equal((await store.load(m.id)).frames.length, 4);
    await store.finish(m.id, "cancelled"); assert.equal((await store.load(m.id)).status, "partial");
    await store.discard(m.id); assert.deepEqual(await store.list(), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("streaming output honors rewrites, finalizes atomically, and cancellation preserves prior destination", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recording-output-"));
  try {
    const dest = path.join(root, "output.webm"), output = new RecordingOutput();
    await fs.writeFile(dest, "previous");
    await output.begin(dest); await output.write(Buffer.from("headerpayload"), 0); await output.write(Buffer.from("FINAL!"), 0);
    assert.equal(await fs.readFile(dest, "utf8"), "previous");
    await output.finish(); assert.equal(await fs.readFile(dest, "utf8"), "FINAL!payload");
    await output.begin(dest); await output.write(Buffer.from("incomplete"), 0); await output.cancel();
    assert.equal(await fs.readFile(dest, "utf8"), "FINAL!payload"); assert.deepEqual(await fs.readdir(root), ["output.webm"]);
    await assert.rejects(output.write(Buffer.from("x"), -1), /Invalid/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
