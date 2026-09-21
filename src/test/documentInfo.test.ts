import { test } from "node:test";
import assert from "node:assert";

import { DocumentInfoMessage, DocumentInfoReporter, documentFormat } from "../documentInfo";
import type { OpRecord } from "../parser/operations";

const last = <T>(xs: T[]): T => xs[xs.length - 1];
const op = (name: string): OpRecord => ({ op: name }) as unknown as OpRecord;

/** A stand-in for OperationHistory: just the applied list. */
class FakeHistory {
  applied: OpRecord[] = [];
  appliedOps(): OpRecord[] {
    return this.applied.slice();
  }
}

function setup(file = "/data/double_arch.mdpa") {
  const history = new FakeHistory();
  const posted: DocumentInfoMessage[] = [];
  const reporter = new DocumentInfoReporter(file, history, (m) => posted.push(m));
  return { history, posted, reporter };
}

test("the format badge follows the router's longest-suffix rule", () => {
  assert.strictEqual(documentFormat("/a/b/case.mdpa"), "mdpa");
  assert.strictEqual(documentFormat("/a/b/CASE.VTK"), "vtk");
  assert.strictEqual(documentFormat("/a/b/case.post.msh"), "post.msh");
  assert.strictEqual(documentFormat("/a/b/case.msh"), "msh");
  assert.strictEqual(documentFormat("/a/b/README"), null);
});

test("a fresh document reports its name, path and format, clean", () => {
  const { reporter } = setup("/data/double_arch.mdpa");
  assert.deepStrictEqual(reporter.build(), {
    type: "documentInfo",
    name: "double_arch.mdpa",
    path: "/data/double_arch.mdpa",
    format: "mdpa",
    dirty: false,
    unsavedEdits: 0,
  });
});

test("sync is deduplicated, and force re-posts for a reloaded page", () => {
  const { reporter, posted } = setup();
  reporter.sync();
  reporter.sync();
  assert.strictEqual(posted.length, 1);
  reporter.sync(true);
  assert.strictEqual(posted.length, 2);
});

test("applying ops marks the chip dirty with a count; undo back to the save point clears it", () => {
  const { reporter, history, posted } = setup();
  const remesh = op("remesh");
  reporter.sync();
  history.applied = [remesh];
  reporter.sync();
  assert.deepStrictEqual([last(posted).dirty, last(posted).unsavedEdits], [true, 1]);
  history.applied = [remesh, op("smooth")];
  reporter.sync();
  assert.strictEqual(last(posted).unsavedEdits, 2);
  // Undo both: nothing differs from the file any more.
  history.applied = [];
  reporter.sync();
  assert.deepStrictEqual([last(posted).dirty, last(posted).unsavedEdits], [false, 0]);
});

test("a save moves the save point; undoing past it counts what the file has and the view lacks", () => {
  const { reporter, history, posted } = setup();
  const a = op("a");
  const b = op("b");
  history.applied = [a, b];
  reporter.sync();
  assert.strictEqual(last(posted).unsavedEdits, 2);
  reporter.markSaved();
  assert.deepStrictEqual([last(posted).dirty, last(posted).unsavedEdits], [false, 0]);
  history.applied = [a];
  reporter.sync();
  assert.deepStrictEqual([last(posted).dirty, last(posted).unsavedEdits], [true, 1]);
  // Redo lands back on the saved state.
  history.applied = [a, b];
  reporter.sync();
  assert.strictEqual(last(posted).dirty, false);
});

test("reverting the file drops the save point along with the stack", () => {
  const { reporter, history, posted } = setup();
  const a = op("a");
  history.applied = [a];
  reporter.markSaved();
  history.applied = [];
  reporter.sync();
  assert.strictEqual(last(posted).unsavedEdits, 1);
  reporter.markReverted();
  assert.deepStrictEqual([last(posted).dirty, last(posted).unsavedEdits], [false, 0]);
});
