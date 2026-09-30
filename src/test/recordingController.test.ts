import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import Module from "node:module";
import { RecordingCommand, RecordingReply } from "../parser/recordSession";

test("shared provider controller correlates save cancellation and write errors without losing drafts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "record-controller-"));
  const loader = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown };
  const original = loader._load;
  let destination: string | undefined;
  loader._load = function(name, ...args) {
    if (name === "vscode") return { Uri: { file: (fsPath: string) => ({ fsPath }) }, window: { showSaveDialog: async () => destination ? { fsPath: destination } : undefined, showOpenDialog: async () => undefined } };
    return original.call(this, name, ...args);
  };
  try {
    const { RecordingController } = require("../recordingController") as typeof import("../recordingController");
    const { DEFAULT_RECORD_SETTINGS } = require("../parser/recordPlan");
    const { DEFAULT_CAPTURE_SETTINGS } = require("../parser/capturePlan");
    let resolve: (m: RecordingReply) => void = () => {};
    const controller = new RecordingController(root, "/mesh.mdpa", m => resolve(m as RecordingReply));
    let serial = 0;
    const request = (command: RecordingCommand): Promise<RecordingReply> => new Promise(r => { const id = ++serial; resolve = m => { assert.equal(m.requestId, id); r(m); }; controller.receive({ type: "recording", requestId: id, command }); });
    const created = await request({ op: "create", settings: DEFAULT_RECORD_SETTINGS, capture: DEFAULT_CAPTURE_SETTINGS, width: 32, height: 24 });
    const id = (created.result as { id: string }).id;
    assert.equal((await request({ op: "encodeBegin", id, format: "gif" })).result, false);
    assert.deepEqual((await request({ op: "png", id })).result, { cancelled: true });
    destination = path.join(root, "missing", "out.gif");
    assert.match((await request({ op: "encodeBegin", id, format: "gif" })).error!, /ENOENT/);
    assert.equal(((await request({ op: "list" })).result as unknown[]).length, 1);
    controller.dispose();
    for (const provider of ["mdpaEditorProvider.ts", "vtkEditorProvider.ts"]) {
      const source = await fs.readFile(path.resolve(__dirname, "../../src", provider), "utf8");
      assert.match(source, /new RecordingController/); assert.doesNotMatch(source, /pendingFrames/);
    }
  } finally { loader._load = original; await fs.rm(root, { recursive: true, force: true }); }
});
