import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { parseMdpa } from "../parser/mdpaParser";
import { generateCase } from "../problemtype/generate";
import { defaultCaseState } from "../problemtype/api";
import { loadPyProblemtypes } from "../problemtype/pyRuntime";
import { BUILTIN_PROBLEMTYPES } from "../problemtype/builtins";
import { Assignment, MaterialAssignment, ProblemtypeRuntime } from "../problemtype/types";

let pyodideAvailable = true;
try {
  require.resolve("pyodide");
} catch {
  pyodideAvailable = false;
}

// out/test/ → repo root.
const EXAMPLES_DIR = path.join(__dirname, "..", "..", "example", "problemtypes");

const MDPA = `Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
4 0.0 0.0 1.0
End Nodes

Begin Elements Element3D4N
1 0 1 2 3 4
End Elements

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
End SubModelPart

Begin SubModelPart Loaded
  Begin SubModelPartNodes
  4
  End SubModelPartNodes
End SubModelPart
`;

interface ExampleCase {
  file: string;
  builtinId: string;
  assignments: Assignment[];
  materials: MaterialAssignment[];
  /** Extra per-section value overrides to exercise hooks (e.g. dynamic scheme). */
  values?: Record<string, Record<string, unknown>>;
}

// Assignments deliberately exercise each port's hook paths: structural's
// build_process broadcast, fluid's volume/skin derivation.
const CASES: ExampleCase[] = [
  {
    file: "structural.py",
    builtinId: "structural",
    assignments: [
      { conditionId: "parts", smpPath: "Parts/Solid", values: {} },
      { conditionId: "displacement", smpPath: "Support", values: { value: [0, 0, 0.001], constrained: true } },
      { conditionId: "selfWeight", smpPath: "Parts/Solid", values: {} },
      { conditionId: "surfacePressure", smpPath: "Loaded", values: { value: 1000 } },
    ],
    materials: [{ smpPath: "Parts/Solid", lawId: "linear_elastic_3d", values: {} }],
    values: { problem: { solverType: "dynamic" } },
  },
  {
    file: "fluid.py",
    builtinId: "fluid",
    assignments: [
      { conditionId: "parts", smpPath: "Parts/Solid", values: {} },
      { conditionId: "inlet", smpPath: "Loaded", values: { modulus: 2.5 } },
      { conditionId: "outlet", smpPath: "Support", values: {} },
      { conditionId: "noSlip", smpPath: "Support", values: {} },
    ],
    materials: [{ smpPath: "Parts/Solid", lawId: "newtonian_3d", values: {} }],
  },
  {
    file: "convection_diffusion.py",
    builtinId: "convectionDiffusion",
    assignments: [
      { conditionId: "parts", smpPath: "Parts/Solid", values: {} },
      { conditionId: "temperature", smpPath: "Support", values: { value: 350 } },
      { conditionId: "faceHeatFlux", smpPath: "Loaded", values: { value: 42 } },
    ],
    materials: [{ smpPath: "Parts/Solid", lawId: "thermal", values: {} }],
  },
];

/** JSON round-trip (normalizes prototypes + drops undefined optionals). */
const j = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

function stateFor(runtime: ProblemtypeRuntime, c: ExampleCase) {
  const state = defaultCaseState(runtime.decl);
  state.assignments = c.assignments as Assignment[];
  state.materials = c.materials;
  for (const [sectionId, overrides] of Object.entries(c.values ?? {})) {
    Object.assign(state.values[sectionId], overrides);
  }
  return state;
}

for (const c of CASES) {
  test(`example ${c.file} ≡ built-in ${c.builtinId}`, { skip: !pyodideAvailable }, async () => {
    const code = fs.readFileSync(path.join(EXAMPLES_DIR, c.file), "utf8");
    const [pyRt] = await loadPyProblemtypes(code, c.file);
    const tsRt = BUILTIN_PROBLEMTYPES.find((b) => b.decl.id === c.builtinId);
    assert.ok(tsRt, `built-in ${c.builtinId} exists`);

    // Declarations match except for the identity fields.
    const normalized = {
      ...(j(pyRt.decl) as Record<string, unknown>),
      id: tsRt!.decl.id,
      name: tsRt!.decl.name,
    };
    assert.deepEqual(normalized, j(tsRt!.decl));

    // Generated case files are byte-identical.
    const model = parseMdpa(MDPA);
    const pyOut = await generateCase(pyRt, model, stateFor(pyRt, c), "case");
    const tsOut = await generateCase(tsRt!, model, stateFor(tsRt!, c), "case");
    assert.deepEqual(pyOut.warnings, []);
    assert.equal(pyOut.projectParameters, tsOut.projectParameters);
    assert.equal(pyOut.materials, tsOut.materials);
    assert.equal(pyOut.mainScript, tsOut.mainScript);
  });
}
