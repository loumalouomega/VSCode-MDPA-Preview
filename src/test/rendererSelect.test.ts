import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  DEFAULT_RENDERER,
  fallbackMessage,
  parseRendererSetting,
  selectRendererAtHost,
} from "../parser/render/rendererSelect";

test("parseRendererSetting accepts the two values and defaults to vtk.js", () => {
  assert.equal(DEFAULT_RENDERER, "vtkjs");
  assert.equal(parseRendererSetting("vtkwasm"), "vtkwasm");
  assert.equal(parseRendererSetting("vtkjs"), "vtkjs");
  for (const junk of [undefined, null, "", "VTKWASM", 3, {}]) assert.equal(parseRendererSetting(junk), "vtkjs");
});

test("the host picks VTK-wasm only when requested AND its runtime ships", () => {
  assert.deepEqual(selectRendererAtHost("vtkjs", true), { renderer: "vtkjs" });
  assert.deepEqual(selectRendererAtHost("vtkwasm", true), { renderer: "vtkwasm" });
  assert.deepEqual(selectRendererAtHost("vtkwasm", false), { renderer: "vtkjs", fallbackReason: "assets-missing" });
});

test("every fallback message names the cause and that vtk.js is in use", () => {
  for (const r of ["assets-missing", "no-jspi", "no-webgl2", "boot-failed", "boot-timeout"] as const) {
    const m = fallbackMessage(r);
    assert.ok(m.startsWith("VTK-wasm renderer unavailable — "), m);
    assert.ok(m.endsWith("using vtk.js."), m);
  }
  assert.ok(fallbackMessage("boot-failed", "LinkError").includes("(LinkError)"));
});
