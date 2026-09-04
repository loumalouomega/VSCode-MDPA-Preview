import { test } from "node:test";
import assert from "node:assert";
import * as path from "node:path";

import {
  RECENT_CAP,
  RecentMesh,
  parseRecentList,
  pruneMissing,
  recentDescription,
  recentKey,
  recentLabel,
  recordRecent,
  removeRecent,
} from "../recentMeshesCore";

const abs = (...parts: string[]): string => path.resolve("/tmp", ...parts);
const entry = (p: string, t = 0): RecentMesh => ({ path: p, openedAt: t });

test("recordRecent puts the newest first", () => {
  let list: RecentMesh[] = [];
  list = recordRecent(list, abs("a.mdpa"), 1);
  list = recordRecent(list, abs("b.vtu"), 2);
  assert.deepStrictEqual(
    list.map((e) => path.basename(e.path)),
    ["b.vtu", "a.mdpa"]
  );
  assert.strictEqual(list[0].openedAt, 2);
});

test("re-opening moves an entry to the front rather than duplicating it", () => {
  let list = recordRecent(recordRecent([], abs("a.mdpa"), 1), abs("b.vtu"), 2);
  list = recordRecent(list, abs("a.mdpa"), 3);
  assert.strictEqual(list.length, 2);
  assert.strictEqual(path.basename(list[0].path), "a.mdpa");
  assert.strictEqual(list[0].openedAt, 3, "the timestamp is refreshed");
});

test("a relative path is stored resolved, and matches its absolute twin", () => {
  const list = recordRecent([], "./mesh.mdpa", 1);
  assert.ok(path.isAbsolute(list[0].path));
  const again = recordRecent(list, path.resolve("mesh.mdpa"), 2);
  assert.strictEqual(again.length, 1, "the two spellings are one entry");
});

test("the cap drops the oldest", () => {
  let list: RecentMesh[] = [];
  for (let i = 0; i < RECENT_CAP + 5; i++) list = recordRecent(list, abs(`m${i}.mdpa`), i);
  assert.strictEqual(list.length, RECENT_CAP);
  assert.strictEqual(path.basename(list[0].path), `m${RECENT_CAP + 4}.mdpa`);
  assert.ok(!list.some((e) => e.path.endsWith("m0.mdpa")));
});

test("case folding is win32-only", () => {
  // One file on Windows, two on Linux — folding everywhere would silently merge
  // two genuinely distinct meshes on the platform Kratos mostly runs on.
  assert.strictEqual(
    recentKey("/data/Mesh.mdpa", "win32"),
    recentKey("/data/mesh.mdpa", "win32")
  );
  assert.notStrictEqual(
    recentKey("/data/Mesh.mdpa", "linux"),
    recentKey("/data/mesh.mdpa", "linux")
  );
  const folded = recordRecent([entry("/data/Mesh.mdpa")], "/data/mesh.mdpa", 1, 10, "win32");
  assert.strictEqual(folded.length, 1);
  const distinct = recordRecent([entry("/data/Mesh.mdpa")], "/data/mesh.mdpa", 1, 10, "linux");
  assert.strictEqual(distinct.length, 2);
});

test("removeRecent drops exactly one entry", () => {
  const list = [entry(abs("a.mdpa")), entry(abs("b.mdpa"))];
  const after = removeRecent(list, abs("a.mdpa"));
  assert.deepStrictEqual(after.map((e) => path.basename(e.path)), ["b.mdpa"]);
  assert.deepStrictEqual(removeRecent(list, abs("nope.mdpa")).length, 2);
});

test("pruneMissing uses the injected existence check", () => {
  const list = [entry("/gone.mdpa"), entry("/here.mdpa")];
  const kept = pruneMissing(list, (p) => p === "/here.mdpa");
  assert.deepStrictEqual(kept.map((e) => e.path), ["/here.mdpa"]);
});

test("parseRecentList tolerates whatever globalState holds", () => {
  assert.deepStrictEqual(parseRecentList(undefined), []);
  assert.deepStrictEqual(parseRecentList("nonsense"), []);
  assert.deepStrictEqual(parseRecentList([null, 3, {}, { path: "" }]), []);
  // A malformed neighbour must not lose the valid entries beside it.
  assert.deepStrictEqual(parseRecentList([{ path: "/a" }, null, { path: "/b", openedAt: 7 }]), [
    { path: "/a", openedAt: 0 },
    { path: "/b", openedAt: 7 },
  ]);
});

test("labels and descriptions", () => {
  assert.strictEqual(recentLabel("/data/cases/bar.mdpa"), "bar.mdpa");
  assert.strictEqual(recentDescription("/data/cases/bar.mdpa"), "/data/cases");
  assert.strictEqual(recentDescription("/home/me/x/bar.mdpa", "/home/me"), "~/x");
  assert.strictEqual(recentDescription("/home/me/bar.mdpa", "/home/me"), "~");
  // A path merely sharing a prefix is not inside $HOME.
  assert.strictEqual(recentDescription("/home/melissa/bar.mdpa", "/home/me"), "/home/melissa");
});
