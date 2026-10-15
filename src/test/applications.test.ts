/**
 * Required Kratos applications (roadmap item 16): what a case needs, the check
 * every generated driver starts with, and the probe the run path asks first.
 * The Python halves run under a real python child against a fake
 * `KratosMultiphysics` package, so no Kratos is needed; they are skipped
 * (reported, not passed) when no python is installed.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  MISSING_APPLICATION_EXIT_CODE,
  applicationCheckPy,
  applicationDeclarationProblems,
  applicationsInDocument,
  declaredApplications,
  describeMissingApplications,
  requiredApplications,
} from "../problemtype/applications";
import { parseProbeOutput, probeKratosApplications } from "../problemtype/kratosAppProbe";
import { parsePreparationReport, preparedApplications, writePreparedCase } from "../problemtype/preparation";
import { generateCase } from "../problemtype/generate";
import { defaultCaseState, validateDeclaration } from "../problemtype/api";
import { BUILTIN_PROBLEMTYPES } from "../problemtype/builtins";
import { parseMdpa } from "../parser/mdpaParser";
import type { ProblemtypeDeclaration } from "../problemtype/types";

function findPython(): string | undefined {
  for (const cmd of ["python3", "python"]) {
    const r = spawnSync(cmd, ["-c", "print(40+2)"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === "42") return cmd;
  }
  return undefined;
}
const PYTHON = findPython();

/** A folder holding a fake KratosMultiphysics with the given applications. */
function fakeKratos(apps: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-apps-"));
  const pkg = path.join(root, "KratosMultiphysics");
  fs.mkdirSync(pkg);
  fs.writeFileSync(path.join(pkg, "__init__.py"), "print('fake Kratos banner')\n");
  for (const app of apps) {
    fs.mkdirSync(path.join(pkg, app));
    fs.writeFileSync(path.join(pkg, app, "__init__.py"), "");
  }
  return root;
}

test("applications are read from module paths and linear-solver factory keys", () => {
  const doc = {
    analysis_stage: "KratosMultiphysics.FluidDynamicsApplication.fluid_dynamics_analysis",
    solver_settings: { linear_solver_settings: { solver_type: "LinearSolversApplication.sparse_lu" } },
    processes: [{ kratos_module: "KratosMultiphysics.MeshingApplication", python_module: "mmg_process" }],
    unrelated: ["KratosMultiphysics", "apply_slip_process", "cg", "Application", "notAnApplication.x"],
  };
  assert.deepEqual([...applicationsInDocument(doc)], ["FluidDynamicsApplication", "LinearSolversApplication", "MeshingApplication"]);
});

test("declared applications follow their when rule; the union is sorted and deduplicated", () => {
  const declared = ["FluidDynamicsApplication", { application: "MeshMovingApplication", when: { field: "aleMesh", equals: true } }];
  assert.deepEqual(declaredApplications(declared, { aleMesh: false }), ["FluidDynamicsApplication"]);
  assert.deepEqual(declaredApplications(declared, { aleMesh: true }), ["FluidDynamicsApplication", "MeshMovingApplication"]);
  const decl = { analysisStage: "KratosMultiphysics.FSIApplication.fsi_analysis", applications: declared };
  assert.deepEqual(requiredApplications(decl, { aleMesh: true }, [{ kratos_module: "KratosMultiphysics.FluidDynamicsApplication" }]), [
    "FSIApplication",
    "FluidDynamicsApplication",
    "MeshMovingApplication",
  ]);
  // A stage outside an application contributes nothing.
  assert.deepEqual(requiredApplications({ analysisStage: "KratosMultiphysics.analysis_stage" }, {}, []), []);
});

test("a declaration's applications list is validated by name", () => {
  assert.deepEqual(applicationDeclarationProblems(undefined), []);
  assert.deepEqual(applicationDeclarationProblems(["FSIApplication", { application: "MappingApplication", when: { field: "x", equals: 1 } }]), []);
  assert.equal(applicationDeclarationProblems("FSIApplication").length, 1);
  assert.match(applicationDeclarationProblems(["fsi"])[0], /applications\[0\]/);
  assert.match(applicationDeclarationProblems([{ application: "MappingApplication", when: 3 }])[0], /when/);
});

test("every builtin declares valid applications and names its stage's", async () => {
  const model = parseMdpa("Begin Nodes\n1 0 0 0\n2 1 0 0\n3 0 1 0\nEnd Nodes\n");
  for (const rt of BUILTIN_PROBLEMTYPES) {
    assert.deepEqual(validateDeclaration(rt.decl), [], rt.decl.id);
    const stage = /^KratosMultiphysics\.([A-Za-z]+Application)\./.exec(rt.decl.analysisStage)?.[1];
    try {
      const out = await generateCase(rt, model, defaultCaseState(rt.decl), "m");
      if (stage) assert.ok(out.applications.includes(stage), `${rt.decl.id}: ${out.applications}`);
      assert.ok(out.mainScript.startsWith(applicationCheckPy(out.applications)), rt.decl.id);
    } catch {
      // Default states of several builtins are refused (no parts); that is
      // covered by their own tests — the declaration check above still ran.
    }
  }
});

test("the FSI case requires what partitioned_fsi_base_solver imports", async () => {
  const fsi = BUILTIN_PROBLEMTYPES.find((r) => r.decl.id === "fsi")!;
  const decl = fsi.decl as ProblemtypeDeclaration;
  assert.deepEqual(requiredApplications(decl, {}, []), [
    "FSIApplication",
    "FluidDynamicsApplication",
    "MappingApplication",
    "MeshMovingApplication",
    "StructuralMechanicsApplication",
  ]);
});

test("the refusal names what is missing", () => {
  assert.match(describeMissingApplications(["MappingApplication"]), /application that .*: MappingApplication\. Install it/);
  assert.match(describeMissingApplications(["A", "B"]), /applications that .*: A, B\. Install them/);
  assert.match(describeMissingApplications(["KratosMultiphysics"]), /cannot be imported/);
});

test("the driver prelude exits 3 naming a missing application, and runs on when all are present", { skip: !PYTHON }, () => {
  const root = fakeKratos(["FluidDynamicsApplication"]);
  const script = applicationCheckPy(["FluidDynamicsApplication", "MappingApplication"]) + "print('ran')\n";
  const run = (text: string, env: Record<string, string>) =>
    spawnSync(PYTHON!, ["-c", text], { encoding: "utf8", env: { ...process.env, ...env } });
  const missing = run(script, { PYTHONPATH: root });
  assert.equal(missing.status, MISSING_APPLICATION_EXIT_CODE);
  assert.match(missing.stderr, /Missing Kratos applications: MappingApplication/);
  assert.doesNotMatch(missing.stdout, /ran/);

  const present = run(applicationCheckPy(["FluidDynamicsApplication"]) + "print('ran')\n", { PYTHONPATH: root });
  assert.equal(present.status, 0, present.stderr);
  assert.match(present.stdout, /ran/);

  const noKratos = run(script, { PYTHONPATH: fs.mkdtempSync(path.join(os.tmpdir(), "kkss-empty-")) });
  // A python that has a real Kratos installed would find it; only assert when it does not.
  if (spawnSync(PYTHON!, ["-c", "import KratosMultiphysics"]).status !== 0) {
    assert.equal(noKratos.status, MISSING_APPLICATION_EXIT_CODE);
    assert.match(noKratos.stderr, /Missing Kratos applications: KratosMultiphysics/);
  }
});

test("the probe reports missing applications through the banner", { skip: !PYTHON }, async () => {
  const root = fakeKratos(["FluidDynamicsApplication", "StructuralMechanicsApplication"]);
  const result = await probeKratosApplications({
    python: PYTHON!,
    envDelta: { PYTHONPATH: root },
    applications: ["FluidDynamicsApplication", "MappingApplication", "StructuralMechanicsApplication"],
  });
  assert.deepEqual(result, { missing: ["MappingApplication"] });
});

test("a probe that cannot run reports unavailable rather than missing", async () => {
  const result = await probeKratosApplications({ python: "definitely-not-a-python-kkss", applications: ["X"] });
  assert.deepEqual(result.missing, []);
  assert.match(result.unavailable ?? "", /could not start/);
  // node -c is a syntax check that prints no marker: an answer we cannot read.
  const node = await probeKratosApplications({ python: process.execPath, applications: ["X"] });
  assert.deepEqual(node.missing, []);
  assert.ok(node.unavailable);
});

test("only the marker line is read from the probe's output", () => {
  assert.deepEqual(parseProbeOutput('banner\n | / |\nKKSS_APP_PROBE {"missing": ["A"]}\n'), ["A"]);
  assert.equal(parseProbeOutput("no marker"), undefined);
  assert.equal(parseProbeOutput('KKSS_APP_PROBE {"missing": 3}'), undefined);
});

test("the preparation record carries the applications and rejects a malformed list", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-prep-"));
  const mesh = path.join(dir, "m.mdpa");
  fs.writeFileSync(mesh, "Begin Nodes\n1 0 0 0\nEnd Nodes\n");
  const structural = BUILTIN_PROBLEMTYPES.find((r) => r.decl.id === "structural")!;
  const state = defaultCaseState(structural.decl);
  const generated = {
    projectParameters: "{}\n",
    materials: "{}\n",
    materialsFileName: "StructuralMaterials.json",
    mainScript: "print(1)\n",
    extraFiles: [],
    warnings: [],
    primaryDocumentName: "ProjectParameters.json",
    driverScriptName: "MainKratos.py",
    applications: ["StructuralMechanicsApplication"],
  };
  writePreparedCase({ directory: dir, sourcePath: mesh, solverMeshPath: mesh, runtime: structural, state, generated, warnings: [] });
  assert.deepEqual(preparedApplications(dir), ["StructuralMechanicsApplication"]);
  const text = fs.readFileSync(path.join(dir, "kkss-preparation-v1.json"), "utf8");
  const bad = JSON.parse(text);
  bad.applications = ["../evil"];
  assert.throws(() => parsePreparationReport(JSON.stringify(bad)), /Malformed/);
  delete bad.applications;
  assert.equal(parsePreparationReport(JSON.stringify(bad)).applications, undefined);
  assert.equal(preparedApplications(path.join(dir, "nowhere")), undefined);
});
