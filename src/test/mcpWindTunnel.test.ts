import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { icosphere } from "./fixtures/shapes";
import { writeMeshFile } from "../parser/writers/meshWriter";
import { windTunnelPlanTool, windTunnelGenerate, meshCapabilities } from "../mcp/tools";

const request = (bodyPath: string) => ({
  bodyPath,
  flow: { speed: 10 },
  tunnel: { upstream: 1.5, downstream: 3, side: 2, top: 2, bottom: 2 },
  mesh: { surfaceSize: 0.15, farSize: 1.0, firstHeight: 0.015, growth: 1.3, maxAspect: 10, wakeLength: 1, wakeSize: 0.3 },
});

function bodyFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpvwt-"));
  const file = path.join(dir, "ball.stl");
  fs.writeFileSync(file, writeMeshFile(icosphere(0.5, 3), ".stl"));
  return file;
}

test("wind_tunnel_plan reports the body, the tunnel, the boundary layer and the cost without meshing", async () => {
  const plan = (await windTunnelPlanTool(request(bodyFile()))) as Record<string, any>;
  assert.equal(plan.runnable, true);
  assert.ok(Math.abs(plan.body.size[0] - 1) < 0.02);
  assert.ok(plan.body.closed);
  assert.ok(plan.estimate.expectedTetrahedra > 1000);
  assert.ok(plan.boundaryLayer.firstHeight > 0);
  assert.deepEqual(plan.steps.map((s: { id: string }) => s.id).filter((i: string) => !i.startsWith("size-")), ["body", "lattice", "carve", "tidy", "snap", "wall", "check", "write"]);
  assert.ok(Array.isArray(plan.case) && plan.case.length > 0);
  const bad = (await windTunnelPlanTool({ ...request(bodyFile()), mesh: { maxTetrahedra: 100 } })) as Record<string, any>;
  assert.equal(bad.runnable, false);
  await assert.rejects(windTunnelPlanTool({ bodyPath: "/nonexistent.stl", flow: { speed: 10 } }), /not found/i);
  await assert.rejects(windTunnelPlanTool({ ...request(bodyFile()), flow: { speed: 0 } }), /flow\.speed/);
});

test("wind_tunnel_generate writes the mesh, the case and the solver files, and refuses to overwrite", async () => {
  const body = bodyFile();
  const out = path.join(path.dirname(body), "out");
  const seen: string[] = [];
  const res = (await windTunnelGenerate({ ...request(body), outputFolder: out, stem: "ball", generateCase: true }, { progress: (_d, _t, label) => { seen.push(label); } })) as Record<string, any>;
  assert.ok(seen.some((l) => /Carve/.test(l)) && seen.some((l) => /wall layer/i.test(l)));
  assert.equal(res.problemtype, "fluid");
  assert.equal(res.report.check.inverted, 0);
  assert.ok(fs.existsSync(path.join(out, "ball.mdpa")) && fs.existsSync(path.join(out, "ball.kratoscase.json")));
  const names = fs.readdirSync(out);
  assert.ok(names.includes("ProjectParameters.json") && names.includes("MainKratos.py"), names.join(","));
  await assert.rejects(windTunnelGenerate({ ...request(body), outputFolder: out, stem: "ball" }), /already exist/);
  const caps = (await meshCapabilities()) as Record<string, any>;
  assert.ok(caps.windTunnel.tools.includes("wind_tunnel_generate"));
});
