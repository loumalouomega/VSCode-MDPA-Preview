import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { PREPARATION_FILE, writePreparedCase } from "../problemtype/preparation";
import { structural } from "../problemtype/builtins/structural";
import { defaultCaseState } from "../problemtype/api";
import { generateCase } from "../problemtype/generate";
import { parseMdpa } from "../parser/mdpaParser";

test("preparation contract records effective inputs, revisions and omitted unit checks", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "preparation-"));
  try {
    const meshPath = path.join(directory, "beam.mdpa");
    fs.writeFileSync(meshPath, "Begin Nodes\n1 0 0 0\nEnd Nodes\n");
    const state = defaultCaseState(structural.decl);
    const generated = await generateCase(structural, parseMdpa(fs.readFileSync(meshPath, "utf8")), state, "beam");
    const result = writePreparedCase({ directory, sourcePath: meshPath, solverMeshPath: meshPath, runtime: structural, state, generated, warnings: ["Boundary coverage unavailable"] });
    assert.equal(result.preparation.version, 1);
    assert.equal(result.preparation.units.state, "undeclared");
    assert.equal(result.preparation.findings[0].message, "Boundary coverage unavailable");
    assert.deepEqual(result.preparation.effectiveParameters, JSON.parse(generated.projectParameters));
    assert.ok(!JSON.stringify(result.preparation).includes(directory));
    for (const input of result.preparation.inputs) {
      assert.equal(input.revision, createHash("sha256").update(fs.readFileSync(path.join(directory, input.name))).digest("hex"));
    }
    fs.writeFileSync(path.join(directory, PREPARATION_FILE), '{"version":99}');
    fs.writeFileSync(path.join(directory, "MainKratos.py"), "retained");
    assert.throws(() => writePreparedCase({ directory, sourcePath: meshPath, solverMeshPath: meshPath, runtime: structural, state, generated, warnings: [] }), /Unsupported preparation/);
    assert.equal(fs.readFileSync(path.join(directory, "MainKratos.py"), "utf8"), "retained");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
