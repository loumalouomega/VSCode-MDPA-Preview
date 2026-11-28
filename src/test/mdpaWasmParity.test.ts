import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  MdpaSummaryScanner,
  parseMdpa,
  parseMdpaFile,
  parseMdpaFileTs,
  parseMdpaTs,
} from "../parser/mdpaParser";
import { writeMdpa, writeMdpaTs } from "../parser/writers/mdpaWriter";
import {
  isMdpaWasmAvailable,
  parseMdpaFileWasm,
  parseMdpaWasm,
  scanMdpaBytesWasm,
  writeMdpaWasm,
} from "../parser/mdpaWasm";
import type { MdpaModel } from "../parser/types";

const REPO_ROOT = path.resolve(__dirname, "../..");

function collectMdpaFixtures(): string[] {
  const roots = [
    path.join(REPO_ROOT, "src/test/fixtures"),
    path.join(REPO_ROOT, "example/MDPA"),
  ];
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.toLowerCase().endsWith(".mdpa")) files.push(full);
    }
  };
  for (const r of roots) walk(r);
  files.sort();
  return files;
}

/**
 * Normalize an MdpaModel for strict structural comparison:
 * converts `Object.create(null)` property maps to plain objects with key-order
 * preserved so `assert.deepEqual` checks exact equality without prototype noise.
 */
function normalizeModel(m: MdpaModel): unknown {
  return {
    ...m,
    properties: m.properties?.map((p) => ({
      id: p.id,
      variableOrder: Object.keys(p.variables),
      variables: { ...p.variables },
      tables: p.tables,
    })),
  };
}

test("mdpa-core WASM module is loaded and available", () => {
  assert.equal(isMdpaWasmAvailable(), true, "mdpa-core WASM must be built and loadable");
});

test("parseMdpa & writeMdpa parity across every committed .mdpa fixture", () => {
  const fixtures = collectMdpaFixtures();
  assert.ok(fixtures.length >= 15, `expected >= 15 fixtures, found ${fixtures.length}`);

  for (const file of fixtures) {
    const rel = path.relative(REPO_ROOT, file);
    const text = fs.readFileSync(file, "utf8");

    const tsModel = parseMdpaTs(text);
    const wasmModel = parseMdpaWasm(text);
    assert.deepEqual(
      normalizeModel(wasmModel),
      normalizeModel(tsModel),
      `${rel}: parsed MdpaModel must match TS oracle`
    );

    const tsOut = writeMdpaTs(tsModel);
    const wasmOut = writeMdpaWasm(wasmModel);
    assert.equal(wasmOut, tsOut, `${rel}: writeMdpa output must be byte-identical`);

    const tsOutWithSrc = writeMdpaTs(tsModel, { sourceText: text });
    const wasmOutWithSrc = writeMdpaWasm(wasmModel, { sourceText: text });
    assert.equal(
      wasmOutWithSrc,
      tsOutWithSrc,
      `${rel}: writeMdpa(sourceText) output must be byte-identical`
    );

    // Round-trip parity (also exercises default parseMdpa / writeMdpa entry points)
    const tsRound = parseMdpaTs(tsOut);
    const wasmRound = parseMdpa(writeMdpa(wasmModel));
    assert.deepEqual(
      normalizeModel(wasmRound),
      normalizeModel(tsRound),
      `${rel}: round-trip MdpaModel must match TS oracle`
    );

    // Summary scanner parity
    const tsScanner = new MdpaSummaryScanner();
    for (const line of text.split(/\r?\n/)) tsScanner.feedLine(line);
    const tsScan = tsScanner.finish();
    const wasmScan = scanMdpaBytesWasm(Buffer.from(text, "utf8"));
    assert.deepEqual(wasmScan, tsScan, `${rel}: MdpaSummaryScanner must match TS oracle`);
  }
});

test("parseMdpaFile streaming parity across representative fixtures", async () => {
  const files = [
    path.join(REPO_ROOT, "example/MDPA/bunny_test_mesh.mdpa"),
    path.join(
      REPO_ROOT,
      "src/test/fixtures/kratos/tests/auxiliar_files_for_python_unittest/mdpa_files/test_model_part_io_read.mdpa"
    ),
    path.join(REPO_ROOT, "src/test/fixtures/applications/MetisApplication/tests/cube.mdpa"),
  ];

  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file);
    const progressCalls: Array<{ bytesRead: number; totalBytes: number }> = [];
    const tsModel = await parseMdpaFileTs(file);
    const wasmModel = await parseMdpaFile(file, (_phase, bytesRead, totalBytes) => {
      progressCalls.push({ bytesRead, totalBytes });
    });
    assert.deepEqual(
      normalizeModel(wasmModel),
      normalizeModel(tsModel),
      `${rel}: streamed MdpaModel must match TS oracle`
    );
    assert.ok(progressCalls.length >= 1, `${rel}: progress callback fired`);
    const last = progressCalls[progressCalls.length - 1];
    assert.equal(last.bytesRead, last.totalBytes, `${rel}: final progress reaches 100%`);
  }
});

test("edge cases: diagnostics, Properties trap door, Constraints, ragged fields, __proto__", () => {
  const cases: { name: string; text: string }[] = [
    { name: "empty", text: "" },
    { name: "comments only", text: "// hello\n   // world\r\n" },
    {
      name: "diagnostics & unclosed blocks",
      text: [
        "1 0 0 0",
        "Begin",
        "End Something",
        "End Stray",
        "Begin UnknownBlock foo",
        "  ignored line",
        "End UnknownBlock",
        "Begin Nodes",
        "  1 0.0 0.0", // short node line
        "  2 1.0 2.0 3.0",
        "End Conditions", // mismatch
        "Begin SubModelPartNodes", // outside SubModelPart
        "  2",
        "End SubModelPartNodes",
        "Begin Nodes", // unclosed at EOF
      ].join("\n"),
    },
    {
      name: "Properties trap door, duplicate, bad id, vector/matrix, __proto__",
      text: [
        "Begin Properties",
        "  DENSITY 1000",
        "End Properties",
        "Begin Properties 1",
        "  DENSITY 3.4E-5 // scalar",
        "  IS_RESTARTED 1",
        "  COMPUTE_LUMPED_MASS_MATRIX False",
        "  __proto__ 42",
        "  CONSTITUTIVE_LAW LinearElastic3DLaw",
        "  VOLUME_ACCELERATION [3] (0.00, 0.00, -9.81)",
        "  BAD_VEC [3] (1.0, 2.0)",
        "  BROKEN_VEC [3] not_a_vec",
        "  LOCAL_INERTIA_TENSOR [3,3] ((0,0.27,0.27),(0.27,0,0.27),(0.27,0.27,0))",
        "  BAD_MAT [2,2] ((1,2,3))",
        "  Begin Table TEMPERATURE VISCOSITY",
        "    273.15 0.00179",
        "    373.15 0.00028",
        "  End Table",
        "  Begin SubModelPart MustNotLeak",
        "    Begin SubModelPartNodes",
        "      1",
        "    End SubModelPartNodes",
        "  End SubModelPart",
        "End Properties",
        "Begin Properties 1",
        "  DENSITY 9999",
        "End Properties",
      ].join("\r\n"),
    },
    {
      name: "Constraints linear, multi-master split, raw rows",
      text: [
        "Begin Nodes",
        "  1 0 0 0",
        "  2 1 0 0",
        "  3 0 1 0",
        "  4 1 1 0",
        "End Nodes",
        "Begin Constraints LinearMasterSlaveConstraint DISPLACEMENT_X",
        "  1 0.0 [1.0] 1 2",
        "  2 0.0 [0.5, 0.5] 3 1 2",
        "  bad_row_verbatim",
        "  3 0.0 [[1,0],[0,1]] 1 2",
        "End Constraints",
      ].join("\n"),
    },
    {
      name: "Fields: scalar, flag-only, vector, ragged, invalid rows",
      text: [
        "Begin Nodes",
        "  1 0.1 0.2 0.3",
        "  2 -1e-7 1e21 0",
        "End Nodes",
        "Begin NodalData BOUNDARY",
        "  1",
        "  bad_id 1 0.5",
        "  2 0 not_a_number",
        "End NodalData",
        "Begin NodalData DISPLACEMENT",
        "  1 1 [3] (0.1, -2.5, 3.14159265)",
        "  2 0 (4.0, 5.0)",
        "End NodalData",
        "Begin ElementalData STRESS",
        "  1 (100.5, -200.25, 0.000034)",
        "End ElementalData",
      ].join("\n"),
    },
  ];

  for (const c of cases) {
    const tsModel = parseMdpaTs(c.text);
    const wasmModel = parseMdpaWasm(c.text);
    assert.deepEqual(
      normalizeModel(wasmModel),
      normalizeModel(tsModel),
      `case "${c.name}": parsed model mismatch`
    );

    const tsOut = writeMdpaTs(tsModel, { sourceText: c.text });
    const wasmOut = writeMdpaWasm(wasmModel, { sourceText: c.text });
    assert.equal(wasmOut, tsOut, `case "${c.name}": writeMdpa output mismatch`);
  }
});
