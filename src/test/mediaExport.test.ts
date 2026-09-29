import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Module from "node:module";

test("shared provider screenshot writer saves exact bytes, handles cancellation and reports write errors", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdpa-screenshot-"));
  const loader = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown };
  const original = loader._load;
  let destination: string | undefined;
  const errors: string[] = [];
  loader._load = function(name, ...args) {
    if (name === "vscode") return {
      Uri: { file: (fsPath: string) => ({ fsPath }) },
      window: {
        showSaveDialog: async () => destination ? { fsPath: destination } : undefined,
        showErrorMessage: (message: string) => { errors.push(message); },
      },
    };
    return original.call(this, name, ...args);
  };
  try {
    const { saveScreenshot } = require("../mediaExport") as typeof import("../mediaExport");
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const data = `data:image/png;base64,${bytes.toString("base64")}`;
    await saveScreenshot(data, path.join(dir, "mesh.mdpa"));
    assert.deepEqual(fs.readdirSync(dir), []);
    destination = path.join(dir, "mesh.png");
    await saveScreenshot(data, path.join(dir, "mesh.mdpa"));
    assert.deepEqual(fs.readFileSync(destination), bytes);
    destination = path.join(dir, "missing", "mesh.png");
    await saveScreenshot(data, path.join(dir, "mesh.vtu"));
    assert.match(errors[0], /Could not save screenshot/);
    for (const provider of ["mdpaEditorProvider.ts", "vtkEditorProvider.ts"]) {
      const source = fs.readFileSync(path.resolve(__dirname, "../../src", provider), "utf8");
      assert.match(source, /saveScreenshot\(msg.data as string, fsPath\)/);
    }
  } finally {
    loader._load = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
