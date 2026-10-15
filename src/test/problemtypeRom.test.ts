import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseMdpa } from "../parser/mdpaParser";
import { generateCase } from "../problemtype/generate";
import { defaultCaseState, validateDeclaration } from "../problemtype/api";
import { newEntry } from "../problemtype/collections";
import { BUILTIN_PROBLEMTYPES } from "../problemtype/builtins";
import { ROM_PARAMETERS, ROM_PROBLEMTYPES, romFluid, romManagerParameters, romPotentialFlow, romStructural, romThermal } from "../problemtype/builtins/rom";
import { valueAtPath } from "../problemtype/rom/parameterPaths";
import { scriptHonoursStopSentinel } from "../problemtype/mainKratosTemplate";
import type { CaseState, GenContext, JsonObject, JsonValue, ProblemtypeRuntime } from "../problemtype/types";

const MDPA = `Begin Properties 0
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
1 0 2 3 4
End Conditions

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

Begin SubModelPart Support
  Begin SubModelPartNodes
  1
  End SubModelPartNodes
End SubModelPart

Begin SubModelPart Load
  Begin SubModelPartNodes
  2
  3
  4
  End SubModelPartNodes
  Begin SubModelPartConditions
  1
  End SubModelPartConditions
End SubModelPart
`;

function withParameter(state: CaseState, name: string, target: string, min: number, max: number, extra: Record<string, JsonValue> = {}): CaseState {
  const entry = newEntry(ROM_PARAMETERS, "range", name);
  Object.assign(entry.values, { target, min, max, ...extra });
  return { ...state, collections: { ...state.collections, parameters: [...(state.collections?.parameters ?? []), entry] } };
}

/** A complete case per physics, with its natural first parameter. */
const CASES: { rt: ProblemtypeRuntime; state: () => CaseState; address: string }[] = [
  {
    rt: romStructural,
    address: "assignment:surfacePressure@Load/value",
    state: () => {
      const s = defaultCaseState(romStructural.decl);
      s.assignments = [
        { conditionId: "parts", smpPath: "Solid", values: {} },
        { conditionId: "displacement", smpPath: "Support", values: {} },
        { conditionId: "surfacePressure", smpPath: "Load", values: { value: 1000 } },
      ];
      s.materials = [{ smpPath: "Solid", lawId: "linear_elastic_3d", values: {} }];
      return s;
    },
  },
  {
    rt: romThermal,
    address: "assignment:temperature@Support/value",
    state: () => {
      const s = defaultCaseState(romThermal.decl);
      s.assignments = [
        { conditionId: "parts", smpPath: "Solid", values: {} },
        { conditionId: "temperature", smpPath: "Support", values: { value: 300 } },
      ];
      s.materials = [{ smpPath: "Solid", lawId: "thermal", values: {} }];
      return s;
    },
  },
  {
    rt: romFluid,
    address: "assignment:inlet@Load/modulus",
    state: () => {
      const s = defaultCaseState(romFluid.decl);
      s.assignments = [
        { conditionId: "parts", smpPath: "Solid", values: {} },
        { conditionId: "inlet", smpPath: "Load", values: { modulus: 2 } },
      ];
      s.materials = [{ smpPath: "Solid", lawId: "newtonian_3d", values: {} }];
      return s;
    },
  },
  {
    rt: romPotentialFlow,
    address: "assignment:farField@Load/machInfinity",
    state: () => {
      const s = defaultCaseState(romPotentialFlow.decl);
      s.assignments = [
        { conditionId: "parts", smpPath: "Solid", values: {} },
        { conditionId: "farField", smpPath: "Load", values: { machInfinity: 0.1 } },
      ];
      return s;
    },
  },
];

async function generate(rt: ProblemtypeRuntime, state: CaseState) {
  const out = await generateCase(rt, parseMdpa(MDPA), state, "case");
  const file = (name: string) => JSON.parse(out.extraFiles.find((f) => f.name === name)!.content) as JsonObject;
  return { out, pp: JSON.parse(out.projectParameters) as JsonObject, manager: file("RomManagerParameters.json"), samples: file("RomSamples.json") };
}

test("four ROM builtins in the reduced family, each a valid declaration over its physics", () => {
  assert.equal(ROM_PROBLEMTYPES.length, 4);
  for (const rt of ROM_PROBLEMTYPES) {
    assert.ok(BUILTIN_PROBLEMTYPES.includes(rt), rt.decl.id);
    assert.deepEqual(validateDeclaration(rt.decl), [], rt.decl.id);
    assert.equal(rt.decl.family, "reduced");
    assert.equal(rt.decl.driverScriptName, "MainKratosROM.py");
    assert.equal(rt.decl.primaryDocumentName, undefined, "the primary document is the physics' own ProjectParameters.json");
    assert.deepEqual(defaultCaseState(rt.decl).collections?.parameters, []);
  }
});

for (const c of CASES) {
  test(`${c.rt.decl.id}: the FOM document is the physics' own and the parameter lands where the generator writes it`, async () => {
    const state = withParameter(c.state(), "p1", c.address, 0.5, 1.5);
    const { out, pp, manager, samples } = await generate(c.rt, state);
    assert.equal(out.primaryDocumentName, "ProjectParameters.json");
    assert.ok(scriptHonoursStopSentinel(out.mainScript));
    assert.match(out.mainScript, /RomManager\("ProjectParameters\.json"/);
    const params = samples.parameters as JsonObject[];
    assert.equal(params.length, 1);
    const paths = params[0].paths as JsonObject[];
    assert.ok(paths.length >= 1, JSON.stringify(params[0]));
    const current = params[0].current as number;
    for (const p of paths) {
      assert.equal(p.document, "parameters");
      const leaf = valueAtPath(pp, p.path as (string | number)[]);
      if (p.kind === "number") assert.equal(leaf, current, JSON.stringify(p));
      else assert.equal(String(p.template).replace("{mu}", String(current)), leaf);
    }
    assert.equal((manager.ROM as JsonObject).model_part_name, c.rt.decl.modelPartName);
    assert.deepEqual(samples.mu_names, ["p1"]);
    assert.equal((samples.mu_train as number[][]).length, 6);
    assert.equal((samples.mu_test as number[][]).length, 3);
    for (const row of [...(samples.mu_train as number[][]), ...(samples.mu_test as number[][])]) {
      assert.ok(row[0] >= 0.5 && row[0] <= 1.5);
    }
  });
}

test("structural: a material parameter writes the materials file; a section value its solver setting", async () => {
  let state = withParameter(CASES[0].state(), "young", "material:Solid/YOUNG_MODULUS", 1e11, 3e11);
  state = withParameter(state, "load", "assignment:surfacePressure@Load/value", -50, 50);
  const { pp, samples } = await generate(romStructural, state);
  const [young, load] = samples.parameters as JsonObject[];
  assert.deepEqual(young.paths, [{ document: "materials", path: ["properties", 0, "Material", "Variables", "YOUNG_MODULUS"], kind: "number" }]);
  assert.deepEqual(load.paths, [{ document: "parameters", path: ["processes", "loads_process_list", 0, "Parameters", "value"], kind: "number" }]);
  assert.equal(valueAtPath(pp, ["processes", "loads_process_list", 0, "Parameters", "value"]), 1000);
  const timeStep = await generate(romStructural, withParameter(CASES[0].state(), "dt", "section:problem/timeStep", 0.05, 0.2));
  const dt = (timeStep.samples.parameters as JsonObject[])[0];
  assert.deepEqual((dt.paths as JsonObject[]).map((p) => (p.path as unknown[]).join(".")), ["solver_settings.time_stepping.time_step"]);
});

test("an integer parameter is marked and its samples rounded", async () => {
  const { samples } = await generate(romStructural, withParameter(CASES[0].state(), "echo", "section:problem/echoLevel", 0, 3));
  const p = (samples.parameters as JsonObject[])[0];
  assert.equal(p.integer, true);
  for (const row of samples.mu_train as number[][]) assert.equal(row[0], Math.round(row[0]));
});

test("RomManagerParameters: every key of the manager's defaults, written from the form", async () => {
  const { manager } = await generate(romStructural, withParameter(CASES[0].state(), "p", CASES[0].address, 0, 1));
  assert.deepEqual(Object.keys(manager), [
    "rom_stages_to_train", "rom_stages_to_test", "paralellism", "projection_strategy", "type_of_decoder", "assembling_strategy",
    "save_gid_output", "save_vtk_output", "output_name", "store_nonconverged_fom_solutions", "coupled_solvers", "ROM", "HROM",
  ]);
  assert.deepEqual(Object.keys(manager.ROM as JsonObject), [
    "svd_truncation_tolerance", "model_part_name", "nodal_unknowns", "rom_basis_output_format", "rom_basis_output_name",
    "rom_basis_output_folder", "snapshots_control_type", "snapshots_interval", "print_singular_values", "use_non_converged_sols",
    "galerkin_rom_bns_settings", "lspg_rom_bns_settings", "petrov_galerkin_rom_bns_settings",
  ]);
  assert.deepEqual(Object.keys(manager.HROM as JsonObject), [
    "hrom_format", "element_selection_type", "element_selection_svd_truncation_tolerance", "constraint_sum_weights", "svd_type",
    "create_hrom_visualization_model_part", "include_elements_model_parts_list", "include_conditions_model_parts_list",
    "initial_candidate_elements_model_part_list", "initial_candidate_conditions_model_part_list",
    "include_nodal_neighbouring_elements_model_parts_list", "include_minimum_condition", "include_condition_parents", "echo_level",
  ]);
  assert.deepEqual(manager.rom_stages_to_train, ["ROM", "HROM"]);
  assert.deepEqual(manager.rom_stages_to_test, []);
  assert.equal(manager.paralellism, null);
  assert.equal(manager.save_gid_output, false);
  assert.deepEqual((manager.ROM as JsonObject).nodal_unknowns, ["DISPLACEMENT_X", "DISPLACEMENT_Y", "DISPLACEMENT_Z"]);
});

test("nodal unknowns default per physics and domain size, and a typed list wins", () => {
  const ctx = (dim: 2 | 3, values: Record<string, JsonValue> = {}) => ({ modelPartName: "M", domainSize: dim, values } as unknown as GenContext);
  const unknowns = (rt: ProblemtypeRuntime, dim: 2 | 3, values?: Record<string, JsonValue>) => {
    const opts = { id: rt.decl.id, name: rt.decl.name, unknowns: (d: 2 | 3) => ({
      romStructural: d === 3 ? ["DISPLACEMENT_X", "DISPLACEMENT_Y", "DISPLACEMENT_Z"] : ["DISPLACEMENT_X", "DISPLACEMENT_Y"],
    } as Record<string, string[]>)[rt.decl.id] ?? [] };
    return ((romManagerParameters(values ?? {}, ctx(dim, values), opts).ROM as JsonObject).nodal_unknowns);
  };
  assert.deepEqual(unknowns(romStructural, 2), ["DISPLACEMENT_X", "DISPLACEMENT_Y"]);
  assert.deepEqual(unknowns(romStructural, 3, { romNodalUnknowns: ["DISPLACEMENT_X"] }), ["DISPLACEMENT_X"]);
});

test("HROM part lists are dotted model-part names and the stage choices map to the manager's lists", async () => {
  let state = withParameter(CASES[0].state(), "p", CASES[0].address, 0, 1);
  state.values.rom = { ...state.values.rom, hromIncludeConditions: ["Load"], romTestStages: "ROM", romProjection: "lspg" };
  const { manager } = await generate(romStructural, state);
  assert.deepEqual((manager.HROM as JsonObject).include_conditions_model_parts_list, ["Structure.Load"]);
  assert.deepEqual(manager.rom_stages_to_test, ["ROM"]);
  assert.equal(manager.projection_strategy, "lspg");
});

test("refusals name the parameter and what is wrong", async () => {
  const refused = (rt: ProblemtypeRuntime, state: CaseState, pattern: RegExp) =>
    assert.rejects(() => generateCase(rt, parseMdpa(MDPA), state, "case"), pattern);
  await refused(romStructural, CASES[0].state(), /Parameters: add at least 1/);
  await refused(romStructural, withParameter(CASES[0].state(), "p", "", 0, 1), /Parameter "p": choose a numeric value/);
  await refused(romStructural, withParameter(CASES[0].state(), "p", "assignment:surfacePressure@Nowhere/value", 0, 1), /is not in this case/);
  await refused(romStructural, withParameter(CASES[0].state(), "p", CASES[0].address, 2, 1), /minimum must be below the maximum/);
  // The fluid's reference velocity only feeds the time-step estimate: nothing the solver reads.
  await refused(romFluid, withParameter(CASES[2].state(), "u", "section:problem/refVelocity", 1, 2), /changes nothing the solver reads/);
  await refused(
    romStructural,
    withParameter(withParameter(CASES[0].state(), "a", CASES[0].address, 0, 1), "b", CASES[0].address, 0, 1),
    /vary the same value/
  );
  const testHrom = withParameter(CASES[0].state(), "p", CASES[0].address, 0, 1);
  testHrom.values.rom = { ...testHrom.values.rom, romTrainStages: "ROM", romTestStages: "ROM_HROM" };
  await refused(romStructural, testHrom, /testing the HROM needs it trained/);
});

const hasPython = spawnSync("python3", ["--version"]).status === 0;

test("the ROM driver is valid Python", { skip: !hasPython }, async () => {
  const { out } = await generate(romStructural, withParameter(CASES[0].state(), "p", CASES[0].address, 0, 1));
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kratos-rom-")), "MainKratosROM.py");
  fs.writeFileSync(file, out.mainScript);
  const check = spawnSync("python3", ["-c", "import ast, sys; ast.parse(open(sys.argv[1], 'rb').read())", file]);
  assert.equal(check.status, 0, String(check.stderr));
});

async function driverWritesAndRestoresMaterials(lineEndings: string): Promise<void> {
  let state = withParameter(CASES[0].state(), "young", "material:Solid/YOUNG_MODULUS", 1e11, 3e11);
  state = withParameter(state, "load", "assignment:surfacePressure@Load/value", -50, 50);
  const { out } = await generate(romStructural, state);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kratos-rom-run-"));
  for (const f of out.extraFiles) fs.writeFileSync(path.join(dir, f.name), f.content);
  fs.writeFileSync(path.join(dir, "ProjectParameters.json"), out.projectParameters);
  fs.writeFileSync(path.join(dir, out.materialsFileName), out.materials.replace(/\n/g, lineEndings));
  fs.writeFileSync(path.join(dir, "MainKratosROM.py"), out.mainScript);
  // A stub Kratos: Parameters over plain JSON with the accessors the driver uses.
  fs.mkdirSync(path.join(dir, "KratosMultiphysics", "RomApplication"), { recursive: true });
  fs.writeFileSync(path.join(dir, "KratosMultiphysics", "__init__.py"), `
import json
class Parameters:
    def __init__(self, text=None, node=None, parent=None, key=None):
        self.node = json.loads(text) if text is not None else node
        self.parent, self.key = parent, key
    def __getitem__(self, key):
        return Parameters(node=self.node[key], parent=self.node, key=key)
    def SetDouble(self, v): self.parent[self.key] = float(v)
    def SetInt(self, v): self.parent[self.key] = int(v)
    def SetString(self, v): self.parent[self.key] = v
    def GetString(self): return self.node
    def GetStringArray(self): return list(self.node)
    def size(self): return len(self.node)
    def Clone(self): return Parameters(json.dumps(self.node))
`);
  fs.writeFileSync(path.join(dir, "KratosMultiphysics", "RomApplication", "__init__.py"), "");
  // The driver's prelude checks every required application before running.
  for (const app of out.applications) {
    fs.mkdirSync(path.join(dir, "KratosMultiphysics", app), { recursive: true });
    const init = path.join(dir, "KratosMultiphysics", app, "__init__.py");
    if (!fs.existsSync(init)) fs.writeFileSync(init, "");
  }
  fs.writeFileSync(path.join(dir, "KratosMultiphysics", "RomApplication", "rom_manager.py"), `
import json, KratosMultiphysics
class RomManager:
    def __init__(self, name, params, customize, update_pp, update_mat, mu_names):
        self.name, self.update_pp, self.update_mat = name, update_pp, update_mat
    def Fit(self, mu_train):
        with open(self.name) as f:
            base = KratosMultiphysics.Parameters(f.read())
        mu = mu_train[0]
        pp = self.update_pp(base.Clone(), mu)
        self.update_mat("StructuralMaterials.json", mu)
        with open("seen.json", "w") as f:
            json.dump({"mu": mu, "pressure": pp.node["processes"]["loads_process_list"][0]["Parameters"]["value"],
                       "young": json.load(open("StructuralMaterials.json"))["properties"][0]["Material"]["Variables"]["YOUNG_MODULUS"]}, f)
    def Test(self, *a): pass
    def PrintErrors(self): pass
`);
  const original = fs.readFileSync(path.join(dir, "StructuralMaterials.json"), "utf8");
  const run = spawnSync("python3", ["MainKratosROM.py"], { cwd: dir, env: { ...process.env, PYTHONPATH: dir } });
  assert.equal(run.status, 0, String(run.stderr));
  const seen = JSON.parse(fs.readFileSync(path.join(dir, "seen.json"), "utf8"));
  assert.equal(seen.young, seen.mu[0]);
  assert.equal(seen.pressure, seen.mu[1]);
  assert.equal(fs.readFileSync(path.join(dir, "StructuralMaterials.json"), "utf8"), original, "the materials file is restored");
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "kkss-rom-summary-v1.json"), "utf8"));
  assert.equal(summary.stopped, false);
  assert.equal(summary.train, 6);
}

// The restore must reproduce the original bytes on every platform. Text-mode
// I/O rewrites line endings on Windows, so an LF file and a CRLF file are both
// checked here, and on Linux the CRLF case catches a text-mode restore too.
test("the ROM driver's callbacks write the sampled values, under a stub Kratos and RomManager", { skip: !hasPython }, () =>
  driverWritesAndRestoresMaterials("\n"));
test("the ROM driver's callbacks write the sampled values into a CRLF materials file and restore it byte for byte", { skip: !hasPython }, () =>
  driverWritesAndRestoresMaterials("\r\n"));
