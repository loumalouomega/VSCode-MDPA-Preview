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
// Roadmap item 21 adds, to the same harness: the three RANS models on the wizard's
// body-fitted sphere (first row in the logarithmic layer, y+ read back and compared
// with the report's), periodic pairs for the core Fluid process and the exact nodal
// RANS one (the pairing is checked on the result, not only accepted), and the stop
// behavior (`case_run` then `case_stop`: the cooperative sentinel rung, `cancelled`
// status, partial outputs and log readable). They run with the other families.
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
const { caseRun, caseStatus, caseStop } = out("mcp/tools.js");
const { latestResultFile } = out("problemtype/runCore.js");
const { parseMeshFile } = out("parser/meshFileParser.js");
const { fluid } = out("problemtype/builtins/fluid.js");
const { embeddedFluid } = out("problemtype/builtins/embeddedFluid.js");
const { twoFluids } = out("problemtype/builtins/twoFluids.js");
const { rans } = out("problemtype/builtins/rans.js");

const PASS = "pass";
const FAIL = "fail";
const SKIP = "skip";
// A run that fails with the signature of a documented upstream Kratos bug: reported, not a failure of this repository.
const KNOWN = "known-upstream-bug";

// A 2-tetra box, 1 x 1 x 1, with volume/skin parts. The DISTANCE field is
// appended only for the families whose solver reads it (embedded, two
// fluids): the plain Fluid solver refuses unknown nodal variables.
const MESH_BASE = `Begin Properties 0
End Properties
Begin Nodes
1 0.0 0.0 0.0
2 0.0 0.0 1.0
3 0.0 1.0 0.0
4 0.0 1.0 1.0
5 1.0 0.0 0.0
6 1.0 0.0 1.0
7 1.0 1.0 0.0
8 1.0 1.0 1.0
9 2.0 0.0 0.0
10 2.0 0.0 1.0
11 2.0 1.0 0.0
12 2.0 1.0 1.0
End Nodes
Begin Elements Element3D4N
1 0 1 5 7 8
2 0 1 6 5 8
3 0 1 7 3 8
4 0 1 3 4 8
5 0 1 2 6 8
6 0 1 4 2 8
7 0 5 9 11 12
8 0 5 10 9 12
9 0 5 11 7 12
10 0 5 7 8 12
11 0 5 6 10 12
12 0 5 8 6 12
End Elements
Begin Conditions SurfaceCondition3D3N
1 0 1 5 7
2 0 1 6 5
3 0 1 7 3
4 0 7 3 8
5 0 1 3 4
6 0 3 4 8
7 0 1 2 6
8 0 2 6 8
9 0 1 4 2
10 0 4 2 8
11 0 5 9 11
12 0 9 11 12
13 0 5 10 9
14 0 10 9 12
15 0 5 11 7
16 0 11 7 12
17 0 7 8 12
18 0 5 6 10
19 0 6 10 12
20 0 8 6 12
End Conditions
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
9
10
11
12
End SubModelPartNodes
Begin SubModelPartElements
1
2
3
4
5
6
7
8
9
10
11
12
End SubModelPartElements
End SubModelPart
Begin SubModelPart Inlet
Begin SubModelPartNodes
1
2
3
4
End SubModelPartNodes
Begin SubModelPartConditions
5
9
End SubModelPartConditions
End SubModelPart
Begin SubModelPart Outlet
Begin SubModelPartNodes
9
10
11
12
End SubModelPartNodes
Begin SubModelPartConditions
12
14
End SubModelPartConditions
End SubModelPart
Begin SubModelPart Walls
Begin SubModelPartNodes
5
6
7
8
End SubModelPartNodes
Begin SubModelPartConditions
1
2
3
4
6
7
8
10
11
13
15
16
17
18
19
20
End SubModelPartConditions
End SubModelPart
`;
const MESH = MESH_BASE;
const MESH_DISTANCE = MESH_BASE + `Begin NodalData DISTANCE
1 0 -0.4
2 0 -0.4
3 0 -0.4
4 0 -0.4
5 0 -0.4
6 0 -0.4
7 0 -0.4
8 0 -0.4
9 0 0.4
10 0 0.4
11 0 0.4
12 0 0.4
End NodalData
`;


// --- reading a case's results back through the extension's own reader -------------------------

/** The newest result file of a case, parsed by the same reader the preview uses. */
async function readLatest(caseDir, { excludeNewest = false } = {}) {
  const dir = path.join(caseDir, "vtk_output");
  if (!fs.existsSync(dir)) return undefined;
  const latest = latestResultFile(fs.readdirSync(dir), { excludeNewest });
  if (!latest) return undefined;
  return { fileName: latest.fileName, model: await parseMeshFile(path.join(dir, latest.fileName)) };
}

const nodalField = (model, variable) => model.fields.find((f) => f.variable === variable && f.kind === "Nodal");

/** Share and mean of the positive values of a nodal scalar (y+ is written 0 off the wall). */
function wallStats(model, variable) {
  const f = nodalField(model, variable);
  if (!f) return undefined;
  const v = Array.from(f.values).filter((x) => Number.isFinite(x) && x > 0);
  if (v.length === 0) return { count: 0, mean: NaN, inLog: 0 };
  return { count: v.length, mean: v.reduce((a, b) => a + b, 0) / v.length, inLog: v.filter((x) => x >= 30 && x <= 300).length / v.length };
}

/**
 * Largest difference between each node on y = 0 and its partner on y = 1 (same x and z),
 * relative to max(1, |value|), for the given nodal variables. A periodic pair holds the same
 * value on both sides, so this is the check that the pairing really constrained the solve.
 */
function periodicMismatch(model, variables) {
  const c = model.coords;
  const n = model.nodeIds.length;
  const key = (i) => `${c[3 * i].toFixed(6)}|${c[3 * i + 2].toFixed(6)}`;
  const top = new Map();
  for (let i = 0; i < n; i++) if (Math.abs(c[3 * i + 1] - 1) < 1e-6) top.set(key(i), i);
  const worst = {};
  let pairs = 0;
  for (const name of variables) {
    const f = nodalField(model, name);
    if (!f) throw new Error(`the result has no ${name}`);
    const row = new Map(Array.from(f.ids, (id, i) => [id, i]));
    let worstHere = 0;
    for (let i = 0; i < n; i++) {
      if (Math.abs(c[3 * i + 1]) > 1e-6) continue;
      const j = top.get(key(i));
      if (j === undefined) throw new Error(`node at (${key(i)}) has no partner on y = 1`);
      if (name === variables[0]) pairs++;
      const a = row.get(model.nodeIds[i]);
      const b = row.get(model.nodeIds[j]);
      for (let k = 0; k < f.components; k++) {
        const va = f.values[a * f.components + k];
        const vb = f.values[b * f.components + k];
        worstHere = Math.max(worstHere, Math.abs(va - vb) / Math.max(1, Math.abs(va), Math.abs(vb)));
      }
    }
    worst[name] = worstHere;
  }
  return { pairs, worst };
}

/**
 * MESH_BASE with the side walls split into the periodic pair (YMin and YMax, the y = 0 and y = 1
 * faces) and Walls (the z faces only). Inlet and Outlet are rebuilt the same way, from the
 * facets' own coordinates, so the pairing needs no hand-kept id lists.
 *
 * Condition ids matter to the RANS periodic path: its formulation numbers the periodic conditions
 * it creates k+1 .. k+m (k = the conditions of the skin parts, m = the slave nodes) and the process
 * has already added m root conditions after the largest id, so an id in that range collides
 * ("a condition with the same Id already exists"). `gap` numbers the skin facets 1..k and puts the
 * pair's own facets far above, which leaves that range free; without it the ids are contiguous 1..N.
 */
function periodicMeshText({ gap = true } = {}) {
  const nodeBlock = MESH_BASE.slice(MESH_BASE.indexOf("Begin Nodes"), MESH_BASE.indexOf("End Nodes"));
  const xyz = new Map();
  for (const line of nodeBlock.split("\n")) {
    const t = line.trim().split(/\s+/);
    if (t.length === 4 && /^\d+$/.test(t[0])) xyz.set(Number(t[0]), t.slice(1).map(Number));
  }
  const condStart = MESH_BASE.indexOf("Begin Conditions");
  const condBlock = MESH_BASE.slice(MESH_BASE.indexOf("\n", condStart), MESH_BASE.indexOf("End Conditions"));
  const parts = { Inlet: [], Outlet: [], Walls: [], YMin: [], YMax: [] };
  for (const line of condBlock.split("\n")) {
    const t = line.trim().split(/\s+/).map(Number);
    if (t.length !== 5 || t.some((x) => !Number.isFinite(x))) continue;
    const [, , ...ns] = t;
    const pts = ns.map((nid) => xyz.get(nid));
    const flat = (axis, v) => pts.every((q) => Math.abs(q[axis] - v) < 1e-9);
    const cond = { ns };
    if (flat(0, 0)) parts.Inlet.push(cond);
    else if (flat(0, 2)) parts.Outlet.push(cond);
    else if (flat(1, 0)) parts.YMin.push(cond);
    else if (flat(1, 1)) parts.YMax.push(cond);
    else if (flat(2, 0) || flat(2, 1)) parts.Walls.push(cond);
    else throw new Error("a facet lies on no box face");
  }
  // Skin facets first (1..k), then the pair's facets: contiguous, or a gap of 1000 above the skin.
  let next = 1;
  for (const name of ["Inlet", "Outlet", "Walls"]) for (const c of parts[name]) c.id = next++;
  next = gap ? 1001 : next;
  for (const name of ["YMin", "YMax"]) for (const c of parts[name]) c.id = next++;
  const head = MESH_BASE.slice(0, condStart);
  const middle = MESH_BASE.slice(MESH_BASE.indexOf("Begin SubModelPart Parts"), MESH_BASE.indexOf("Begin SubModelPart Inlet"));
  let out = `${head}Begin Conditions SurfaceCondition3D3N\n`;
  for (const name of Object.keys(parts)) for (const c of parts[name]) out += `${c.id} 0 ${c.ns.join(" ")}\n`;
  out += `End Conditions\n${middle}`;
  for (const [name, conds] of Object.entries(parts)) {
    const nodes = [...new Set(conds.flatMap((c) => c.ns))].sort((x, y) => x - y);
    out += `Begin SubModelPart ${name}\nBegin SubModelPartNodes\n${nodes.join("\n")}\nEnd SubModelPartNodes\n`;
    out += `Begin SubModelPartConditions\n${conds.map((c) => c.id).join("\n")}\nEnd SubModelPartConditions\nEnd SubModelPart\n`;
  }
  return out;
}

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


/** A steady RANS channel case on the 2-tetra box (Walls is the wall-function part). */
function ransState(model, { assignments, mesh = "box" } = {}) {
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
  s.assignments = assignments ?? [
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
}

/** Fluid periodic channel: the y = 0 face is the slave of y = 1, the core periodic process. */
function fluidPeriodicState() {
  const s = defaultCaseState(fluid.decl);
  shortTime(s);
  Object.assign(s.values.problem, { strategy: "monolithic", elementType: "qsvms", timeScheme: "bossak", considerPeriodic: true });
  s.assignments = [
    { conditionId: "parts", smpPath: "Parts", values: {} },
    { conditionId: "inlet", smpPath: "Inlet", values: { modulus: 1, direction: "x" } },
    { conditionId: "outlet", smpPath: "Outlet", values: { value: 0, hydrostatic: false } },
    // No no-slip walls: every inlet node of this box lies on a z face, so a wall there would zero the whole flow.
    // The translation runs from the master (y = 1) to the slave (y = 0), for both periodic processes. The sign was
    // once documented the other way round; a pair that does not match creates zero constraints and still "runs".
    { conditionId: "periodic", smpPath: "YMin", values: { master: "YMax", translation: [0, -1, 0], magnitude: 1 } },
  ];
  s.materials = FLUID_MATS;
  s.output = { ...s.output, controlType: "step", interval: 1 };
  return s;
}

/** RANS periodic channel: the exact nodal process ties the turbulence variables as well. */
function ransPeriodicState(model, translation) {
  const s = ransState(model, {
    assignments: [
      { conditionId: "parts", smpPath: "Parts", values: {} },
      { conditionId: "inlet", smpPath: "Inlet", values: { modulus: 1, direction: "x" } },
      { conditionId: "outlet", smpPath: "Outlet", values: { value: 0, hydrostatic: false } },
      { conditionId: "ransWall", smpPath: "Walls", values: {} },
      { conditionId: "periodic", smpPath: "YMin", values: { master: "YMax", translation, magnitude: 1 } },
    ],
  });
  s.values.problem.considerPeriodic = true;
  s.output = { ...s.output, controlType: "step", interval: 1 };
  return s;
}

/** A case that runs far longer than the harness waits, writing a result every few steps. */
function longRunState(kind) {
  const s = kind === "rans" ? ransState("k_epsilon") : fluidState({ strategy: "monolithic", elementType: "qsvms", timeScheme: "bossak" });
  // A steady RANS run stops itself at convergence within a few steps; a transient one keeps going.
  if (kind === "rans") Object.assign(s.values.problem, { scheme: "bossak", timeStepMode: "fixed", timeStep: 1e-3, endTime: 1000, maxIterations: 5 });
  else Object.assign(s.values.problem, { timeStepMode: "fixed", timeStep: 1e-4, endTime: 1000 });
  s.output = { ...s.output, controlType: "step", interval: 2 };
  return s;
}

/**
 * What a wind-tunnel family's solver output says about the wall: the y+ the report planned for the
 * first row against the y+ the solver wrote on the wall (printed, so a drift is visible; the pass
 * criterion is that the variable exists and is finite, not a tolerance this harness would invent).
 */
async function checkTunnelWall(fam, { caseDir, built }) {
  const latest = await readLatest(caseDir);
  if (!latest) throw new Error("no readable result in vtk_output");
  const variable = fam.turbulence ? "RANS_Y_PLUS" : "Y_PLUS";
  const stats = wallStats(latest.model, variable);
  if (!stats) throw new Error(`${variable} is not in ${latest.fileName}; the output list the case writes lacks it`);
  if (!(stats.count > 0) || !Number.isFinite(stats.mean)) throw new Error(`${variable} has no positive wall values in ${latest.fileName}`);
  const planned = built.report.firstLayer?.yPlus;
  const ratio = planned ? stats.mean / planned : NaN;
  return `${variable} mean ${stats.mean.toFixed(1)} on ${stats.count} nodes, ${(stats.inLog * 100).toFixed(0)}% in 30–300; report y+ ${planned?.toFixed(1) ?? "?"} (solver/report ${Number.isFinite(ratio) ? ratio.toFixed(2) : "?"})`;
}

async function checkPeriodic(fam, { caseDir }) {
  const latest = await readLatest(caseDir);
  if (!latest) throw new Error("no readable result in vtk_output");
  const { pairs, worst } = periodicMismatch(latest.model, fam.pairedVariables);
  const speed = Math.max(...Array.from(nodalField(latest.model, "VELOCITY").values, Math.abs));
  if (!(speed > 0)) throw new Error("the velocity is zero everywhere: the solve did not run");
  const bad = Object.entries(worst).filter(([, w]) => !(w < 1e-6));
  if (bad.length > 0) throw new Error(`the pair differs: ${bad.map(([k, w]) => `${k} ${w.toExponential(2)}`).join(", ")} over ${pairs} node pairs`);
  return `${pairs} node pairs agree (${Object.entries(worst).map(([k, w]) => `${k} ${w.toExponential(1)}`).join(", ")})`;
}

const FAMILIES = [
  {
    id: "fluid-monolithic",
    apps: ["FluidDynamicsApplication"],
    problemtype: "fluid",
    describe: "monolithic QSVMS, Bossak, fixed step",
    state: () => fluidState({ strategy: "monolithic", elementType: "qsvms", timeScheme: "bossak" }),
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
      // The weakly compressible element integrates in time, so BDF2 (which a
      // classic element must not use, see the monolithic family) applies here.
      const s = fluidState({ strategy: "monolithic", elementType: "weakly_compressible", soundVelocity: 10, timeScheme: "bdf2" });
      s.materials = [{ smpPath: "Parts", lawId: "newtonian_3d", values: {} }];
      return s;
    },
  },
  {
    id: "embedded",
    apps: ["FluidDynamicsApplication"],
    problemtype: "embeddedFluid",
    describe: "embedded (continuous), distance from the mesh",
    needsDistance: true,
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
    needsDistance: true,
    // Kratos 10.4.3 and 10.4.4: the serial wrapper imports `navier_stokes_two_fluid_solver`; only the plural module ships.
    upstreamBug: {
      note: "the serial two-fluids wrapper names KratosMultiphysics.FluidDynamicsApplication.navier_stokes_two_fluid_solver, which Kratos does not ship (only navier_stokes_two_fluids_solver exists)",
      matches: ({ log }) => /No module named 'KratosMultiphysics\.FluidDynamicsApplication\.navier_stokes_two_fluid_solver'/.test(log),
    },
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
    state: () => ransState(model),
  })),
  {
    id: "tunnel-sphere",
    apps: ["FluidDynamicsApplication"],
    problemtype: "fluid",
    windTunnel: true,
    describe: "body-fitted tunnel sphere (wizard mesh + Fluid case)",
    state: null,
    check: checkTunnelWall,
  },
  // Item 21: the three RANS models on the wizard's sphere. The first row targets y+ 50 (the logarithmic
  // layer), so the wall function sees the layer it assumes; the report's y+ is compared with the solver's.
  ...["k_epsilon", "k_omega", "k_omega_sst"].map((model) => ({
    id: `tunnel-sphere-rans-${model.replace(/_/g, "-")}`,
    apps: ["FluidDynamicsApplication", "RANSApplication"],
    problemtype: "rans",
    windTunnel: true,
    turbulence: model,
    timeout: 1800,
    endTime: 6,
    maxTetrahedra: 150000,
    describe: `body-fitted tunnel sphere, RANS ${model}, first row at y+ 50`,
    state: null,
    check: checkTunnelWall,
  })),
  // Item 21: periodic pairs. The mesh splits the side walls into the pair; the result is read back and
  // every y = 0 node must equal its y = 1 partner.
  {
    id: "fluid-periodic",
    apps: ["FluidDynamicsApplication"],
    problemtype: "fluid",
    describe: "channel with a periodic y pair, core ApplyPeriodicConditionProcess",
    mesh: periodicMeshText,
    state: fluidPeriodicState,
    pairedVariables: ["VELOCITY", "PRESSURE"],
    check: checkPeriodic,
  },
  ...["k_epsilon", "k_omega"].map((model) => ({
    id: `rans-periodic-${model.replace(/_/g, "-")}`,
    apps: ["FluidDynamicsApplication", "RANSApplication"],
    problemtype: "rans",
    describe: `RANS ${model} channel with a periodic y pair, ApplyExactNodalPeriodicConditionProcess`,
    mesh: periodicMeshText,
    state: () => ransPeriodicState(model, [0, -1, 0]),
    pairedVariables: ["VELOCITY", "PRESSURE", "TURBULENT_KINETIC_ENERGY"],
    check: checkPeriodic,
  })),
  // Item 21 (upstream watch): monolithic BDF2 with a classic element segfaults stock Kratos 10.4.3 and 10.4.4 after the
  // first step starts. The generator keeps BDF2 as an option (it is what Kratos' own tests use) and defaults to Bossak;
  // this family says when Kratos fixes it. A crash is KNOWN; a completed run means the guard can be revisited.
  {
    id: "watch-bdf2-classic",
    apps: ["FluidDynamicsApplication"],
    problemtype: "fluid",
    describe: "upstream watch: monolithic BDF2 with the classic QSVMS element (segfaults stock Kratos through 10.4.4)",
    state: () => fluidState({ strategy: "monolithic", elementType: "qsvms", timeScheme: "bdf2" }),
    upstreamBug: {
      note: "monolithic BDF2 with a classic element segfaults stock Kratos in the first time step",
      matches: ({ log }) => /Fluid Dynamics Analysis: STEP/.test(log) && !/Analysis -END-/.test(log),
    },
  },
  // Item 21: stop behavior, through case_run and case_stop.
  {
    id: "stop-fluid",
    apps: ["FluidDynamicsApplication"],
    problemtype: "fluid",
    describe: "case_run then case_stop on a long Fluid run: sentinel rung, cancelled, outputs and log readable",
    stop: true,
    state: () => longRunState("fluid"),
  },
  {
    id: "stop-rans",
    apps: ["FluidDynamicsApplication", "RANSApplication"],
    problemtype: "rans",
    describe: "case_run then case_stop on a long RANS run (the RANS driver honours the sentinel too)",
    stop: true,
    state: () => longRunState("rans"),
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
  fs.mkdirSync(root, { recursive: true });

  // Probe once for the union of the wanted families' applications.
  const needed = [...new Set(wanted.flatMap((id) => FAMILIES.find((f) => f.id === id).apps))];
  let probe = { missing: [], unavailable: undefined };
  try {
    const { computeKratosEnv } = out("problemtype/kratosEnv.js");
    const envDelta = computeKratosEnv({ platform: process.platform, installPath: opts.install ?? "", extraEnv: {}, base: {} });
    probe = await probeKratosApplications({ python, envDelta, applications: needed, cwd: root, timeoutMs: 60000 });
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
      const r = await runFamily(fam, { python, install: opts.install, timeout: Math.max(opts.timeout, fam.timeout ?? 0), root });
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
  if (fam.stop) return runStopFamily(fam, { python, install, dir });
  let meshPath;
  let tunnelBuilt;
  let problemtype = fam.problemtype;
  if (fam.windTunnel) {
    // A coarse tunnel sphere through the wizard path, kept small on purpose,
    // with the run shortened to a fixed-step smoke (the wizard's own case
    // runs ten adaptive flow-throughs, far too long for a smoke test).
    const { planWindTunnel } = out("problemtype/windTunnel/plan.js");
    const { runWindTunnel } = out("problemtype/windTunnel/run.js");
    const { icosphere } = require(path.join(ROOT, "out", "test", "fixtures", "shapes.js"));
    const { parseCaseJson, caseFilePath } = out("problemtype/caseFile.js");
    const turbulent = fam.turbulence !== undefined;
    // The wizard calls this flow laminar below Re 5e5 and then plans a Blasius layer, never the wall-function path; the
    // turbulent families run at 20 m/s (Re about 1.1e6 on the 0.85 m body) so the y+ 50 first row is the one being checked.
    const speed = turbulent ? 20 : 5;
    const plan = planWindTunnel(
      {
        flow: { speed, ...(turbulent ? { turbulence: fam.turbulence, turbulenceIntensity: 0.01, turbulenceLength: 0.05 } : {}) },
        tunnel: { upstream: 1.5, downstream: 3, side: 2, top: 2, bottom: 2 },
        mesh: {
          surfaceSize: 0.4, farSize: 2.0, growth: 1.3, maxAspect: turbulent ? 50 : 10, wakeLength: 1, wakeSize: 0.8, fit: 0.02,
          maxTetrahedra: fam.maxTetrahedra ?? 20000,
          // A wall function wants the first node in the logarithmic layer; the Fluid smoke keeps its coarse 5 cm row.
          ...(turbulent ? { yPlus: 50 } : { firstHeight: 0.05 }),
        },
      },
      icosphere(0.5, 0)
    );
    if (plan.errors.length > 0) return { family: fam.id, status: FAIL, dir, detail: plan.errors.join("; ") };
    const built = await runWindTunnel(plan, { folder: dir, stem: "tunnel" });
    meshPath = built.files.mesh;
    tunnelBuilt = built;
    const flowThrough = plan.body.size[0] / speed;
    const saved = parseCaseJson(fs.readFileSync(caseFilePath(meshPath), "utf8"));
    if (saved.state && turbulent) {
      // Steady RANS: pseudo-time steps of one; stop at the solver's own convergence or the step cap.
      Object.assign(saved.state.values.problem, { endTime: fam.endTime ?? 60 });
      saved.state.output = { ...saved.state.output, controlType: "step", interval: 20 };
      fs.writeFileSync(caseFilePath(meshPath), serializeCase(saved.state));
    } else if (saved.state) {
      Object.assign(saved.state.values.problem, {
        timeStepMode: "fixed", timeStep: flowThrough * 0.01, endTime: flowThrough * 0.5,
      });
      saved.state.output = { ...saved.state.output, controlType: "time", interval: flowThrough * 0.1 };
      fs.writeFileSync(caseFilePath(meshPath), serializeCase(saved.state));
    }
  } else {
    meshPath = path.join(dir, "case.mdpa");
    fs.writeFileSync(meshPath, fam.mesh ? fam.mesh() : fam.needsDistance ? MESH_DISTANCE : MESH);
    fs.writeFileSync(meshPath.replace(/\.mdpa$/, ".kratoscase.json"), serializeCase(fam.state()));
  }
  const started = Date.now();
  const reply = await caseRun({
    meshPath,
    ...(python ? { python } : {}),
    ...(install ? { installPath: install } : {}),
    // case_run caps its own wait at 600 s (a handoff, not a failure): a longer family polls case_status itself.
    waitSeconds: Math.min(timeout, 600),
    generate: true,
    force: true,
    ...(problemtype ? { problemtype } : {}),
  });
  let status = await caseStatus({ meshPath });
  for (const deadline = Date.now() + timeout * 1000; status.status === "detached" && Date.now() < deadline; ) {
    await new Promise((r) => setTimeout(r, 5000));
    status = await caseStatus({ meshPath });
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  const st = String(status.status ?? reply.status ?? "?");
  if (st !== "finished") {
    if (fam.upstreamBug) {
      const logFile = path.join(path.dirname(meshPath), "case.kratosrun.log");
      const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
      if (fam.upstreamBug.matches({ log, status: st })) return { family: fam.id, status: KNOWN, dir, detail: fam.upstreamBug.note };
    }
    return { family: fam.id, status: FAIL, dir, detail: `run ended ${st}: ${status.message ?? reply.message ?? "see log"} (${seconds}s)` };
  }
  const fixed = fam.upstreamBug ? "; the upstream bug this family watches did not occur — check whether it is fixed and drop its documentation" : "";
  // The solver's own outputs must read back unchanged.
  const caseDir = path.dirname(meshPath);
  const vtk = path.join(caseDir, "vtk_output");
  const hasVtk = fs.existsSync(vtk) && fs.readdirSync(vtk).length > 0;
  let extra = "";
  if (fam.check) {
    try {
      extra = `; ${await fam.check(fam, { caseDir, meshPath, built: tunnelBuilt })}`;
    } catch (e) {
      return { family: fam.id, status: FAIL, dir, detail: `ran to completion, but ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return {
    family: fam.id, status: PASS, dir, detail: `${seconds}s${hasVtk ? ", vtk_output present" : ", no vtk_output (check interval)"}${extra}${fixed}`,
  };
}

/**
 * Stop behavior through the MCP pair: start a run that outlasts the harness, wait for a result
 * file, `case_stop`, then read the status, the partial outputs and the log back (twice, so a
 * status that changes under a reader shows up). The stop must take the cooperative rung: the
 * solver leaves its loop, finalizes and exits 0, so the last result is a complete file.
 */
async function runStopFamily(fam, { python, install, dir }) {
  const meshPath = path.join(dir, "case.mdpa");
  fs.writeFileSync(meshPath, MESH);
  fs.writeFileSync(meshPath.replace(/\.mdpa$/, ".kratoscase.json"), serializeCase(fam.state()));
  const started = await caseRun({
    meshPath,
    ...(python ? { python } : {}),
    ...(install ? { installPath: install } : {}),
    waitSeconds: 2,
    generate: true,
    force: true,
    problemtype: fam.problemtype,
  });
  if (started.exitCode !== undefined || ["finished", "failed"].includes(String(started.status))) {
    return { family: fam.id, status: FAIL, dir, detail: `the run ended before it could be stopped (${started.status}${started.message ? `: ${started.message}` : ""})` };
  }
  const caseDir = path.dirname(meshPath);
  const vtk = path.join(caseDir, "vtk_output");
  const t0 = Date.now();
  while (!(fs.existsSync(vtk) && fs.readdirSync(vtk).filter((n) => /\.(vtu|vtm|vtk)$/.test(n)).length >= 2)) {
    if (Date.now() - t0 > 120000) return { family: fam.id, status: FAIL, dir, detail: "no result files within 120 s of starting" };
    await new Promise((r) => setTimeout(r, 500));
  }
  const stopped = await caseStop({ meshPath });
  const first = await caseStatus({ meshPath });
  const second = await caseStatus({ meshPath });
  const problems = [];
  if (stopped.stopped !== true) problems.push(`case_stop reported stopped=${stopped.stopped}`);
  if (stopped.stopRung !== "sentinel") problems.push(`stop rung was ${stopped.stopRung ?? "none"}, not sentinel`);
  if (first.status !== "cancelled") problems.push(`status read ${first.status}, not cancelled`);
  if (first.exitCode !== undefined && first.exitCode !== 0) problems.push(`exit code ${first.exitCode}`);
  if (JSON.stringify([first.status, first.exitCode, first.stopRung]) !== JSON.stringify([second.status, second.exitCode, second.stopRung])) {
    problems.push("the status changed between two reads");
  }
  // Partial outputs: every file the run wrote must parse, the newest included (the sentinel stop finalizes, so no truncation).
  let files = 0;
  try {
    const names = fs.readdirSync(vtk);
    files = names.length;
    const newest = await readLatest(caseDir);
    if (!newest) problems.push("no readable result after the stop");
    else if (newest.model.nodeIds.length === 0) problems.push(`${newest.fileName} has no nodes`);
  } catch (e) {
    problems.push(`a result file does not parse: ${e instanceof Error ? e.message : String(e)}`);
  }
  const log = path.join(caseDir, "case.kratosrun.log");
  const logBytes = fs.existsSync(log) ? fs.statSync(log).size : 0;
  if (logBytes === 0) problems.push("the run log is missing or empty");
  if (problems.length > 0) return { family: fam.id, status: FAIL, dir, detail: problems.join("; ") };
  return {
    family: fam.id, status: PASS, dir,
    detail: `stopped on the ${stopped.stopRung} rung, ${first.status}${first.exitCode !== undefined ? `, exit ${first.exitCode}` : ""}, ${files} result files readable, ${logBytes}-byte log`,
  };
}

await main();
