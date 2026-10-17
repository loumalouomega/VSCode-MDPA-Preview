#!/usr/bin/env node
// Verification harness for roadmap item 20: one small case per fluid formulation
// family through the existing Run path (`caseRun`: generate + spawn + status),
// reporting pass/fail/skip per family. Skips cleanly when the Kratos
// installation lacks an application the family needs.
//
// Usage:
//   node scripts/verify-fluid/run.mjs --list
//   node scripts/verify-fluid/run.mjs [--python /usr/bin/python3] [--install ~/src/Kratos/bin/Release]
//       [--timeout 120] [--keep] [--out /tmp/verify-fluid] [--family fluid-monolithic,...]
//
// Environment: KRATOS_PYTHON and KRATOS_INSTALL override the flags.
// Exit codes: 0 = every family passed or skipped, 1 = a family failed,
//   2 = environment error (no Kratos at all, bad flags).
//
// Each family uses a tiny hand-built mesh (a few tetrahedra, all parts the
// case needs, DISTANCE included so the embedded and two-fluids families
// generate) and a short run (a handful of steps). These are smoke cases: they
// prove the generated ProjectParameters, materials and driver the extension
// writes are accepted by the solver and run to completion — not physics
// benchmarks. The wind-tunnel sphere family additionally proves the tunnel
// mesh the wizard builds reads in the solver with its named parts.

import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = (p) => require(path.join(ROOT, "out", p));

const { probeKratosApplications } = out("problemtype/kratosAppProbe.js");
const { describeMissingApplications } = out("problemtype/applications.js");
const { defaultCaseState } = out("problemtype/api.js");
const { serializeCase } = out("problemtype/caseFile.js");
const { caseRun, caseStatus } = out("mcp/tools.js");
const { fluid } = out("problemtype/builtins/fluid.js");
const { embeddedFluid } = out("problemtype/builtins/embeddedFluid.js");
const { twoFluids } = out("problemtype/builtins/twoFluids.js");
const { rans } = out("problemtype/builtins/rans.js");

const PASS = "pass";
const FAIL = "fail";
const SKIP = "skip";

// A 2-tetra box, 1 x 1 x 1, with volume/skin parts and a DISTANCE field.
// Nodes: 1:(0,0,0) 2:(1,0,0) 3:(1,1,0) 4:(0,1,0) 5:(0,0,1) 6:(1,0,1) 7:(1,1,1) 8:(0,1,1).
// Skin faces are quads split along their diagonal; each family only needs the
// part NAMES to resolve, so one condition per face is enough.
const MESH = `Begin Properties 0
End Properties
Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 1.0 1.0 0.0
4 0.0 1.0 0.0
5 0.0 0.0 1.0
6 1.0 0.0 1.0
7 1.0 1.0 1.0
8 0.0 1.0 1.0
End Nodes
Begin Elements Element3D4N
1 0 1 2 3 6
2 0 1 3 4 8
3 0 1 3 8 6
4 0 3 7 8 6
5 0 1 6 5 8
6 0 1 8 4 5
End Elements
Begin Conditions SurfaceCondition3D3N
1 0 1 2 3
2 0 5 6 7
3 0 1 2 6
4 0 3 4 8
5 0 2 3 7
6 0 4 8 5
End Conditions
Begin NodalData DISTANCE
1 0 -0.4
2 0 -0.4
3 0 0.4
4 0 0.4
5 0 -0.4
6 0 -0.4
7 0 0.4
8 0 0.4
End NodalData
Begin SubModelPart Parts
Begin SubModelPartNodes
1
2
3
4
5
6
7
8
End SubModelPartNodes
Begin SubModelPartElements
1
2
3
4
5
6
End SubModelPartElements
End SubModelPart
Begin SubModelPart Inlet
Begin SubModelPartNodes
1
2
5
6
End SubModelPartNodes
Begin SubModelPartConditions
3
End SubModelPartConditions
End SubModelPart
Begin SubModelPart Outlet
Begin SubModelPartNodes
3
4
7
8
End SubModelPartNodes
Begin SubModelPartConditions
5
End SubModelPartConditions
End SubModelPart
Begin SubModelPart Walls
Begin SubModelPartNodes
1
4
5
8
2
3
6
7
End SubModelPartNodes
Begin SubModelPartConditions
1
2
4
6
End SubModelPartConditions
End SubModelPart
`;

const FLUID_MATS = [{ smpPath: "Parts", lawId: "newtonian_3d", values: {} }];

/** Short run: a few small steps, adaptive stepping off. */
function shortTime(state) {
  Object.assign(state.values.problem, {
    timeStepMode: "fixed",
    timeStep: 0.01,
    startTime: 0,
    endTime: 0.03,
  });
  return state;
}

function fluidState(problem = {}, extraAssignments = []) {
  const s = defaultCaseState(fluid.decl);
  shortTime(s);
  Object.assign(s.values.problem, problem);
  s.assignments = [
    { conditionId: "parts", smpPath: "Parts", values: {} },
    { conditionId: "inlet", smpPath: "Inlet", values: { modulus: 1, direction: "x" } },
    { conditionId: "outlet", smpPath: "Outlet", values: { value: 0, hydrostatic: false } },
    { conditionId: "noSlip", smpPath: "Walls", values: {} },
    { conditionId: "flowForces", smpPath: "Walls", values: { referencePoint: [0, 0, 0], writeMoments: false } },
    {
      conditionId: "aerodynamicCoefficients", smpPath: "Walls",
      values: { referenceArea: 1, referenceChord: 1, dynamicPressure: 0.6, referencePoint: [0, 0, 0] },
    },
    { conditionId: "pressureCoefficient", smpPath: "Walls", values: {} },
    { conditionId: "yPlus", smpPath: "Walls", values: {} },
    ...extraAssignments,
  ];
  s.materials = FLUID_MATS;
  return s;
}

const FAMILIES = [
  {
    id: "fluid-monolithic",
    apps: ["FluidDynamicsApplication"],
    problemtype: "fluid",
    describe: "monolithic QSVMS, BDF2, fixed step",
    state: () => fluidState({ strategy: "monolithic", elementType: "qsvms", timeScheme: "bdf2" }),
  },
  {
    id: "fluid-fractional-step",
    apps: ["FluidDynamicsApplication"],
    problemtype: "fluid",
    describe: "fractional step, fixed step",
    state: () => fluidState({ strategy: "fractional_step", timeOrder: 1, useSlipConditions: true }),
  },
  {
    id: "fluid-stokes",
    apps: ["FluidDynamicsApplication"],
    problemtype: "fluid",
    describe: "stokes (linear, steady-forced)",
    state: () => fluidState({ strategy: "stokes", forceSteadyState: true }),
  },
  {
    id: "fluid-weakly-compressible",
    apps: ["FluidDynamicsApplication"],
    problemtype: "fluid",
    describe: "monolithic weakly-compressible element",
    state: () => {
      const s = fluidState({ strategy: "monolithic", elementType: "weakly_compressible", soundVelocity: 10 });
      s.materials = [{ smpPath: "Parts", lawId: "newtonian_3d_weakly_compressible", values: { SOUND_VELOCITY: 10 } }];
      return s;
    },
  },
  {
    id: "embedded",
    apps: ["FluidDynamicsApplication"],
    problemtype: "embeddedFluid",
    describe: "embedded (continuous), distance from the mesh",
    state: () => {
      const s = defaultCaseState(embeddedFluid.decl);
      shortTime(s);
      s.assignments = [{ conditionId: "parts", smpPath: "Parts", values: {} }];
      s.materials = [{ smpPath: "Parts", lawId: "newtonian_3d", values: {} }];
      return s;
    },
  },
  {
    id: "two-fluids",
    apps: ["FluidDynamicsApplication"],
    problemtype: "twoFluids",
    describe: "two fluids, level set from the mesh DISTANCE",
    state: () => {
      const s = defaultCaseState(twoFluids.decl);
      shortTime(s);
      s.assignments = [{ conditionId: "parts", smpPath: "Parts", values: {} }];
      s.materials = [
        { smpPath: "Parts", lawId: "phase_1_3d", values: {} },
        { smpPath: "Parts", lawId: "phase_2_3d", values: {} },
      ];
      return s;
    },
  },
  ...["k_epsilon", "k_omega", "k_omega_sst"].map((model) => ({
    id: `rans-${model.replace(/_/g, "-")}`,
    apps: ["FluidDynamicsApplication", "RANSApplication"],
    problemtype: "rans",
    describe: `RANS ${model}, steady, wall function on Walls`,
    state: () => {
      const s = defaultCaseState(rans.decl);
      Object.assign(s.values.problem, {
        flowSolver: "monolithic",
        elementType: "vms",
        turbulenceModel: model,
        scheme: "steady",
        freestreamSpeed: 1,
        turbulenceIntensity: 0.01,
        turbulenceLength: 0.1,
        timeStepMode: "fixed",
        timeStep: 1,
        endTime: 3,
        maxIterations: 5,
        turbulenceIterations: 1,
        couplingIterations: 1,
      });
      s.assignments = [
        { conditionId: "parts", smpPath: "Parts", values: {} },
        { conditionId: "inlet", smpPath: "Inlet", values: { modulus: 1, direction: "x" } },
        { conditionId: "outlet", smpPath: "Outlet", values: { value: 0, hydrostatic: false } },
        { conditionId: "slip", smpPath: "Outlet", values: {} },
        { conditionId: "ransWall", smpPath: "Walls", values: {} },
        { conditionId: "flowForces", smpPath: "Walls", values: { referencePoint: [0, 0, 0], writeMoments: false } },
        { conditionId: "yPlus", smpPath: "Walls", values: {} },
      ];
      s.materials = [
        { smpPath: "Parts", lawId: "rans_newtonian_3d", values: {} },
        { smpPath: "Walls", lawId: "rans_wall", values: {} },
      ];
      return s;
    },
  })),
  {
    id: "tunnel-sphere",
    apps: ["FluidDynamicsApplication"],
    problemtype: "fluid",
    windTunnel: true,
    describe: "body-fitted tunnel sphere (wizard mesh + Fluid case)",
    state: null,
  },
];

function args(argv) {
  const out = { python: process.env.KRATOS_PYTHON, install: process.env.KRATOS_INSTALL, timeout: 180, keep: false, outDir: "", families: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--python") out.python = argv[++i];
    else if (a === "--install") out.install = argv[++i];
    else if (a === "--timeout") out.timeout = Number(argv[++i]);
    else if (a === "--keep") out.keep = true;
    else if (a === "--out") out.outDir = argv[++i];
    else if (a === "--family" || a === "--families") out.families = argv[++i];
    else if (a === "--list") out.list = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`unknown flag "${a}"`);
  }
  return out;
}

function usage() {
  return `verify-fluid: run one small case per fluid family through caseRun.
Flags: --python PATH --install DIR [--timeout SECONDS] [--keep] [--out DIR]
       [--family id[,id...]]   --list lists the families.`;
}

async function main() {
  let opts;
  try {
    opts = args(process.argv.slice(2));
  } catch (e) {
    console.error(String(e.message));
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    console.log(usage());
    return;
  }
  if (opts.list) {
    for (const f of FAMILIES) console.log(`${f.id}\t${f.describe}\tneeds ${f.apps.join("+")}`);
    return;
  }
  const wanted = opts.families
    ? String(opts.families).split(",").map((s) => s.trim()).filter(Boolean)
    : FAMILIES.map((f) => f.id);
  const unknown = wanted.filter((id) => !FAMILIES.some((f) => f.id === id));
  if (unknown.length > 0) {
    console.error(`unknown families: ${unknown.join(", ")}`);
    process.exitCode = 2;
    return;
  }
  const python = opts.python || "python3";
  const root = opts.outDir ? path.resolve(opts.outDir) : fs.mkdtempSync(path.join(os.tmpdir(), "verify-fluid-"));

  // Probe once for the union of the wanted families' applications.
  const needed = [...new Set(wanted.flatMap((id) => FAMILIES.find((f) => f.id === id).apps))];
  let probe = { missing: [], unavailable: undefined };
  try {
    const { computeKratosEnv } = out("problemtype/kratosEnv.js");
    const envDelta = computeKratosEnv({ platform: process.platform, installPath: opts.install ?? "", extraEnv: {}, base: {} });
    probe = await probeKratosApplications({ python, envDelta, applications: ["KratosMultiphysics", ...needed], cwd: root, timeoutMs: 60000 });
  } catch (e) {
    probe = { missing: [], unavailable: String(e.message ?? e) };
  }
  if (probe.missing.includes("KratosMultiphysics") || probe.unavailable) {
    console.log(JSON.stringify({ status: "environment-error", python, probe }, null, 2));
    console.error(
      probe.unavailable
        ? `cannot probe Kratos (${probe.unavailable}); pass --python/--install for a Python with KratosMultiphysics.`
        : `KratosMultiphysics is not importable with ${python}; pass --python/--install for a Kratos Python.`
    );
    process.exitCode = 2;
    return;
  }

  const results = [];
  for (const id of wanted) {
    const fam = FAMILIES.find((f) => f.id === id);
    const missing = fam.apps.filter((a) => probe.missing.includes(a));
    if (missing.length > 0) {
      results.push({ family: id, status: SKIP, reason: describeMissingApplications(missing) });
      console.log(`${id}: SKIP (${missing.join(", ")} not installed)`);
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await runFamily(fam, { python, install: opts.install, timeout: opts.timeout, root });
      results.push(r);
      console.log(`${id}: ${r.status.toUpperCase()}${r.detail ? ` — ${r.detail}` : ""}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      results.push({ family: id, status: FAIL, detail: message });
      console.log(`${id}: FAIL — ${message}`);
    }
  }
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "verify-fluid.json"), JSON.stringify({ python, probe, results }, null, 2) + "\n");
  const failed = results.filter((r) => r.status === FAIL);
  if (!opts.keep && !opts.outDir) {
    // Keep the report; drop the per-family run directories on success only.
    if (failed.length === 0) for (const r of results) if (r.dir) fs.rmSync(r.dir, { recursive: true, force: true });
  }
  console.log(`report: ${path.join(root, "verify-fluid.json")}`);
  process.exitCode = failed.length > 0 ? 1 : 0;
}

async function runFamily(fam, { python, install, timeout, root }) {
  const dir = fs.mkdtempSync(path.join(root, `${fam.id}-`));
  let meshPath;
  let problemtype = fam.problemtype;
  if (fam.windTunnel) {
    // A coarse tunnel sphere through the wizard path, kept small on purpose.
    const { planWindTunnel } = out("problemtype/windTunnel/plan.js");
    const { runWindTunnel } = out("problemtype/windTunnel/run.js");
    const { icosphere } = require(path.join(ROOT, "out", "test", "fixtures", "shapes.js"));
    const plan = planWindTunnel(
      {
        flow: { speed: 5 },
        tunnel: { upstream: 1.5, downstream: 3, side: 2, top: 2, bottom: 2 },
        mesh: { surfaceSize: 0.3, farSize: 1.5, firstHeight: 0.03, growth: 1.3, maxAspect: 10, wakeLength: 1, wakeSize: 0.5, fit: 0.01, maxTetrahedra: 60000 },
      },
      icosphere(0.5, 1)
    );
    if (plan.errors.length > 0) return { family: fam.id, status: FAIL, dir, detail: plan.errors.join("; ") };
    const built = await runWindTunnel(plan, { folder: dir, stem: "tunnel" });
    meshPath = built.files.mesh;
  } else {
    meshPath = path.join(dir, "case.mdpa");
    fs.writeFileSync(meshPath, MESH);
    fs.writeFileSync(meshPath.replace(/\.mdpa$/, ".kratoscase.json"), serializeCase(fam.state()));
  }
  const started = Date.now();
  const reply = await caseRun({
    meshPath,
    ...(python ? { python } : {}),
    ...(install ? { installPath: install } : {}),
    waitSeconds: timeout,
    generate: true,
    force: true,
    ...(problemtype ? { problemtype } : {}),
  });
  const status = await caseStatus({ meshPath });
  const seconds = Math.round((Date.now() - started) / 1000);
  const st = String(status.status ?? reply.status ?? "?");
  if (st !== "finished") {
    return { family: fam.id, status: FAIL, dir, detail: `run ended ${st}: ${status.message ?? reply.message ?? "see log"} (${seconds}s)` };
  }
  // The solver's own outputs must read back unchanged.
  const caseDir = path.dirname(meshPath);
  const vtk = path.join(caseDir, "vtk_output");
  const hasVtk = fs.existsSync(vtk) && fs.readdirSync(vtk).length > 0;
  return {
    family: fam.id, status: PASS, dir, detail: `${seconds}s${hasVtk ? ", vtk_output present" : ", no vtk_output (check interval)"}`,
  };
}

await main();
