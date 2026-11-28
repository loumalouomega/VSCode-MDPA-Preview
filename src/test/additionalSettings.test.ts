/**
 * Additional solver settings per case (roadmap item 80): the raw JSON box each
 * solver document gets, merged last with RFC 7386 JSON Merge Patch rules.
 *
 * The acceptance path is here too: a linear-solver tolerance patch survives
 * Generate, the preparation report and the run comparison; an invalid patch
 * refuses generation with a position; an empty box is byte-identical for every
 * built-in problemtype.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseMdpa } from "../parser/mdpaParser";
import { generateCase } from "../problemtype/generate";
import { defaultCaseState, validateDeclaration } from "../problemtype/api";
import { BUILTIN_PROBLEMTYPES } from "../problemtype/builtins";
import { structural } from "../problemtype/builtins/structural";
import { cosim } from "../problemtype/builtins/cosim";
import { primaryDocumentName, solverDocumentNames } from "../problemtype/documentNames";
import {
  additionalSettingsDocuments,
  applyAdditionalSettings,
  applyMergePatch,
  checkAdditionalSettings,
  diffDocuments,
  formatPath,
  parsePatchText,
  previewValue,
  withoutInvalidAdditionalSettings,
} from "../problemtype/additionalSettings";
import { preflightCase } from "../problemtype/preflight";
import { parseCaseJson, serializeCase } from "../problemtype/caseFile";
import { parsePreparationReport, writePreparedCase } from "../problemtype/preparation";
import { diffSettings } from "../problemtype/runCompare";
import { CaseState, JsonValue, ProblemtypeDeclaration } from "../problemtype/types";

// One tetrahedron with a volume part and a boundary part (the same fixture the
// generator and preflight tests use).
const MDPA_3D = `Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
4 0.0 0.0 1.0
End Nodes

Begin Elements Element3D4N
1 0 1 2 3 4
End Elements

Begin Conditions SurfaceCondition3D3N
1 0 1 2 3
End Conditions

Begin SubModelPart Parts
  Begin SubModelPart Solid
    Begin SubModelPartNodes
    1
    2
    3
    4
    End SubModelPartNodes
    Begin SubModelPartElements
    1
    End SubModelPartElements
  End SubModelPart
End SubModelPart

Begin SubModelPart Support
  Begin SubModelPartNodes
  1
  2
  3
  End SubModelPartNodes
  Begin SubModelPartConditions
  1
  End SubModelPartConditions
End SubModelPart
`;

function structuralState(): CaseState {
  const state = defaultCaseState(structural.decl);
  state.assignments = [
    { conditionId: "parts", smpPath: "Parts/Solid", values: {} },
    { conditionId: "displacement", smpPath: "Support", values: { value: [0, 0, 0], constrained: true } },
  ];
  state.materials = [
    { smpPath: "Parts/Solid", lawId: "linear_elastic_3d", values: { YOUNG_MODULUS: 2.0e11 } },
  ];
  return state;
}

const withPatch = (state: CaseState, document: string, text: string): CaseState => ({
  ...state,
  additionalSettings: { [document]: text },
});

test("JSON Merge Patch merges objects, replaces other values and removes null", () => {
  const target = { a: { b: 1, c: 2 }, list: [1, 2], keep: true, gone: "x" };
  const patch = { a: { b: 3, d: 4 }, list: [9], gone: null, added: { nested: 1 } };
  assert.deepEqual(applyMergePatch(target, patch), {
    a: { b: 3, c: 2, d: 4 },
    list: [9],
    keep: true,
    added: { nested: 1 },
  });
  // Neither input is modified.
  assert.deepEqual(target, { a: { b: 1, c: 2 }, list: [1, 2], keep: true, gone: "x" });
  assert.deepEqual(patch, { a: { b: 3, d: 4 }, list: [9], gone: null, added: { nested: 1 } });
  // A non-object target becomes an object, as RFC 7386 says.
  assert.deepEqual(applyMergePatch(5, { a: 1 }), { a: 1 });
  // Prototype keys never enter the merged document.
  assert.deepEqual(applyMergePatch({}, JSON.parse('{"__proto__":{"polluted":true},"safe":1}')), { safe: 1 });
});

test("diffDocuments lists every changed leaf with its path and action", () => {
  const before = {
    solver_settings: { tolerance: 1e-7, max_iteration: 200 },
    list: [1, 2],
    gone: { x: 1 },
    same: { a: 1 },
    "a.b": { c: 1 },
  };
  const after = {
    solver_settings: { tolerance: 1e-10, max_iteration: 200 },
    list: [1, 2, 3],
    added: true,
    same: { a: 1 },
    "a.b": { c: 2 },
  };
  assert.deepEqual(diffDocuments(before, after), [
    { path: '["a.b"].c', action: "set", existing: true, value: 2 },
    { path: "added", action: "set", existing: false, value: true },
    { path: "gone", action: "remove", existing: true },
    { path: "list", action: "set", existing: true, value: [1, 2, 3] },
    { path: "solver_settings.tolerance", action: "set", existing: true, value: 1e-10 },
  ]);
  assert.deepEqual(diffDocuments(before, structuredClone(before)), []);
  assert.equal(formatPath([]), "(root)");
  assert.equal(formatPath(["a", "b"]), "a.b");
  assert.equal(formatPath(["a.b"]), '["a.b"]');
  assert.equal(previewValue({ a: 1 }), '{"a":1}');
});

test("parsePatchText refuses malformed text by document, with a position", () => {
  assert.deepEqual(parsePatchText(" \n\t ", "ProjectParameters.json"), {});
  assert.deepEqual(parsePatchText('{"solver_settings":{"echo_level":2}}', "ProjectParameters.json"), {
    patch: { solver_settings: { echo_level: 2 } },
  });

  const broken = parsePatchText('{\n  "solver_settings": {\n    "echo_level": }\n}', "ProjectParameters.json");
  assert.ok(broken.problem);
  assert.equal(broken.problem!.document, "ProjectParameters.json");
  assert.match(broken.problem!.message, /not valid JSON/);
  assert.match(broken.problem!.message, /line \d+ column \d+/);
  assert.ok((broken.problem!.line ?? 0) >= 1);
  assert.ok((broken.problem!.column ?? 0) >= 1);
  assert.equal(broken.problem!.position !== undefined, true);

  const array = parsePatchText("[1, 2]", "ProjectParameters.json");
  assert.ok(array.problem);
  assert.match(array.problem!.message, /must be a JSON object, not an array/);
  assert.match(array.problem!.message, /line 1 column 1/);

  const nullRoot = parsePatchText("null", "ProjectParameters.json");
  assert.match(nullRoot.problem!.message, /not null/);

  const proto = parsePatchText('{"__proto__":{"polluted":true}}', "ProjectParameters.json");
  assert.match(proto.problem!.message, /must not use the key "__proto__"/);
  assert.ok(proto.problem!.line !== undefined && proto.problem!.column !== undefined);
});

test("checkAdditionalSettings refuses unknown documents and non-text entries", () => {
  const unknown = checkAdditionalSettings(structural.decl, {
    additionalSettings: { "StructuralMaterials.json": "{}" },
  });
  assert.equal(unknown.problems.length, 1);
  assert.match(unknown.problems[0].message, /does not write/);
  assert.match(unknown.problems[0].message, /ProjectParameters\.json/);
  assert.deepEqual([...unknown.invalidDocuments], ["StructuralMaterials.json"]);

  const nonText = checkAdditionalSettings(structural.decl, {
    additionalSettings: { "ProjectParameters.json": 5 } as unknown as Record<string, string>,
  });
  assert.match(nonText.problems[0].message, /must be text/);

  const notAnObject = checkAdditionalSettings(structural.decl, {
    additionalSettings: [] as unknown as Record<string, string>,
  });
  assert.equal(notAnObject.invalidCase, true);
  assert.match(notAnObject.problems[0].message, /must be an object/);

  const empty = checkAdditionalSettings(structural.decl, {
    additionalSettings: { "ProjectParameters.json": " \n" },
  });
  assert.deepEqual(empty.problems, []);
  assert.equal(empty.patches.size, 0);
});

test("withoutInvalidAdditionalSettings drops only what a dry run cannot use", () => {
  const state = withPatch(structuralState(), "ProjectParameters.json", '{"solver_settings":{"echo_level":2}}');
  state.additionalSettings!["Nope.json"] = "{}";
  const check = checkAdditionalSettings(structural.decl, state);
  const stripped = withoutInvalidAdditionalSettings(state, check);
  assert.deepEqual(stripped.additionalSettings, { "ProjectParameters.json": '{"solver_settings":{"echo_level":2}}' });
  // The original state is untouched, so the caller can still report on it.
  assert.equal(state.additionalSettings!["Nope.json"], "{}");

  const onlyBad = withPatch(structuralState(), "Nope.json", "{}");
  assert.equal(withoutInvalidAdditionalSettings(onlyBad, checkAdditionalSettings(structural.decl, onlyBad)).additionalSettings, undefined);
});

test("the document list is the declaration's, plus hand-edited keys", () => {
  assert.deepEqual(solverDocumentNames(structural.decl), ["ProjectParameters.json"]);
  assert.equal(primaryDocumentName(structural.decl), "ProjectParameters.json");
  assert.deepEqual(solverDocumentNames(cosim.decl), [
    "ProjectParametersCoSim.json",
    "ProjectParametersCFD.json",
    "ProjectParametersCSM.json",
  ]);
  const state = defaultCaseState(structural.decl);
  state.additionalSettings = { "ProjectParameters.json": "{}", "HandEdited.json": "{}" };
  assert.deepEqual(additionalSettingsDocuments(structural.decl, state), ["ProjectParameters.json", "HandEdited.json"]);
});

test("a declaration's solverDocuments must name the documents it writes", () => {
  const ok: ProblemtypeDeclaration = { ...structural.decl, solverDocuments: ["ProjectParameters.json"] };
  assert.deepEqual(validateDeclaration(ok), []);

  const cases: [string[], RegExp][] = [
    [[], /non-empty array/],
    [["Other.json"], /must start with the primary document/],
    [["ProjectParameters.json", "ProjectParameters.json"], /must not repeat/],
    [["ProjectParameters.json", "StructuralMaterials.json"], /must not list the materials file/],
    [["ProjectParameters.json", "MainKratos.py"], /plain file names ending in \.json/],
    [["ProjectParameters.json", "bad/name.json"], /plain file names ending in \.json/],
  ];
  for (const [documents, expected] of cases) {
    const decl: ProblemtypeDeclaration = { ...structural.decl, solverDocuments: documents };
    assert.match(validateDeclaration(decl).join("\n"), expected, JSON.stringify(documents));
  }
});

test("a tolerance patch survives Generate and is reported path by path", async () => {
  const model = parseMdpa(MDPA_3D);
  const state = structuralState();
  state.values.problem.linearSolver = "cg";
  const patched = withPatch(
    state,
    "ProjectParameters.json",
    JSON.stringify({ solver_settings: { linear_solver_settings: { tolerance: 1e-10, max_iteration: 500 } } })
  );
  const out = await generateCase(structural, model, patched, "beam");
  const pp = JSON.parse(out.projectParameters);
  assert.equal(pp.solver_settings.linear_solver_settings.solver_type, "cg");
  assert.equal(pp.solver_settings.linear_solver_settings.tolerance, 1e-10);
  assert.equal(pp.solver_settings.linear_solver_settings.max_iteration, 500);
  assert.deepEqual(out.additionalSettings, {
    documents: [
      {
        name: "ProjectParameters.json",
        changes: [
          { document: "ProjectParameters.json", path: "solver_settings.linear_solver_settings.max_iteration", action: "set", existing: true, value: 500 },
          { document: "ProjectParameters.json", path: "solver_settings.linear_solver_settings.tolerance", action: "set", existing: true, value: 1e-10 },
        ],
      },
    ],
  });
});

test("the application scan runs after the merge, so an added process is checked", async () => {
  const model = parseMdpa(MDPA_3D);
  const state = withPatch(
    structuralState(),
    "ProjectParameters.json",
    JSON.stringify({
      processes: {
        list_other_processes: [
          {
            python_module: "some_process",
            kratos_module: "KratosMultiphysics.ContactStructuralMechanicsApplication",
            process_name: "SomeProcess",
            Parameters: {},
          },
        ],
      },
    })
  );
  const out = await generateCase(structural, model, state, "beam");
  assert.ok(out.applications.includes("ContactStructuralMechanicsApplication"));
});

test("a patch that names a materials file or the driver is refused", async () => {
  const model = parseMdpa(MDPA_3D);
  for (const document of ["StructuralMaterials.json", "MainKratos.py", "Nope.json"]) {
    await assert.rejects(
      generateCase(structural, model, withPatch(structuralState(), document, "{}"), "beam"),
      new RegExp(`${document.replace(/\./g, "\\.")}[\\s\\S]*does not write`),
      document
    );
  }
});

test("an empty additional-settings box leaves every built-in byte-identical", async () => {
  const model = parseMdpa(MDPA_3D);
  for (const runtime of BUILTIN_PROBLEMTYPES) {
    const base = defaultCaseState(runtime.decl);
    const patched = structuredClone(base);
    patched.additionalSettings = { [primaryDocumentName(runtime.decl)]: " \n\t " };
    const run = async (state: CaseState) => {
      try {
        return { out: await generateCase(runtime, model, state, "case") };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    };
    const a = await run(base);
    const b = await run(patched);
    if ("error" in a) {
      assert.deepEqual(b, a, runtime.decl.id);
      continue;
    }
    if ("error" in b) {
      assert.deepEqual(b, a, runtime.decl.id);
      continue;
    }
    assert.equal(b.out.projectParameters, a.out.projectParameters, runtime.decl.id);
    assert.equal(b.out.materials, a.out.materials, runtime.decl.id);
    assert.equal(b.out.mainScript, a.out.mainScript, runtime.decl.id);
    assert.deepEqual(b.out.extraFiles, a.out.extraFiles, runtime.decl.id);
    assert.deepEqual(b.out.warnings, a.out.warnings, runtime.decl.id);
    assert.deepEqual(b.out.applications, a.out.applications, runtime.decl.id);
    assert.equal(b.out.additionalSettings, undefined, runtime.decl.id);
  }
});

test("a no-op patch is not re-serialized", async () => {
  const model = parseMdpa(MDPA_3D);
  const base = await generateCase(structural, model, structuralState(), "beam");
  const same = await generateCase(
    structural,
    model,
    withPatch(structuralState(), "ProjectParameters.json", '{"solver_settings":{"echo_level":1}}'),
    "beam"
  );
  assert.equal(same.projectParameters, base.projectParameters);
  assert.equal(same.additionalSettings, undefined);
  const empty = await generateCase(structural, model, withPatch(structuralState(), "ProjectParameters.json", "{}"), "beam");
  assert.equal(empty.projectParameters, base.projectParameters);
  assert.equal(empty.additionalSettings, undefined);
});

test("a patch on a declared document Generate did not write is refused", () => {
  const decl: ProblemtypeDeclaration = {
    ...structural.decl,
    solverDocuments: ["ProjectParameters.json", "ProjectParametersExtra.json"],
  };
  const applied = applyAdditionalSettings(decl, { additionalSettings: { "ProjectParametersExtra.json": "{}" } }, {}, []);
  assert.equal(applied.problems.length, 1);
  assert.match(applied.problems[0].message, /declares it but Generate did not write it/);
});

test("the preparation report records the patch and the merged parameters", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "additional-settings-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const meshPath = path.join(dir, "beam.mdpa");
  fs.writeFileSync(meshPath, MDPA_3D);
  const model = parseMdpa(MDPA_3D);

  const plain = structuralState();
  plain.values.problem.linearSolver = "cg";
  const patched = withPatch(
    plain,
    "ProjectParameters.json",
    '{"solver_settings":{"linear_solver_settings":{"tolerance":1e-10}}}'
  );
  const plainOut = await generateCase(structural, model, plain, "beam");
  const patchedOut = await generateCase(structural, model, patched, "beam");
  const write = (state: CaseState, generated: typeof plainOut) =>
    writePreparedCase({ directory: dir, sourcePath: meshPath, solverMeshPath: meshPath, runtime: structural, state, generated, warnings: [] });

  const plainPrepared = write(plain, plainOut);
  const patchedPrepared = write(patched, patchedOut);
  assert.deepEqual(patchedPrepared.preparation.settings.additionalSettings, patched.additionalSettings);
  assert.equal(
    (patchedPrepared.preparation.effectiveParameters as { solver_settings: { linear_solver_settings: { tolerance: number } } })
      .solver_settings.linear_solver_settings.tolerance,
    1e-10
  );
  assert.notEqual(plainPrepared.preparation.settingsRevision, patchedPrepared.preparation.settingsRevision);
  assert.deepEqual(diffSettings(plainPrepared.preparation.settings, patchedPrepared.preparation.settings), [
    { path: "additionalSettings.ProjectParameters.json", right: patched.additionalSettings!["ProjectParameters.json"] },
  ]);
  // The report on disk is the same record the run comparison reads.
  const report = parsePreparationReport(fs.readFileSync(path.join(dir, "kkss-preparation-v1.json"), "utf8"));
  assert.deepEqual(report.settings.additionalSettings, patched.additionalSettings);
  assert.deepEqual(report.effectiveParameters, patchedPrepared.preparation.effectiveParameters);
});

test("preflight refuses a malformed patch without a duplicate generate refusal", async () => {
  const model = parseMdpa(MDPA_3D);
  const state = withPatch(
    structuralState(),
    "ProjectParameters.json",
    '{\n  "solver_settings": {\n    "echo_level": }\n}'
  );
  const report = await preflightCase(structural, model, state, "beam", { quality: false });
  assert.equal(report.ok, false);
  const invalid = report.findings.filter((f) => f.code === "additional-settings-invalid");
  assert.equal(invalid.length, 1);
  assert.match(invalid[0].message, /ProjectParameters\.json/);
  assert.match(invalid[0].message, /line \d+ column \d+/);
  assert.equal(report.findings.some((f) => f.code === "generate-refused"), false);
  assert.equal(report.overrides, undefined);
});

test("preflight names overridden paths, and an added path is only info", async () => {
  const model = parseMdpa(MDPA_3D);
  const overridden = withPatch(
    structuralState(),
    "ProjectParameters.json",
    JSON.stringify({ problem_data: { problem_name: "renamed" }, solver_settings: { echo_level: 3 } })
  );
  const report = await preflightCase(structural, model, overridden, "beam", { quality: false });
  assert.equal(report.ok, true);
  assert.deepEqual(
    report.findings.filter((f) => f.code === "additional-settings-override").map((f) => f.message),
    [
      "Additional settings override `problem_data.problem_name` in `ProjectParameters.json`, which Generate already writes; the patch wins.",
      "Additional settings override `solver_settings.echo_level` in `ProjectParameters.json`, which Generate already writes; the patch wins.",
    ]
  );
  assert.deepEqual(report.overrides, [
    { document: "ProjectParameters.json", path: "problem_data.problem_name", action: "set" },
    { document: "ProjectParameters.json", path: "solver_settings.echo_level", action: "set" },
  ]);

  const added = withPatch(
    structuralState(),
    "ProjectParameters.json",
    JSON.stringify({ solver_settings: { linear_solver_settings: { solver_type: "cg", tolerance: 1e-9 } } })
  );
  const info = await preflightCase(structural, model, added, "beam", { quality: false });
  assert.equal(info.ok, true);
  assert.equal(info.findings.some((f) => f.code === "additional-settings-override"), false);
  assert.ok(info.findings.some((f) => f.code === "additional-settings" && f.message.includes("solver_settings.linear_solver_settings")));
  assert.equal(info.overrides, undefined);
});

test("preflight's application list includes what the patch adds", async () => {
  const model = parseMdpa(MDPA_3D);
  const state = withPatch(
    structuralState(),
    "ProjectParameters.json",
    JSON.stringify({
      processes: {
        list_other_processes: [
          { kratos_module: "KratosMultiphysics.ContactStructuralMechanicsApplication", process_name: "SomeProcess" },
        ],
      },
    })
  );
  const report = await preflightCase(structural, model, state, "beam", { quality: false });
  assert.ok(report.applications?.includes("ContactStructuralMechanicsApplication"));
});

test("additional settings round-trip through the case file; empty entries are dropped", () => {
  const state = structuralState();
  state.additionalSettings = {
    "ProjectParameters.json": '{"solver_settings":{"echo_level":2}}',
    "HandEdited.json": " \n",
  };
  const { state: back, warnings } = parseCaseJson(serializeCase(state));
  assert.deepEqual(warnings, []);
  assert.deepEqual(back!.additionalSettings, { "ProjectParameters.json": '{"solver_settings":{"echo_level":2}}' });
  // A case with no patch has no key at all, so its file is unchanged.
  assert.equal(serializeCase(structuralState()).includes("additionalSettings"), false);
});

test("malformed additional settings degrade with warnings", () => {
  const { state, warnings } = parseCaseJson(
    JSON.stringify({
      version: 1,
      problemtypeId: "structural",
      additionalSettings: { "ProjectParameters.json": 5, "Other.json": " " },
    })
  );
  assert.equal(state!.additionalSettings, undefined);
  assert.ok(warnings.some((w) => w.includes('Additional settings for "ProjectParameters.json" must be text')));
  const notObject = parseCaseJson(
    JSON.stringify({ version: 1, problemtypeId: "structural", additionalSettings: [] })
  );
  assert.equal(notObject.state!.additionalSettings, undefined);
  assert.ok(notObject.warnings.some((w) => w.includes("is not an object")));
});

test("the merged primary is what effectiveParameters records, even for a removed key", async () => {
  const model = parseMdpa(MDPA_3D);
  const state = withPatch(structuralState(), "ProjectParameters.json", '{"problem_data":{"problem_name":null}}');
  const out = await generateCase(structural, model, state, "beam");
  const pp = JSON.parse(out.projectParameters) as { problem_data: Record<string, JsonValue> };
  assert.equal("problem_name" in pp.problem_data, false);
  assert.deepEqual(out.additionalSettings?.documents[0].changes, [
    { document: "ProjectParameters.json", path: "problem_data.problem_name", action: "remove", existing: true },
  ]);
});
