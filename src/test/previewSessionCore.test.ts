import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  bindSessionFileState,
  dirtyPanelTitle,
  flagsForBind,
  initialSessionFileState,
  sessionFileName,
  sessionTitleFor,
} from "../parser/previewSessionCore";

describe("previewSessionCore", () => {
  test("starts unbound and binds with a basename", () => {
    assert.deepEqual(initialSessionFileState(), { bound: false });
    const bound = bindSessionFileState("/tmp/case/double_arch.mdpa");
    assert.equal(bound.bound, true);
    if (bound.bound) {
      assert.equal(bound.fsPath, "/tmp/case/double_arch.mdpa");
      assert.equal(bound.fileName, "double_arch.mdpa");
      assert.equal(sessionTitleFor(bound, "Kratos Preview"), "double_arch.mdpa");
    }
    assert.equal(sessionTitleFor(initialSessionFileState(), "Kratos Preview"), "Kratos Preview");
  });

  test("first bind starts clean", () => {
    const { flags, historyReset } = flagsForBind(undefined, "/a/b.mdpa", {
      userForcedFull: true,
      summaryShown: true,
    });
    assert.deepEqual(flags, { userForcedFull: false, summaryShown: false });
    assert.equal(historyReset, false);
  });

  test("re-binding the same file preserves view flags and history", () => {
    const { flags, historyReset } = flagsForBind("/a/b.mdpa", "/a/b.mdpa", {
      userForcedFull: true,
      summaryShown: true,
    });
    assert.deepEqual(flags, { userForcedFull: true, summaryShown: true });
    assert.equal(historyReset, false);
  });

  test("binding a different file resets flags and history", () => {
    const { flags, historyReset } = flagsForBind("/a/b.mdpa", "/a/c.vtu", {
      userForcedFull: true,
      summaryShown: true,
    });
    assert.deepEqual(flags, { userForcedFull: false, summaryShown: false });
    assert.equal(historyReset, true);
  });

  test("dirty title suffixes once and cleans", () => {
    assert.equal(dirtyPanelTitle("Kratos Preview", true), "Kratos Preview •");
    assert.equal(dirtyPanelTitle("Kratos Preview •", true), "Kratos Preview •");
    assert.equal(dirtyPanelTitle("Kratos Preview •", false), "Kratos Preview");
    assert.equal(sessionFileName("C:\\case\\mesh.vtu"), "mesh.vtu");
  });
});
