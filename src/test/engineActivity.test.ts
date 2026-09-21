import { test, beforeEach } from "node:test";
import assert from "node:assert";

import { engineState, onEngineChange, reportEngine, resetEngineActivity, trackEngine } from "../engineActivity";
import type { EngineState } from "../statusStats";

beforeEach(() => resetEngineActivity());

test("a tracked call reports loading while it runs and ready once it succeeds", async () => {
  const seen: EngineState[] = [];
  onEngineChange((s) => seen.push(s));
  let during: string | undefined;
  const out = await trackEngine("mmg", async () => {
    during = engineState().mmg;
    return 42;
  });
  assert.strictEqual(out, 42);
  assert.strictEqual(during, "loading");
  assert.strictEqual(engineState().mmg, "ready");
  assert.deepStrictEqual(
    seen.map((s) => s.mmg),
    ["loading", "ready"]
  );
});

test("a failing call rethrows unchanged and leaves the engine idle", async () => {
  const boom = new Error("boom");
  await assert.rejects(
    trackEngine("meshio", async () => {
      throw boom;
    }),
    (e) => e === boom
  );
  assert.strictEqual(engineState().meshio, "idle");
});

test("subscribers hear only real changes, and can unsubscribe", () => {
  let calls = 0;
  const off = onEngineChange(() => calls++);
  reportEngine({ type: "success", engine: "pyodide" });
  reportEngine({ type: "success", engine: "pyodide" }); // already ready: no change
  reportEngine({ type: "start", engine: "pyodide" }); // never demotes
  assert.strictEqual(calls, 1);
  off();
  reportEngine({ type: "success", engine: "mmg" });
  assert.strictEqual(calls, 1);
});

test("a throwing listener cannot break the engine call that reported", () => {
  onEngineChange(() => {
    throw new Error("listener bug");
  });
  assert.doesNotThrow(() => reportEngine({ type: "start", engine: "mmg" }));
  assert.strictEqual(engineState().mmg, "loading");
});
