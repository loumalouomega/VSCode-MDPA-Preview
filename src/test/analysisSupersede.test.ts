import { test } from "node:test";
import assert from "node:assert/strict";

import { createSupersedingRunner } from "../analysisSupersede";

/** A run whose settlement the test controls. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("a newer run aborts the older one and only the newer value is returned", async () => {
  const runner = createSupersedingRunner();
  const first = deferred<string>();
  const second = deferred<string>();
  let firstSignal!: AbortSignal;
  const a = runner.run((signal) => { firstSignal = signal; return first.promise; });
  const b = runner.run(() => second.promise);
  assert.equal(firstSignal.aborted, true);
  // The superseded run settles late, successfully: its value is dropped.
  first.resolve("old");
  second.resolve("new");
  assert.equal(await a, undefined);
  assert.equal(await b, "new");
});

test("a late failure of a superseded run is swallowed, a current failure propagates", async () => {
  const runner = createSupersedingRunner();
  const first = deferred<string>();
  const a = runner.run(() => first.promise);
  const b = runner.run(async () => "fine");
  first.reject(new Error("late boom"));
  assert.equal(await a, undefined);
  assert.equal(await b, "fine");
  await assert.rejects(runner.run(async () => { throw new Error("current boom"); }), /current boom/);
});

test("cancel() aborts the current run and drops its result", async () => {
  const runner = createSupersedingRunner();
  const d = deferred<number>();
  let signal!: AbortSignal;
  const run = runner.run((s) => { signal = s; return d.promise; });
  runner.cancel();
  assert.equal(signal.aborted, true);
  d.resolve(1);
  assert.equal(await run, undefined);
  // Nothing in flight: cancel is a no-op, and the runner stays usable.
  runner.cancel();
  assert.equal(await runner.run(async () => 2), 2);
});
