import { test } from "node:test";
import assert from "node:assert/strict";
import { MonitorRefreshThrottle } from "../problemtype/monitorRefresh";
import { monitorRowText } from "../problemtype/monitors";

function harness() {
  let t = 0;
  let runs = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const throttle = new MonitorRefreshThrottle({
    now: () => t,
    setTimer: (fn, ms) => { const id = nextId++; timers.push({ at: t + ms, fn, id }); return id; },
    clearTimer: (h) => { const i = timers.findIndex((x) => x.id === h); if (i >= 0) timers.splice(i, 1); },
    run: async () => { runs++; },
  });
  const advance = async (ms: number) => {
    t += ms;
    for (const due of timers.filter((x) => x.at <= t)) { timers.splice(timers.indexOf(due), 1); due.fn(); }
    await new Promise((r) => setImmediate(r));
  };
  return { throttle, advance, runs: () => runs, timers };
}

test("first request runs at once; a burst inside 2 s collapses to one trailing run", async () => {
  const h = harness();
  h.throttle.request();
  await h.advance(0);
  assert.equal(h.runs(), 1);
  h.throttle.request(); h.throttle.request(); h.throttle.request();
  await h.advance(500);
  assert.equal(h.runs(), 1);
  await h.advance(1500);
  assert.equal(h.runs(), 2);
});

test("stop cancels the trailing run and ignores later requests", async () => {
  const h = harness();
  h.throttle.request();
  await h.advance(0);
  h.throttle.request();
  h.throttle.stop();
  await h.advance(5000);
  assert.equal(h.runs(), 1);
  h.throttle.request();
  await h.advance(5000);
  assert.equal(h.runs(), 1);
});

test("monitor row says how many written frames while live only", () => {
  const s = [{ id: "a", name: "Flux", unit: "kg/s", columns: ["v"], frames: 3, last: { time: 0, frame: 2, values: [1.5] }, gaps: 0, partial: true, diagnostics: [] }];
  assert.match(monitorRowText(s, 1, { frames: 3, live: true }), /evaluated from 3 written frames$/);
  assert.match(monitorRowText(s, 1, { frames: 1, live: true }), /1 written frame$/);
  assert.doesNotMatch(monitorRowText(s, 1, { frames: 3, live: false }), /written/);
});
