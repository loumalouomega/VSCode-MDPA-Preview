import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { writeOpsBackup, readOpsBackup, deleteOpsBackup } from "../parser/opsBackup";
import { OpRecord } from "../parser/operations";

const tmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "opsbackup-"));

const OPS: OpRecord[] = [
  { op: "mergeNodes", tolerance: 1e-6 },
  { op: "scale", sx: 2, sy: 2, sz: 2 },
  { op: "removeOrphanNodes" },
];

test("a backup round-trips the applied operations", async () => {
  const dest = path.join(tmpDir(), "backup.json");
  await writeOpsBackup(dest, OPS, "cube.mdpa");

  const back = await readOpsBackup(dest);
  assert.ok(back, "the backup should read back");
  assert.deepEqual(back.operations, OPS);
  assert.deepEqual(back.warnings, []);

  // It is the same recipe format `saveOps` writes, not a backup-only variant.
  const raw = JSON.parse(fs.readFileSync(dest, "utf8"));
  assert.equal(raw.source, "cube.mdpa");
  assert.ok(Array.isArray(raw.operations));
});

test("the destination's parent directory is created", async () => {
  // CustomDocumentBackupContext.destination points into storagePath, whose
  // parent folder the API says may not exist yet.
  const dest = path.join(tmpDir(), "does", "not", "exist", "backup.json");
  await writeOpsBackup(dest, OPS, "cube.mdpa");
  assert.ok(fs.existsSync(dest));
});

test("a missing or corrupt backup is undefined, never a throw", async () => {
  const dir = tmpDir();

  assert.equal(await readOpsBackup(path.join(dir, "absent.json")), undefined);

  const garbage = path.join(dir, "garbage.json");
  fs.writeFileSync(garbage, "not json at all {{{", "utf8");
  assert.equal(await readOpsBackup(garbage), undefined);

  // Valid JSON, no recognisable recipe — still nothing to restore.
  const wrongShape = path.join(dir, "wrong.json");
  fs.writeFileSync(wrongShape, JSON.stringify({ hello: "world" }), "utf8");
  assert.equal(await readOpsBackup(wrongShape), undefined);

  // A recipe whose every op is unknown parses, warns, and yields nothing —
  // callers get one emptiness test rather than two.
  const unknown = path.join(dir, "unknown.json");
  fs.writeFileSync(
    unknown,
    JSON.stringify({ version: 1, source: "x.mdpa", operations: [{ op: "teleport" }] }),
    "utf8"
  );
  assert.equal(await readOpsBackup(unknown), undefined);
});

test("a partly-unreadable recipe keeps what it could and reports the rest", async () => {
  const dest = path.join(tmpDir(), "mixed.json");
  fs.writeFileSync(
    dest,
    JSON.stringify({
      version: 1,
      source: "x.mdpa",
      operations: [{ op: "removeOrphanNodes" }, { op: "teleport" }],
    }),
    "utf8"
  );
  const back = await readOpsBackup(dest);
  assert.ok(back);
  assert.deepEqual(back.operations, [{ op: "removeOrphanNodes" }]);
  assert.ok(back.warnings.length > 0, "the dropped op should be named");
});

test("delete removes the backup and is safe to call twice", async () => {
  const dest = path.join(tmpDir(), "backup.json");
  await writeOpsBackup(dest, OPS, "cube.mdpa");
  assert.ok(fs.existsSync(dest));

  deleteOpsBackup(dest);
  deleteOpsBackup(dest);
  // Fire-and-forget by contract (delete() returns void), so poll for it to
  // settle. windows-latest CI reproduced a failure here where 50 ms was not
  // enough — the delete rides internal retries under a transient win32 EPERM —
  // so the bound is hundreds of times the retry ladder's worst case, and the
  // fail message names the path rather than asserting a bare boolean.
  const deadline = Date.now() + 3000;
  while (fs.existsSync(dest) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(fs.existsSync(dest), false, `backup ${dest} should be gone after delete()`);
});
