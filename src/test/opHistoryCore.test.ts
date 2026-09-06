/**
 * The operation history (`parser/opHistoryCore.ts`).
 *
 * This layer had ZERO tests before it was extracted out of the vscode-importing
 * `src/opHistory.ts` — which is exactly where the data-loss defect this file
 * guards against lived: every re-parse called `setBase`, and `setBase` wipes the
 * stack. The tests below pin both halves of the distinction that fixes it —
 * `setBase` still wipes (it is for a NEW document) and `rebase` does not (it is
 * for a re-read of the same one) — plus the cursor/snapshot invariants the class
 * already had and nothing was checking.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { OperationHistory } from "../parser/opHistoryCore";
import { parseMdpa } from "../parser/mdpaParser";
import { MdpaModel } from "../parser/types";
import { OpRecord } from "../parser/operations";

/** A unit square of two triangles, with a SubModelPart to delete. */
function model(scale = 1): MdpaModel {
  return parseMdpa(
    [
      "Begin Nodes",
      ` 1 0.0 0.0 0.0`,
      ` 2 ${scale}.0 0.0 0.0`,
      ` 3 ${scale}.0 ${scale}.0 0.0`,
      ` 4 0.0 ${scale}.0 0.0`,
      " 5 9.0 9.0 0.0", // an orphan, so removeOrphanNodes has something to do
      "End Nodes",
      "Begin Elements Element2D3N",
      " 1 0 1 2 3",
      " 2 0 1 3 4",
      "End Elements",
      "Begin SubModelPart Inlet",
      " Begin SubModelPartNodes",
      "  1",
      " End SubModelPartNodes",
      "End SubModelPart",
      "",
    ].join("\n")
  );
}

const SCALE: OpRecord = { op: "scale", sx: 2, sy: 2, sz: 2 };
const TRANSLATE: OpRecord = { op: "translate", dx: 1, dy: 0, dz: 0 };

// --- what the class always did, now actually checked ------------------------

test("current() folds the applied prefix over the base", async () => {
  const h = new OperationHistory();
  h.setBase(model());
  await h.applyNew(SCALE);
  const { model: m } = await h.current();
  // node 2 was at x=1; scaled by 2.
  assert.ok(Math.abs(m.coords[3] - 2) < 1e-6, `got ${m.coords[3]}`);
});

test("undo/redo move the cursor without dropping ops, and clamp at the ends", async () => {
  const h = new OperationHistory();
  h.setBase(model());
  await h.applyNew(SCALE);
  await h.applyNew(TRANSLATE);
  assert.equal(h.state().cursor, 2);

  h.undo();
  h.undo();
  h.undo(); // clamps
  assert.equal(h.state().cursor, 0);
  assert.equal(h.state().ops.length, 2, "undone ops stay in the list");
  assert.equal(h.state().canUndo, false);
  assert.equal(h.state().canRedo, true);

  h.redo();
  h.redo();
  h.redo(); // clamps
  assert.equal(h.state().cursor, 2);
  assert.equal(h.state().canRedo, false);
});

test("applying a new op truncates the redo tail", async () => {
  const h = new OperationHistory();
  h.setBase(model());
  await h.applyNew(SCALE);
  await h.applyNew(TRANSLATE);
  h.undo();
  await h.applyNew({ op: "removeOrphanNodes" });
  const s = h.state();
  assert.equal(s.ops.length, 2, "the undone translate was dropped");
  assert.deepEqual(s.ops.map((o) => o.op), ["scale", "removeOrphanNodes"]);
});

test("a noop op is not recorded", async () => {
  const h = new OperationHistory();
  h.setBase(model());
  const first = await h.applyNew({ op: "removeOrphanNodes" });
  assert.equal(first.noop, undefined, "there was an orphan to remove");
  const second = await h.applyNew({ op: "removeOrphanNodes" });
  assert.equal(second.noop, true, "nothing left to remove");
  assert.equal(h.state().ops.length, 1, "the noop did not join the stack");
});

test("revertTo moves the cursor but keeps the redo tail", async () => {
  const h = new OperationHistory();
  h.setBase(model());
  await h.applyNew(SCALE);
  await h.applyNew(TRANSLATE);
  h.revertTo(1);
  assert.equal(h.state().cursor, 1);
  assert.equal(h.state().ops.length, 2);
  h.revertTo(99); // clamps
  assert.equal(h.state().cursor, 2);
});

test("load installs a recipe as fully applied, without running it", () => {
  const h = new OperationHistory();
  h.setBase(model());
  h.load([SCALE, TRANSLATE]);
  const s = h.state();
  assert.equal(s.cursor, 2);
  assert.deepEqual(s.ops.map((o) => o.op), ["scale", "translate"]);
  assert.equal(s.canUndo, true);
});

test("appliedOps is the prefix, which is what a recipe save writes", async () => {
  const h = new OperationHistory();
  h.setBase(model());
  await h.applyNew(SCALE);
  await h.applyNew(TRANSLATE);
  h.undo();
  assert.deepEqual(h.appliedOps().map((o) => o.op), ["scale"]);
});

test("current() throws without a base rather than inventing one", async () => {
  const h = new OperationHistory();
  await assert.rejects(() => h.current(), /no base model/);
});

// --- setBase vs rebase: the defect and its fix ------------------------------

test("setBase still wipes the stack — it is for a NEW document", async () => {
  const h = new OperationHistory();
  h.setBase(model());
  await h.applyNew(SCALE);
  await h.applyNew(TRANSLATE);
  h.setBase(model());
  const s = h.state();
  assert.deepEqual(s.ops, []);
  assert.equal(s.cursor, 0);
  assert.equal(s.canUndo, false);
});

test("rebase KEEPS the stack, so a re-parse no longer destroys the edits", async () => {
  // The whole point: this is what every re-parse path used to do with setBase.
  const h = new OperationHistory();
  h.setBase(model());
  await h.applyNew(SCALE);
  await h.applyNew(TRANSLATE);

  h.rebase(model());
  const s = h.state();
  assert.equal(s.ops.length, 2, "the ops survived the re-parse");
  assert.equal(s.cursor, 2);
  assert.deepEqual(s.ops.map((o) => o.op), ["scale", "translate"]);
});

test("a rebase replay re-applies the ops onto the NEW file's geometry", async () => {
  const h = new OperationHistory();
  h.setBase(model(1)); // node 2 at x=1
  await h.applyNew(SCALE); // -> x=2

  h.rebase(model(3)); // the file changed on disk: node 2 now at x=3
  const r = await h.replayOntoBase();
  assert.ok(Math.abs(r.model.coords[3] - 6) < 1e-6, `expected 3*2, got ${r.model.coords[3]}`);
  assert.deepEqual(r.statuses, ["applied"]);
  assert.equal(r.applied, 1);
});

/** The same mesh as `model()` but with no orphan node — a real parse, not a hack. */
function modelWithoutOrphan(): MdpaModel {
  return parseMdpa(
    [
      "Begin Nodes",
      " 1 0.0 0.0 0.0",
      " 2 1.0 0.0 0.0",
      " 3 1.0 1.0 0.0",
      " 4 0.0 1.0 0.0",
      "End Nodes",
      "Begin Elements Element2D3N",
      " 1 0 1 2 3",
      " 2 0 1 3 4",
      "End Elements",
      "",
    ].join("\n")
  );
}

test("an op that no longer applies is kept and marked, and replay continues", async () => {
  const h = new OperationHistory();
  h.setBase(model());
  await h.applyNew({ op: "removeOrphanNodes" }); // there is an orphan to remove
  await h.applyNew(SCALE);

  // The file changed on disk and no longer has the orphan, so op 0 has nothing
  // to do. It must not take op 1 down with it.
  h.rebase(modelWithoutOrphan());
  const r = await h.replayOntoBase();

  assert.deepEqual(r.statuses, ["noop", "applied"], "replay did not stop at the noop");
  assert.ok(r.notes[0], "the op's own message is kept as the note");
  assert.equal(r.noops, 1);
  assert.ok(
    Math.abs(r.model.coords[3] - 2) < 1e-6,
    `the scale still applied, got ${r.model.coords[3]}`
  );
  const s = h.state();
  assert.equal(s.ops.length, 2, "nothing was destroyed");
  assert.equal(s.ops[0].status, "noop");
  assert.equal(s.ops[1].status, "applied");
});

test("skipAsyncOps passes over the expensive ops and marks them", async () => {
  // What makes a timeline step cheap: the geometric op follows you through
  // time, the remesh stays in the stack marked rather than re-running.
  const h = new OperationHistory();
  h.setBase(model());
  h.load([SCALE, { op: "smooth", iterations: 2 }, TRANSLATE]);

  const r = await h.replayOntoBase({ skipAsyncOps: true });
  assert.deepEqual(r.statuses, ["applied", "skipped", "applied"]);
  assert.equal(r.skipped, 1);
  // Both sync ops still landed: x = 1*2 + 1.
  assert.ok(Math.abs(r.model.coords[3] - 3) < 1e-6, `got ${r.model.coords[3]}`);

  const s = h.state();
  assert.equal(s.ops[1].status, "skipped");
  assert.equal(s.hasSkipped, true, "drives the Re-apply affordance");
});

test("a replay without skipAsyncOps clears the skipped state", async () => {
  const h = new OperationHistory();
  h.setBase(model());
  h.load([SCALE, TRANSLATE]);
  await h.replayOntoBase({ skipAsyncOps: true });
  assert.equal(h.state().hasSkipped, false, "no async op in the stack to skip");

  h.load([SCALE, { op: "smooth", iterations: 1 }]);
  await h.replayOntoBase({ skipAsyncOps: true });
  assert.equal(h.state().hasSkipped, true);
  await h.replayOntoBase();
  assert.equal(h.state().hasSkipped, false, "the re-apply ran it");
});

test("an undone op is not replayed and not marked", async () => {
  const h = new OperationHistory();
  h.setBase(model());
  await h.applyNew(SCALE);
  await h.applyNew(TRANSLATE);
  h.undo();

  h.rebase(model());
  const r = await h.replayOntoBase();
  assert.deepEqual(r.statuses, ["applied"], "only the applied prefix runs");
  assert.equal(h.state().ops[1].status, undefined, "the undone op keeps no status");
});

test("an aborted replay leaves the remaining ops unmarked rather than mislabelled", async () => {
  const h = new OperationHistory();
  h.setBase(model());
  h.load([SCALE, TRANSLATE]);
  const abort = new AbortController();
  abort.abort();
  const r = await h.replayOntoBase({ signal: abort.signal });
  assert.deepEqual(r.statuses, [], "nothing ran, so nothing is claimed");
});

test("rebase drops snapshots, since they belong to the old base", async () => {
  // A snapshot is a model computed against the PREVIOUS file. Reusing one would
  // silently mix two files' geometry into one preview.
  const h = new OperationHistory();
  h.setBase(model(1));
  await h.applyNew({ op: "smooth", iterations: 1 }); // async -> snapshotted
  await h.applyNew(SCALE);

  h.rebase(model(3));
  const r = await h.replayOntoBase({ skipAsyncOps: true });
  // If the snapshot had survived, the scale would have folded onto the OLD
  // geometry (x=1) instead of the new one (x=3).
  assert.ok(Math.abs(r.model.coords[3] - 6) < 1e-6, `expected 3*2, got ${r.model.coords[3]}`);
});

test("clear wipes the stack but keeps the base usable", async () => {
  const h = new OperationHistory();
  h.setBase(model());
  await h.applyNew(SCALE);
  h.clear();
  assert.equal(h.state().ops.length, 0);
  assert.equal(h.hasBase(), true);
  const { model: m } = await h.current();
  assert.ok(Math.abs(m.coords[3] - 1) < 1e-6, "back to the pristine base");
});

test("state() reports appliedCount and the flags the sidebar renders", async () => {
  const h = new OperationHistory();
  h.setBase(model());
  assert.equal(h.appliedCount(), 0);
  await h.applyNew(SCALE);
  assert.equal(h.appliedCount(), 1);
  const s = h.state();
  assert.equal(s.ops[0].label.length > 0, true, "a human label for the history row");
  assert.equal(s.hasSkipped, false);
});

// --- the invariants the provider wiring depends on -------------------------

test("a rebase at cursor 0 keeps the redo tail that setBase would destroy", async () => {
  // Both providers used to choose between setBase and rebase on
  // `appliedCount()` — the CURSOR — so with every op undone, ANY re-parse (a
  // watcher tick because a solver appended a step, an explicit Reload, one VTK
  // timeline arrow-key) took the setBase path and reset `ops` along with the
  // cursor. `state()` went on shipping those rows and `canRedo`, and the
  // sidebar went on labelling them "Redo up to this step", so the UI offered a
  // redo that silently did nothing. A re-read of the same document is not a
  // new document; the providers now ask `hasBase()`.
  const h = new OperationHistory();
  h.setBase(model(1));
  await h.applyNew(SCALE);
  await h.applyNew(TRANSLATE);
  h.undo();
  h.undo();
  assert.equal(h.appliedCount(), 0, "the condition the providers used to branch on");
  assert.equal(h.state().canRedo, true);

  h.rebase(model(1));
  assert.deepEqual(
    h.state().ops.map((o) => o.op),
    ["scale", "translate"],
    "the tail survives the re-parse"
  );
  assert.equal(h.state().canRedo, true, "the redo the sidebar offers still exists");

  // And it is a live redo, not a dead row: it re-applies onto the CURRENT base.
  h.redo();
  const { model: m } = await h.current();
  assert.ok(Math.abs(m.coords[3] - 2) < 1e-6, `expected 1*2, got ${m.coords[3]}`);
});

test("at cursor 0 the replayed model is the bare base, tail or no tail", async () => {
  // Why a provider may post the freshly parsed model DIRECTLY rather than route
  // a zero-op replay through replayWithProgress: with nothing applied, a
  // rebase-with-tail and a fresh setBase render the identical mesh, and the
  // difference is confined to the opState message. Without this licence every
  // watcher tick would flash the cancellable "Re-applying operations…" toast.
  const a = new OperationHistory();
  a.setBase(model(1));
  await a.applyNew(SCALE);
  a.undo();
  a.rebase(model(3));
  const viaRebase = await a.replayOntoBase();

  const b = new OperationHistory();
  b.setBase(model(3));
  const viaSetBase = await b.current();

  assert.deepEqual(viaRebase.statuses, [], "nothing applied ran, so nothing is marked");
  assert.equal(viaRebase.applied + viaRebase.noops + viaRebase.skipped, 0);
  assert.deepEqual(Array.from(viaRebase.model.coords), Array.from(viaSetBase.model.coords));
  assert.equal(a.state().ops.length, 1, "…while the tail is the one thing that differs");
});

test("setBase discards the redo TAIL too, not just the applied prefix", async () => {
  // The neighbour above covers an APPLIED stack; this covers the tail, which
  // is what the providers' rewiring must not start preserving by accident.
  // A genuinely new base has no history to redo into.
  const h = new OperationHistory();
  h.setBase(model(1));
  await h.applyNew(SCALE);
  h.undo();
  h.setBase(model(3));
  assert.deepEqual(h.state().ops, []);
  assert.equal(h.state().canRedo, false);
  assert.equal(h.appliedCount(), 0);
});

test("a rebase with an empty stack is indistinguishable from a fresh setBase", async () => {
  // The common case, and the reason wiring rebase into every re-parse path is
  // zero-risk: with no edits applied there is nothing to replay and nothing to
  // preserve, so the reloaded file is shown exactly as it is on disk.
  const a = new OperationHistory();
  a.setBase(model(1));
  a.rebase(model(3));
  const viaRebase = await a.replayOntoBase();

  const b = new OperationHistory();
  b.setBase(model(3));
  const viaSetBase = await b.current();

  assert.equal(viaRebase.statuses.length, 0);
  assert.deepEqual(Array.from(viaRebase.model.coords), Array.from(viaSetBase.model.coords));
  assert.deepEqual(a.state().ops, b.state().ops);
});

test("repeated rebases stay idempotent rather than compounding", async () => {
  // Watcher ticks can arrive in a burst; each one re-applies the SAME stack to
  // the file's contents, so the result must not drift with the tick count.
  const h = new OperationHistory();
  h.setBase(model(1));
  await h.applyNew(SCALE); // x: 1 -> 2

  for (let i = 0; i < 3; i++) {
    h.rebase(model(1));
    const r = await h.replayOntoBase();
    assert.ok(
      Math.abs(r.model.coords[3] - 2) < 1e-6,
      `pass ${i}: expected 2, got ${r.model.coords[3]}`
    );
  }
  assert.equal(h.state().ops.length, 1, "the stack did not grow");
});

// --- applyMany: sequential batch apply, per-substep undo ---------------------
//
// applyMany is a thin loop over applyNew, called N times — each step is its
// own independently atomic push, not one all-or-nothing transaction. A genuine
// throw from applyOpAsync mid-loop would propagate out of applyMany while
// earlier steps' commits stand (each applyNew call already returned before the
// next one starts) — this follows directly from the loop's structure and is
// not separately tested here: every op in this codebase converts a real
// failure into a noop internally (the same "no failed state" design the class
// header describes for applyNew), so there is no legitimate OpRecord that
// reaches this code path and actually throws.

test("applyMany applies several ops as separate, independently-undoable entries", async () => {
  const h = new OperationHistory();
  h.setBase(model());
  const r = await h.applyMany([SCALE, TRANSLATE, { op: "removeOrphanNodes" }]);
  assert.equal(r.appliedCount, 3);
  assert.equal(r.noopCount, 0);
  assert.equal(r.stoppedEarly, false);
  const s = h.state();
  assert.deepEqual(s.ops.map((o) => o.op), ["scale", "translate", "removeOrphanNodes"]);
  assert.equal(s.cursor, 3);
});

test("a noop step does not stop the sequence and is not recorded", async () => {
  const h = new OperationHistory();
  h.setBase(model());
  const r = await h.applyMany([
    { op: "removeOrphanNodes" }, // applies — there is one orphan
    { op: "removeOrphanNodes" }, // noop — nothing left
    SCALE, // still runs
  ]);
  assert.equal(r.appliedCount, 2);
  assert.equal(r.noopCount, 1);
  assert.deepEqual(
    h.state().ops.map((o) => o.op),
    ["removeOrphanNodes", "scale"],
    "the noop step did not join the stack, but scale after it still ran"
  );
});

test("an already-aborted signal stops before any step runs", async () => {
  const h = new OperationHistory();
  h.setBase(model());
  const controller = new AbortController();
  controller.abort();
  const r = await h.applyMany([SCALE, TRANSLATE], { signal: controller.signal });
  assert.equal(r.stoppedEarly, true);
  assert.equal(r.appliedCount, 0);
  assert.equal(h.state().ops.length, 0);
});

test("aborting mid-sequence keeps earlier steps applied", async () => {
  const h = new OperationHistory();
  h.setBase(model());
  const controller = new AbortController();
  const r = await h.applyMany([SCALE, TRANSLATE, { op: "removeOrphanNodes" }], {
    signal: controller.signal,
    // Fires just before each step; abort once the first step is about to run
    // so the SECOND iteration's pre-check stops the sequence there.
    onStepProgress: (i) => {
      if (i === 0) controller.abort();
    },
  });
  assert.equal(r.stoppedEarly, true);
  assert.equal(r.appliedCount, 1);
  assert.deepEqual(h.state().ops.map((o) => o.op), ["scale"]);
});

test("undo after applyMany removes exactly one step at a time", async () => {
  const h = new OperationHistory();
  h.setBase(model());
  await h.applyMany([SCALE, TRANSLATE, { op: "removeOrphanNodes" }]);
  assert.equal(h.state().cursor, 3);
  h.undo();
  assert.deepEqual(h.state().ops.map((o) => o.op), ["scale", "translate", "removeOrphanNodes"]);
  assert.equal(h.state().cursor, 2, "only the last step was undone");
  h.undo();
  assert.equal(h.state().cursor, 1);
});

test("applyMany after an undo truncates the old redo tail once, like a single applyNew", async () => {
  const h = new OperationHistory();
  h.setBase(model());
  await h.applyNew(SCALE);
  await h.applyNew(TRANSLATE);
  h.undo(); // cursor back to 1 (scale), translate is now a redo tail
  const r = await h.applyMany([{ op: "removeOrphanNodes" }, SCALE]);
  assert.equal(r.appliedCount, 2);
  assert.deepEqual(
    h.state().ops.map((o) => o.op),
    ["scale", "removeOrphanNodes", "scale"],
    "the old redo tail (translate) is gone, not left dangling past the new steps"
  );
});
