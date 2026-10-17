/**
 * The simulation a wind-tunnel mesh is meant for: the case setup (conditions on
 * the named parts, a material, time stepping, the force monitors) as a
 * `CaseState` of an existing problemtype — Fluid for a body-fitted tunnel,
 * Embedded Fluid for an embedded one — so the sidebar, Generate, Run and the MCP
 * tools treat it like any case the user set up by hand.
 *
 * Every choice is derived from the plan and written where the user can see and
 * change it; the notes say what was assumed. Pure: no vscode, no wasm.
 */

import { defaultCaseState } from "../api";
import { fluid } from "../builtins/fluid";
import { rans } from "../builtins/rans";
import { embeddedFluid } from "../builtins/embeddedFluid";
import type { Assignment, CaseState, JsonValue, MaterialAssignment } from "../types";
import type { WindTunnelPlan } from "./plan";
import { referenceQuantities } from "./plan";

export interface WindTunnelCase {
  /** The problemtype the state belongs to. */
  problemtypeId: "fluid" | "embeddedFluid" | "rans";
  state: CaseState;
  /** What was assumed, in plain words, for the wizard's review step. */
  notes: string[];
}

const FLUID_PART = "Fluid";

/** Rounds to a few significant digits so the case file reads as a person would write it. */
const round = (v: number): number => +v.toPrecision(6);

export function windTunnelCase(plan: WindTunnelPlan): WindTunnelCase {
  const embedded = plan.mode === "embedded";
  const turbulent = !embedded && plan.flow.turbulence !== "none";
  const decl = embedded ? embeddedFluid.decl : turbulent ? rans.decl : fluid.decl;
  const state = defaultCaseState(decl);
  const notes: string[] = [];
  const { area, length, dynamicPressure } = referenceQuantities(plan);
  const half = plan.domain.halfModel;
  const U = plan.flow.speed;
  const flowThrough = length / U;
  const assignments: Assignment[] = [{ conditionId: "parts", smpPath: FLUID_PART, values: {} }];
  const add = (conditionId: string, smpPath: string, values: Record<string, JsonValue> = {}): void => {
    assignments.push({ conditionId, smpPath, values });
  };

  add("inlet", "Inlet", { modulus: round(U), direction: "x" });
  add("outlet", "Outlet", { value: 0, hydrostatic: false });
  // Ceiling and side walls do not shape the flow past the body: slip keeps them from growing a layer.
  add("slip", "Ceiling");
  add("slip", half ? "Symmetry" : "SideLow");
  add("slip", "SideHigh");
  switch (plan.domain.ground) {
    case "free":
    case "slip":
      add("slip", "Floor");
      break;
    case "noslip":
      if (turbulent) {
        // RANS applies its wall function to one part, the body; the floor is held at rest by a constraint.
        add("velocityConstraints", "Floor", { value: [0, 0, 0], constrained: true });
        notes.push("The floor is a no-slip wall without a wall function (the RANS wall function belongs to the body), written as a zero-velocity constraint.");
      } else add("noSlip", "Floor");
      break;
    case "moving":
      add("velocityConstraints", "Floor", { value: [round(U), 0, 0], constrained: true });
      notes.push("The floor moves with the stream (a moving ground), written as a velocity constraint.");
      break;
  }

  // A wall function needs y+ above the viscous sub-layer; below 5 the wall is resolved and no-slip is the honest condition.
  const wallModelled = plan.boundaryLayer.regime === "turbulent" && (plan.params.mesh?.yPlus ?? 50) >= 5;
  if (!embedded) {
    if (turbulent) {
      add("ransWall", "Body");
      notes.push(`The body wall uses the RANS logarithmic wall function; its first node row is ${round(plan.wall.firstHeight * 1000)} mm.`);
    } else if (wallModelled) {
      add("wallLaw", "Body", { wallModel: "linear_log", yWall: round(plan.wall.firstHeight) });
      notes.push(`The body wall uses the linear-logarithmic wall law with the first node row at ${round(plan.wall.firstHeight * 1000)} mm.`);
    } else {
      add("noSlip", "Body");
    }
    add("flowForces", "Body", { referencePoint: [0, 0, 0], writeMoments: true });
    add("aerodynamicCoefficients", "Body", {
      referenceArea: round(area * (half ? 0.5 : 1)),
      referenceChord: round(length),
      dynamicPressure: round(dynamicPressure),
      referencePoint: [0, 0, 0],
    });
    add("pressureCoefficient", "Body", { freestreamDensity: round(plan.flow.density), freestreamVelocity: round(U), freestreamPressure: 0 });
    add("yPlus", "Body");
    notes.push(
      `Force coefficients use the frontal area ${round(area * (half ? 0.5 : 1))} m², the body length ${round(length)} m and the dynamic pressure ${round(dynamicPressure)} Pa${half ? " (half model: half the area, half the force)" : ""}.`
    );
  } else {
    notes.push("The embedded body has no wall part: forces come from the embedded force process, and the wall is the zero level of the DISTANCE field.");
  }
  state.assignments = assignments;

  const material: MaterialAssignment = {
    smpPath: FLUID_PART,
    lawId: turbulent ? "rans_newtonian_3d" : "newtonian_3d",
    values: { DENSITY: round(plan.flow.density), DYNAMIC_VISCOSITY: plan.flow.viscosity },
  };
  state.materials = turbulent ? [material, { smpPath: "Body", lawId: "rans_wall", values: {} }] : [material];

  const problem = state.values.problem;
  // Time: adaptive on the Courant number, bounded in flow-through times of the body.
  Object.assign(problem, {
    timeStepMode: "adaptive",
    courantTarget: 2,
    timeStep: round(flowThrough * 1e-3),
    minDeltaTime: round(flowThrough * 1e-5),
    maxDeltaTime: round(flowThrough * 0.05),
    refVelocity: round(U),
    startTime: 0,
    endTime: round(flowThrough * 10),
    gravityValue: 0,
  });
  if (turbulent) {
    Object.assign(problem, {
      flowSolver: "monolithic",
      elementType: "vms",
      turbulenceModel: plan.flow.turbulence,
      scheme: "steady",
      freestreamSpeed: round(U),
      turbulenceIntensity: round(plan.flow.turbulenceIntensity),
      turbulenceLength: round(plan.flow.turbulenceLength),
      // A steady RANS run iterates pseudo-time steps of one until the solver reports convergence.
      timeStepMode: "fixed",
      timeStep: 1,
      endTime: 300,
      computeReactions: true,
    });
    notes.push("The run is steady: up to 300 pseudo-time steps, stopping earlier when the solver converges. Raise the end time if it has not.");
  } else if (embedded) {
    Object.assign(problem, { distanceMode: "from_mdpa", computeDrag: true, writeDragFile: true, correctDistance: true });
  } else {
    Object.assign(problem, { strategy: "monolithic", elementType: "qsvms", timeScheme: "bdf2", computeReactions: true });
  }
  state.output = turbulent
    ? { ...state.output, controlType: "step", interval: 25, nodalVariables: ["VELOCITY", "PRESSURE"] }
    : { ...state.output, controlType: "time", interval: round(flowThrough * 0.1), nodalVariables: ["VELOCITY", "PRESSURE"] };
  if (!turbulent) {
    notes.push(
      `Time stepping follows a Courant number of 2 and runs for ${round(flowThrough * 10)} s, ten flow-through times of the body (${round(flowThrough)} s each). Raise the end time until the force coefficients stop drifting.`
    );
  }
  return { problemtypeId: embedded ? "embeddedFluid" : turbulent ? "rans" : "fluid", state, notes };
}
