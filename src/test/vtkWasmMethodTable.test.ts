import { strict as assert } from "node:assert";
import { test } from "node:test";

import { VTK_WASM_API_USAGE } from "../parser/render/vtkWasmApiUsage";
import {
  MethodManifest,
  boolParamProblems,
  buildMethodTable,
  classifyUsage,
  lookupMethod,
  serializeMethodTable,
  suspendingMethods,
} from "../parser/render/vtkWasmMethodTable";

// Shapes copied from the pinned build's types/*.json (title/inherits/methods,
// maySuspend only on the methods that may suspend under JSPI).
const MANIFESTS: MethodManifest[] = [
  { title: "vtkObjectBase", inherits: null, methods: { GetClassName: { parameters: {} } } },
  { title: "vtkWindow", inherits: "vtkObjectBase", methods: { Render: { maySuspend: true }, SetSize: {} } },
  { title: "vtkRenderWindow", inherits: "vtkWindow", methods: { AddRenderer: {}, Frame: { maySuspend: true } } },
  { title: "vtkWebAssemblyOpenGLRenderWindow", inherits: "vtkRenderWindow", methods: { SetCanvasSelector: {} } },
  { title: "vtkProp", inherits: "vtkObjectBase", methods: { SetVisibility: {}, GetVisibility: {} } },
  { title: "vtkActor", inherits: "vtkProp", methods: { SetMapper: {} } },
];

test("buildMethodTable + lookupMethod resolve through inheritance, in both spellings", () => {
  const t = buildMethodTable(MANIFESTS);
  assert.deepEqual(lookupMethod(t, "vtkActor", "SetVisibility"), { cxxName: "SetVisibility", maySuspend: false, declaredOn: "vtkProp" });
  assert.deepEqual(lookupMethod(t, "vtkActor", "setVisibility"), { cxxName: "SetVisibility", maySuspend: false, declaredOn: "vtkProp" });
  assert.deepEqual(lookupMethod(t, "vtkWebAssemblyOpenGLRenderWindow", "render"), { cxxName: "Render", maySuspend: true, declaredOn: "vtkWindow" });
  assert.equal(lookupMethod(t, "vtkActor", "Render"), undefined);
  assert.equal(lookupMethod(t, "vtkNoSuchClass", "Render"), undefined);
  // Own-property lookups only: prototype names are not methods.
  assert.equal(lookupMethod(t, "vtkActor", "constructor"), undefined);
  assert.equal(lookupMethod(t, "vtkActor", "__proto__"), undefined);
});

test("serializeMethodTable is stable and in the loader's compact {inherits, methods:{Name:0|1}} form", () => {
  const a = serializeMethodTable(buildMethodTable(MANIFESTS));
  const b = serializeMethodTable(buildMethodTable([...MANIFESTS].reverse()));
  assert.equal(a, b);
  const parsed = JSON.parse(a);
  assert.deepEqual(parsed.vtkWindow, { inherits: "vtkObjectBase", methods: { Render: 1, SetSize: 0 } });
  assert.deepEqual(Object.keys(parsed), [...Object.keys(parsed)].sort());
});

test("suspendingMethods lists exactly the maySuspend entries", () => {
  assert.deepEqual(suspendingMethods(buildMethodTable(MANIFESTS)), ["vtkRenderWindow::Frame", "vtkWindow::Render"]);
});

test("classifyUsage flags unknown classes, missing methods and suspend mismatches", () => {
  const t = buildMethodTable(MANIFESTS);
  const { resolved, problems } = classifyUsage(t, [
    { cls: "vtkActor", method: "SetMapper" },
    { cls: "vtkActor", method: "SetVisibility" },
    { cls: "vtkWebAssemblyOpenGLRenderWindow", method: "Render", expectSuspend: true },
    { cls: "vtkWebAssemblyOpenGLRenderWindow", method: "Frame" },
    { cls: "vtkActor", method: "AddActor2D" },
    { cls: "vtkGhost", method: "Boo" },
    { cls: "vtkActor", method: "GetVisibility", expectSuspend: true },
  ]);
  assert.equal(resolved.length, 5);
  assert.deepEqual(
    problems.map((p) => `${p.problem}:${p.entry.method}`),
    ["unexpected-suspend:Frame", "missing-method:AddActor2D", "unknown-class:Boo", "expected-suspend-missing:GetVisibility"]
  );
});

test("the declared backend usage list is well-formed", () => {
  const seen = new Set<string>();
  for (const e of VTK_WASM_API_USAGE) {
    assert.match(e.cls, /^vtk[A-Z0-9]/, e.cls);
    assert.match(e.method, /^[A-Z][A-Za-z0-9]*$/, `${e.cls}::${e.method} must use the C++ spelling`);
    const key = `${e.cls}::${e.method}`;
    assert.ok(!seen.has(key), `duplicate ${key}`);
    seen.add(key);
  }
  // Only Render is routed through invokeAsync by design.
  assert.deepEqual(
    VTK_WASM_API_USAGE.filter((e) => e.expectSuspend).map((e) => e.method),
    ["Render"]
  );
});

test("boolParamProblems holds the declared C++-bool list to the manifests in both directions", () => {
  const manifests = [
    { title: "vtkBase", inherits: null, methods: { SetFlag: { parameters: { _arg: { type: "Int32" } } }, SetOn: { parameters: { _arg: { type: "boolean" } } } } },
    { title: "vtkChild", inherits: "vtkBase", methods: { SetOther: { parameters: { _arg: { type: "boolean" } } } } },
  ];
  const usage = [
    { cls: "vtkChild", method: "SetFlag" },
    { cls: "vtkChild", method: "SetOn" },
    { cls: "vtkChild", method: "SetOther" },
    { cls: "vtkChild", method: "Missing" },
  ];
  assert.deepEqual(boolParamProblems(manifests, usage, new Set(["SetOn", "SetOther"])), []);
  assert.deepEqual(boolParamProblems(manifests, usage, new Set(["SetOn"])), ["bool-param-undeclared: vtkChild::SetOther"]);
  assert.deepEqual(boolParamProblems(manifests, usage, new Set(["SetOn", "SetOther", "SetFlag"])), ["bool-param-stale: vtkChild::SetFlag"]);
});
