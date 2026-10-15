import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { defaultCaseState, defineProblemtype, validateDeclaration } from "../problemtype/api";
import {
  collectionProblems,
  danglingRefs,
  isValidEntryName,
  newEntry,
  parseListText,
  renameEntry,
  resolveCollections,
  uniqueEntryName,
} from "../problemtype/collections";
import { parseCaseJson, serializeCase } from "../problemtype/caseFile";
import { generateCase } from "../problemtype/generate";
import { preflightCase } from "../problemtype/preflight";
import { summaryChips } from "../problemtype/layout";
import type { CaseState, ProblemtypeDeclaration } from "../problemtype/types";

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

Begin SubModelPart Body
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
`;

/** A tiny optimization-shaped declaration: responses referenced by an objective and by constraints. */
const DECL: ProblemtypeDeclaration = {
  id: "toy",
  name: "Toy",
  analysisStage: "x.y",
  modelPartName: "Structure",
  materialsFileName: "M.json",
  domainSizes: [3],
  sections: [
    {
      id: "algorithm",
      label: "Algorithm",
      fields: [
        { id: "objective", label: "Objective", type: "ref", refCollection: "responses", default: "mass" },
        { id: "steps", label: "Steps", type: "int", default: 5 },
      ],
    },
  ],
  conditions: [],
  materialLaws: [],
  output: { nodalDefaults: [] },
  collections: [
    {
      id: "responses",
      label: "Responses",
      entryTypes: [
        { id: "mass", label: "Mass", fields: [{ id: "perturbation", label: "Perturbation", type: "number", default: 1e-6 }], parts: { label: "Evaluated on", target: "any" } },
        { id: "energy", label: "Strain energy", fields: [] },
      ],
      defaults: [{ name: "mass", type: "mass" }],
    },
    {
      id: "controls",
      label: "Controls",
      min: 1,
      entryTypes: [
        {
          id: "material",
          label: "Material",
          fields: [
            { id: "variable", label: "Variable", type: "enum", options: [{ value: "YOUNG_MODULUS" }, { value: "DENSITY" }] },
            { id: "damped", label: "Damped", type: "smpList" },
          ],
          parts: { label: "Design region", target: "volume", min: 1 },
        },
      ],
    },
    {
      id: "constraints",
      label: "Constraints",
      entryTypes: [{ id: "limit", label: "Limit", fields: [{ id: "response", label: "Response", type: "ref", refCollection: "responses" }] }],
    },
  ],
};

const RUNTIME = defineProblemtype(DECL, { solverSettings: () => ({}) });

function withControl(state: CaseState, parts = ["Body"]): CaseState {
  const control = newEntry(DECL.collections![1], "material", "stiffness");
  control.parts = parts;
  return { ...state, collections: { ...state.collections, controls: [control] } };
}

test("declarations: refs must name a declared collection, caseValue only inside a collection", () => {
  assert.deepEqual(validateDeclaration(DECL), []);
  const badRef: ProblemtypeDeclaration = {
    ...DECL,
    sections: [{ id: "s", label: "S", fields: [{ id: "r", label: "R", type: "ref", refCollection: "nope" }] }],
  };
  assert.match(validateDeclaration(badRef).join("\n"), /ref field "r" names unknown collection "nope"/);
  const loose: ProblemtypeDeclaration = {
    ...DECL,
    sections: [{ id: "s", label: "S", fields: [{ id: "v", label: "V", type: "caseValue" }] }],
  };
  assert.match(validateDeclaration(loose).join("\n"), /caseValue field "v" is only valid inside a collection/);
  const dupType: ProblemtypeDeclaration = {
    ...DECL,
    collections: [{ id: "c", label: "C", entryTypes: [{ id: "a", label: "A", fields: [] }, { id: "a", label: "A2", fields: [] }] }],
  };
  assert.match(validateDeclaration(dupType).join("\n"), /duplicate entry type "a"/);
  const badDefault: ProblemtypeDeclaration = {
    ...DECL,
    collections: [{ id: "c", label: "C", entryTypes: [{ id: "a", label: "A", fields: [] }], defaults: [{ name: "1st", type: "zzz" }] }],
  };
  const errs = validateDeclaration(badDefault).join("\n");
  assert.match(errs, /default entry name "1st" must be an identifier/);
  assert.match(errs, /unknown type "zzz"/);
});

test("default state seeds collections from defaults, without parts", () => {
  const state = defaultCaseState(DECL);
  assert.deepEqual(state.collections, {
    responses: [{ name: "mass", type: "mass", parts: [], values: { perturbation: 1e-6 } }],
    controls: [],
    constraints: [],
  });
  assert.deepEqual(summaryChips(DECL, state).slice(3), ["1 responses", "0 controls", "0 constraints"]);
});

test("entry names are identifiers; unique names are derived from the type", () => {
  assert.ok(isValidEntryName("strain_energy"));
  for (const bad of ["", "1x", "a b", "a.b", "a:b", 3]) assert.equal(isValidEntryName(bad), false, String(bad));
  const state = defaultCaseState(DECL);
  assert.equal(uniqueEntryName(state, "responses", "mass"), "mass_2");
  assert.equal(uniqueEntryName(state, "responses", "energy"), "energy");
  assert.equal(uniqueEntryName(state, "responses", "2 x"), "_2_x");
});

test("rename rewrites every ref and refuses a taken or invalid name", () => {
  const base = defaultCaseState(DECL);
  const state: CaseState = {
    ...base,
    collections: {
      ...base.collections,
      constraints: [{ name: "c1", type: "limit", parts: [], values: { response: "mass" } }],
    },
  };
  const next = renameEntry(DECL, state, "responses", "mass", "weight")!;
  assert.equal(next.collections!.responses[0].name, "weight");
  assert.equal(next.values.algorithm.objective, "weight");
  assert.equal(next.collections!.constraints[0].values.response, "weight");
  // The input is never mutated.
  assert.equal(state.collections!.responses[0].name, "mass");
  assert.equal(state.values.algorithm.objective, "mass");
  assert.equal(renameEntry(DECL, state, "responses", "mass", "bad name"), undefined);
  const two: CaseState = { ...state, collections: { ...state.collections, responses: [...state.collections!.responses, { name: "e", type: "energy", parts: [], values: {} }] } };
  assert.equal(renameEntry(DECL, two, "responses", "mass", "e"), undefined);
});

test("dangling refs: deleted entries and empty choices are both reported", () => {
  const state = defaultCaseState(DECL);
  assert.deepEqual(danglingRefs(DECL, state), []);
  const gone: CaseState = { ...state, collections: { ...state.collections, responses: [] } };
  const problems = danglingRefs(DECL, gone);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /Objective names "mass", which is not one of the responses/);
  const empty: CaseState = {
    ...state,
    collections: { ...state.collections, constraints: [{ name: "c", type: "limit", parts: [], values: { response: "" } }] },
  };
  assert.match(danglingRefs(DECL, empty)[0].message, /Constraints "c": choose its response/);
});

test("collection problems: counts, names, duplicates, types, parts", () => {
  const state = defaultCaseState(DECL);
  const codes = (s: CaseState, paths?: string[]): string[] => collectionProblems(DECL, s, paths).map((p) => p.code);
  assert.deepEqual(codes(state), ["collection-count"]);
  assert.deepEqual(codes(withControl(state), ["Body"]), []);
  assert.deepEqual(codes(withControl(state, []), ["Body"]), ["collection-parts-count"]);
  const missing = collectionProblems(DECL, withControl(state, ["Gone"]), ["Body"]);
  assert.deepEqual(missing.map((p) => [p.code, p.smpPath]), [["collection-part-missing", "Gone"]]);
  const messy: CaseState = withControl({
    ...state,
    collections: {
      ...state.collections,
      responses: [
        { name: "mass", type: "mass", parts: [], values: {} },
        { name: "mass", type: "energy", parts: [], values: {} },
        { name: "x y", type: "energy", parts: [], values: {} },
        { name: "w", type: "nope", parts: [], values: {} },
        { name: "e", type: "energy", parts: ["Body"], values: {} },
      ],
    },
  });
  assert.deepEqual(codes(messy), ["collection-duplicate", "collection-name", "collection-type", "collection-parts-count"]);
  const damped = withControl(state);
  damped.collections!.controls[0].values.damped = ["Body", "Ghost"];
  assert.deepEqual(collectionProblems(DECL, damped, ["Body"]).map((p) => p.smpPath), ["Ghost"]);
});

test("generation refuses collection problems and hands hooks resolved collections", async () => {
  const model = parseMdpa(MDPA);
  const state = defaultCaseState(DECL);
  await assert.rejects(() => generateCase(RUNTIME, model, state, "toy"), /Controls: add at least 1/);
  let seen: unknown;
  const spy = defineProblemtype(DECL, {
    solverSettings: (_v, ctx) => {
      seen = ctx.collections;
      return {};
    },
  });
  await generateCase(spy, model, withControl(state), "toy");
  assert.deepEqual(seen, resolveCollections(DECL, withControl(state), "Structure"));
  assert.deepEqual((seen as Record<string, { modelParts: string[] }[]>).controls[0].modelParts, ["Structure.Body"]);
  assert.deepEqual((seen as Record<string, { values: unknown }[]>).controls[0].values, { variable: "YOUNG_MODULUS", damped: [] });
});

test("the validate hook only runs once the collections are sound", async () => {
  const model = parseMdpa(MDPA);
  let calls = 0;
  const rt = defineProblemtype(DECL, {
    solverSettings: () => ({}),
    validate: () => {
      calls++;
      return [];
    },
  });
  await assert.rejects(() => generateCase(rt, model, defaultCaseState(DECL), "toy"));
  assert.equal(calls, 0);
  await generateCase(rt, model, withControl(defaultCaseState(DECL)), "toy");
  assert.equal(calls, 1);
});

test("preflight keeps the collection code and the part it names", async () => {
  const model = parseMdpa(MDPA);
  const report = await preflightCase(RUNTIME, model, withControl(defaultCaseState(DECL), ["Ghost"]), "toy", { quality: false });
  const finding = report.findings.find((f) => f.code === "collection-part-missing");
  assert.ok(finding, JSON.stringify(report.findings));
  assert.equal(finding.target?.smpPath, "Ghost");
  assert.equal(report.ok, false);
  const ok = await preflightCase(RUNTIME, model, withControl(defaultCaseState(DECL)), "toy", { quality: false });
  assert.equal(ok.ok, true);
});

test("case files round-trip collections and drop malformed entries with a warning", () => {
  const state = withControl(defaultCaseState(DECL));
  const back = parseCaseJson(serializeCase(state));
  assert.deepEqual(back.warnings, []);
  assert.deepEqual(back.state!.collections, state.collections);
  const raw = JSON.parse(serializeCase(state));
  raw.collections.responses.push({ name: 3 }, "junk");
  raw.collections.broken = "nope";
  raw.collections.controls[0].parts = ["Body", 7];
  const tolerant = parseCaseJson(JSON.stringify(raw));
  assert.equal(tolerant.state!.collections!.responses.length, 1);
  assert.deepEqual(tolerant.state!.collections!.controls[0].parts, ["Body"]);
  assert.equal(tolerant.state!.collections!.broken, undefined);
  assert.equal(tolerant.warnings.length, 3);
  // A case without collections stays without the key.
  const plain = parseCaseJson(JSON.stringify({ problemtypeId: "x", values: {} }));
  assert.equal("collections" in plain.state!, false);
});

test("list fields parse comma/space separated text", () => {
  assert.deepEqual(parseListText("0.1, 0.2;3 x", "numberList"), [0.1, 0.2, 3]);
  assert.deepEqual(parseListText(" A, B  C ", "stringList"), ["A", "B", "C"]);
});
