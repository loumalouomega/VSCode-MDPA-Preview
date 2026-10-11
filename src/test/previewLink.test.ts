import assert from "node:assert/strict";
import test from "node:test";

import { defaultPaneClipState, defaultPaneFieldState } from "../parser/paneView";
import {
  DEFAULT_LINK_SETTINGS,
  applyFieldPayload,
  applyRangePayload,
  describeLink,
  fieldPayload,
  matchTime,
  rangePayload,
  validateCameraPayload,
  validateClipPayload,
  validateLinkSettings,
  validateSavedLink,
} from "../parser/previewLink";

test("exact time matching never falls back to a neighbouring frame", () => {
  const times = [0, 0.1, 0.2, 0.3];
  assert.deepEqual(matchTime(times, 0.2, "exact", 0), { ok: true, index: 2, time: 0.2, delta: 0 });
  const miss = matchTime(times, 0.25, "exact", 0);
  assert.equal(miss.ok, false);
  assert.match((miss as { reason: string }).reason, /no frame at exactly/);
  assert.equal(matchTime([0.1 + 0.2], 0.3, "exact", 0).ok, true, "float noise is not a miss");
});

test("nearest matching respects the tolerance, reports the offset and refuses ties", () => {
  const times = [0, 1, 2];
  const hit = matchTime(times, 1.2, "nearest", 0.5);
  assert.ok(hit.ok && hit.index === 1 && hit.time === 1 && Math.abs(hit.delta + 0.2) < 1e-12);
  assert.equal(matchTime(times, 1.7, "nearest", 0.1).ok, false, "beyond tolerance is unmatched, not clamped");
  const tie = matchTime(times, 1.5, "nearest", 5);
  assert.equal(tie.ok, false);
  assert.match((tie as { reason: string }).reason, /between two frames/);
  assert.equal(matchTime(times, 1, "nearest", -1).ok, false);
});

test("a series without finite times, or a non-finite request, is unmatched with a reason", () => {
  assert.equal(matchTime([], 1, "exact", 0).ok, false);
  assert.equal(matchTime([Number.NaN], 1, "nearest", 9).ok, false);
  assert.equal(matchTime([1, 2], Number.NaN, "exact", 0).ok, false);
  const dup = matchTime([1, 1], 1, "exact", 0);
  assert.equal(dup.ok, false, "two frames at the same time are ambiguous");
});

test("settings read tolerantly and default per key", () => {
  assert.deepEqual(validateLinkSettings(undefined), DEFAULT_LINK_SETTINGS);
  const s = validateLinkSettings({ camera: false, time: "yes", timeMethod: "nearest", timeTolerance: -2, field: true });
  assert.equal(s.camera, false);
  assert.equal(s.time, true, "a non-boolean falls back to the default");
  assert.equal(s.timeMethod, "nearest");
  assert.equal(s.timeTolerance, 0, "a negative tolerance is ignored");
});

const ctx = (keys: Record<string, number>) => ({
  hasKey: (k: string) => k in keys,
  isVector: (k: string) => keys[k] > 1,
  components: (k: string) => keys[k] ?? 1,
});

test("a linked field applies only where the receiving mesh has it, and says otherwise", () => {
  const mine = { ...defaultPaneFieldState("Viridis"), selectedKey: "Nodal:T" };
  const payload = { selectedKey: "Nodal:V", component: 1, modes: ["contour", "iso", "quiver"], deformKey: "" };
  const ok = applyFieldPayload(mine, payload, ctx({ "Nodal:T": 1, "Nodal:V": 3 }));
  assert.equal(ok.state.selectedKey, "Nodal:V");
  assert.equal(ok.state.component, 1);
  assert.deepEqual([...ok.state.modes].sort(), ["contour", "quiver"], "a vector drives quiver, not iso");
  assert.deepEqual(ok.notes, []);
  assert.equal(mine.selectedKey, "Nodal:T", "input is not mutated");

  const missing = applyFieldPayload(mine, payload, ctx({ "Nodal:T": 1 }));
  assert.equal(missing.state.selectedKey, "Nodal:T", "a missing field keeps the receiver's own");
  assert.match(missing.notes[0], /not in this mesh/);

  const badComponent = applyFieldPayload(mine, { ...payload, component: 7 }, ctx({ "Nodal:V": 3 }));
  assert.equal(badComponent.state.component, "mag");
  assert.equal(applyFieldPayload(mine, "junk", ctx({})).notes.length, 1);
});

test("a linked colour range carries colormap, range, log and bands, validated", () => {
  const src = { ...defaultPaneFieldState("Plasma"), rangeOverride: [1, 5] as [number, number], log: true, bands: 10 };
  const out = applyRangePayload(defaultPaneFieldState("Viridis"), rangePayload(src), ["Viridis", "Plasma"]);
  assert.equal(out.state.colormap, "Plasma");
  assert.deepEqual(out.state.rangeOverride, [1, 5]);
  assert.equal(out.state.log, true);
  assert.equal(out.state.bands, 10);
  const bad = applyRangePayload(defaultPaneFieldState("Viridis"), { colormap: "Nope", rangeOverride: [1, "x"], bands: 9999 }, ["Viridis"]);
  assert.equal(bad.state.colormap, "Viridis");
  assert.equal(bad.notes.length, 1);
  assert.equal(bad.state.bands, 0);
  assert.equal(fieldPayload(src).selectedKey, "");
});

test("clip and camera payloads reject hostile input", () => {
  assert.deepEqual(validateClipPayload({ ...defaultPaneClipState(), t: 5 })?.t, 1);
  assert.equal(validateClipPayload({ active: 1 }), undefined);
  assert.equal(validateClipPayload({ ...defaultPaneClipState(), axis: 9 }), undefined);
  assert.equal(validateClipPayload({ ...defaultPaneClipState(), freeNormal: [1, 2] }), undefined);
  const cam = { position: [1, 2, 3], focalPoint: [0, 0, 0], viewUp: [0, 1, 0], parallelScale: 2 };
  assert.deepEqual(validateCameraPayload(cam), cam);
  assert.equal(validateCameraPayload({ ...cam, position: [1, 2] }), undefined);
});

test("saved link identity reads tolerantly and describes itself", () => {
  assert.deepEqual(validateSavedLink(undefined), { link: undefined, warnings: [] });
  const { link, warnings } = validateSavedLink({ peers: ["../run2/out.vtu", 3, ""], settings: { camera: false } });
  assert.deepEqual(link?.peers, ["../run2/out.vtu"]);
  assert.equal(link?.settings.camera, false);
  assert.equal(warnings.length, 2);
  assert.equal(validateSavedLink({ peers: [] }).link, undefined);
  assert.equal(validateSavedLink([1]).link, undefined);
  assert.equal(describeLink([], DEFAULT_LINK_SETTINGS), "Not linked.");
  assert.match(describeLink(["a.vtu"], { ...DEFAULT_LINK_SETTINGS, field: false, range: false, clip: false, time: false }), /a\.vtu — camera\./);
});
