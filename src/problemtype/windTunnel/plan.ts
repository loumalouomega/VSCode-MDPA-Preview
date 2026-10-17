/**
 * Planning a virtual wind tunnel: from the wizard's parameters and an imported
 * surface to a complete, explicit plan — the placed body, the tunnel, the
 * boundary-layer law, the sizes, the ordered list of mesh operations and an
 * estimate of what they cost — before anything is meshed.
 *
 * The plan is plain data. The UI shows it, the MCP `wind_tunnel_plan` tool
 * returns it, and `runWindTunnel` executes the same operations the plan lists,
 * so what was shown is what runs.
 *
 * Pure: no vscode, no wasm, no file system.
 */

import type { MdpaModel } from "../../parser/types";
import type { OpRecord } from "../../parser/operations";
import type { WallLayerSpec } from "../../parser/anisoMetric";
import { LENGTH_UNITS, bodyMetrics, placeBody } from "./body";
import type { BodyMetrics, Vec3 } from "./body";
import { tunnelDomain } from "./domain";
import type { TunnelDomain, TunnelSpec } from "./domain";
import { AIR_20C, DEFAULT_MAX_TETRAHEDRA, boundaryLayerEstimate, estimateMesh, yPlusAt } from "./estimate";
import type { BoundaryLayerEstimate, FlowSpec, MeshEstimate } from "./estimate";

export const WIND_TUNNEL_VERSION = 1;

export interface WindTunnelFlow {
  /** Free-stream speed (m/s). */
  speed: number;
  /** Default air at 20 °C. */
  density?: number;
  viscosity?: number;
  /** Free-stream turbulence intensity (0–1), recorded for turbulence models. */
  turbulenceIntensity?: number;
  /**
   * The turbulence model of the prepared case: "none" keeps the Fluid problemtype (a wall law and the dynamic
   * subscales), the others use the Turbulent Flow (RANS) problemtype with the logarithmic wall function.
   */
  turbulence?: "none" | "k_epsilon" | "k_omega" | "k_omega_sst";
  /** Turbulence length scale at the inlet in metres (default 1% of the body length). */
  turbulenceLength?: number;
}

export interface WindTunnelMesh {
  /** "bodyFitted" carves the body out and puts a wall layer on it; "embedded" keeps the surface unfitted. */
  mode?: "bodyFitted" | "embedded";
  /** Cell size along the body wall (m). Default: body length / 80. */
  surfaceSize?: number;
  /** Largest cell size, far from the body (m). Default: body length / 2. */
  farSize?: number;
  /** Target y+ for the first node row (wall-function range 30–100, wall-resolved ~1). Default 50. */
  yPlus?: number;
  /** First node row height (m); overrides the y+ estimate. */
  firstHeight?: number;
  /** Layer growth ratio. Default 1.2. */
  growth?: number;
  /** Largest along/across size ratio inside the layer. Default 50. */
  maxAspect?: number;
  /** Surface fit: the largest gap between the mesh wall and the surface, as a fraction of the body length. Default 0.003. */
  fit?: number;
  /**
   * Sobolev wall snap after the carve (body-fitted only, default true): the
   * carved wall is projected onto the surface, the Body displacement is
   * smoothed with the far-field and tunnel faces pinned, and the largest
   * sub-step that inverts no cell is kept. Falls back to the carve with a
   * reported gap. Set false to keep the carve as the wall.
   */
  snap?: boolean;
  /**
   * The carve cuts the wall through cells of this fraction of the surface size, then the wall layer
   * coarsens the surface back: a finer carve follows sharp edges better. Default 0.7.
   */
  carveFactor?: number;
  /** Wake refinement length in body lengths behind the body (0 = none). Default 2. */
  wakeLength?: number;
  /** Cell size in the wake (m). Default: far size / 4. */
  wakeSize?: number;
  /** Refuse a plan expecting more tetrahedra than this. */
  maxTetrahedra?: number;
  /** A surface with more triangles than this is decimated for the distance sampling only. Default 300 000. */
  sdfMaxTriangles?: number;
}

export interface WindTunnelParams {
  version?: number;
  /** The body surface file as given. Not read by the planner. */
  bodyPath?: string;
  /** Unit of the body file: a key of LENGTH_UNITS or metres per unit. Default metres. */
  unit?: string | number;
  /** Euler angles (degrees) turning the body so the flow runs along +X and up is +Z. */
  rotation?: Vec3;
  tunnel?: TunnelSpec;
  flow: WindTunnelFlow;
  mesh?: WindTunnelMesh;
}

export interface WindTunnelSizes {
  surface: number;
  far: number;
  /** Cell size of the background lattice around the body. */
  core: number;
  wake: number;
  /** MMG Hausdorff distance (m). */
  hausd: number;
  /** Size growth per unit distance away from the wall. */
  gradation: number;
}

export interface WindTunnelStep {
  id: string;
  label: string;
  /** Operations the step applies, when it is made of operations. */
  ops?: OpRecord[];
  /** Relative cost, for a progress bar. */
  weight: number;
}

export interface WindTunnelPlan {
  params: Required<Pick<WindTunnelParams, "flow">> & WindTunnelParams;
  scale: number;
  /** The body in the tunnel frame (centred, flow along +X). */
  placed: MdpaModel;
  body: BodyMetrics;
  domain: TunnelDomain;
  flow: Required<WindTunnelFlow>;
  boundaryLayer: BoundaryLayerEstimate;
  wall: WallLayerSpec;
  sizes: WindTunnelSizes;
  /** The same size law as a formula, used between the lattice and the carve. */
  sizeExpr: string;
  mode: "bodyFitted" | "embedded";
  passes: number;
  estimate: MeshEstimate;
  maxTetrahedra: number;
  steps: WindTunnelStep[];
  warnings: string[];
  /** Reasons the plan cannot run; empty when it can. */
  errors: string[];
}

const SDF_FIELD = "d";

function unitScale(unit: string | number | undefined): number {
  if (unit === undefined) return 1;
  if (typeof unit === "number") {
    if (!(unit > 0)) throw new Error("A unit scale must be above zero.");
    return unit;
  }
  const s = LENGTH_UNITS[unit];
  if (s === undefined) throw new Error(`Unknown unit "${unit}". Use ${Object.keys(LENGTH_UNITS).join(", ")} or a number of metres per unit.`);
  return s;
}

/** A refinement box behind the body as a distance-to-box size law, in the tunnel frame. */
export function wakeSizeExpr(domain: TunnelDomain, length: number, wakeLength: number, wakeSize: number, growth: number): string {
  const x0 = domain.bodyMax[0] - 0.25 * length;
  const x1 = domain.bodyMax[0] + wakeLength * length;
  const yc = (domain.bodyMin[1] + domain.bodyMax[1]) / 2;
  const hy = 0.6 * (domain.bodyMax[1] - domain.bodyMin[1]);
  const z0 = domain.bodyMin[2];
  const z1 = domain.bodyMax[2] + 0.2 * (domain.bodyMax[2] - domain.bodyMin[2]);
  const n = (v: number): string => String(+v.toPrecision(7));
  const dx = `max(0, max(${n(x0)} - x, x - ${n(x1)}))`;
  const dy = `max(0, abs(y - ${n(yc)}) - ${n(hy)})`;
  const dz = `max(0, max(${n(z0)} - z, z - ${n(z1)}))`;
  return `${n(wakeSize)} + ${n(growth)}*sqrt(pow(${dx}, 2) + pow(${dy}, 2) + pow(${dz}, 2))`;
}

/**
 * Plans a tunnel for `bodyModel`. Never throws for a bad CHOICE (it reports it
 * in `errors`/`warnings`, so the wizard can show every problem at once); it
 * throws only when the input is unusable, such as a surface with no triangles.
 */
export function planWindTunnel(params: WindTunnelParams, bodyModel: MdpaModel): WindTunnelPlan {
  const warnings: string[] = [];
  const errors: string[] = [];
  const scale = unitScale(params.unit);
  const raw = bodyMetrics(bodyModel);
  if (!raw.closed) {
    warnings.push(`The body surface is not clean: ${raw.problems.join("; ")}. The distance sign is computed with the winding number, which tolerates small gaps, but a leaky body gives a leaky wall.`);
  }
  if (raw.signedVolume < 0) warnings.push("The body is wound inward; this does not matter here (the sign comes from the winding number).");
  const placed = placeBody(bodyModel, { scale, rotation: params.rotation });
  const body = bodyMetrics(placed);
  const [L, W, H] = body.size;
  if (L < 0.01 || L > 500) {
    warnings.push(`The body measures ${L.toPrecision(3)} m along the flow after the "${params.unit ?? "m"}" unit: check the unit — a model in millimetres read as metres is the usual mistake.`);
  }

  const domain = tunnelDomain(body, params.tunnel);
  warnings.push(...domain.warnings);

  const flow: Required<WindTunnelFlow> = {
    speed: params.flow.speed,
    density: params.flow.density ?? AIR_20C.density,
    viscosity: params.flow.viscosity ?? AIR_20C.viscosity,
    turbulenceIntensity: params.flow.turbulenceIntensity ?? 0.01,
    turbulence: params.flow.turbulence ?? "none",
    turbulenceLength: params.flow.turbulenceLength ?? 0.01 * L,
  };
  if (!(flow.speed > 0)) errors.push("The free-stream speed must be above zero.");
  const mesh = params.mesh ?? {};
  const mode = mesh.mode ?? "bodyFitted";
  const growth = mesh.growth ?? 1.2;
  const maxAspect = mesh.maxAspect ?? 50;
  const yPlus = mesh.yPlus ?? 50;
  if (!(growth >= 1)) errors.push("The layer growth ratio cannot be below 1.");
  if (!(maxAspect >= 1)) errors.push("The maximum aspect ratio cannot be below 1.");

  const surface = mesh.surfaceSize ?? L / 80;
  const far = mesh.farSize ?? L / 2;
  if (!(surface > 0) || !(far >= surface)) errors.push("Cell sizes need 0 < surface size <= far size.");
  const wake = mesh.wakeSize ?? far / 4;
  const wakeLength = mesh.wakeLength ?? 2;
  const core = Math.min(far, Math.max(2 * surface, L / 40));
  const hausd = (mesh.fit ?? 0.003) * L;

  let boundaryLayer: BoundaryLayerEstimate;
  const fs: FlowSpec = { speed: flow.speed, density: flow.density, viscosity: flow.viscosity };
  try {
    boundaryLayer = boundaryLayerEstimate(fs, L, yPlus, growth);
  } catch (e) {
    boundaryLayer = { reynolds: 0, regime: "laminar", cf: 0, uTau: 0, thickness: 0, firstHeight: surface, layers: 0, basis: "unavailable" };
    errors.push(e instanceof Error ? e.message : String(e));
  }
  const firstHeight = mesh.firstHeight ?? boundaryLayer.firstHeight;
  if (mesh.firstHeight !== undefined) {
    boundaryLayer = { ...boundaryLayer, firstHeight, basis: `first height given (${firstHeight} m)` };
  }
  if (firstHeight > surface) {
    warnings.push(`The first height (${firstHeight.toPrecision(3)} m) is larger than the surface size (${surface.toPrecision(3)} m): the wall layer will not be thinner than the surface mesh. Lower the y+ target or raise the surface size.`);
  }
  if (mode === "bodyFitted" && yPlus < 5 && boundaryLayer.regime === "turbulent") {
    warnings.push("A y+ near 1 resolves the viscous sub-layer: it needs a low-Reynolds turbulence model and many more cells than a wall function (y+ 30–100).");
  }
  if (boundaryLayer.regime === "laminar") {
    warnings.push(`At Re = ${boundaryLayer.reynolds.toExponential(2)} the flow over the body is laminar, so the Fluid problemtype's laminar solvers apply.`);
  } else if (flow.turbulence === "none") {
    warnings.push(`At Re = ${boundaryLayer.reynolds.toExponential(2)} the flow is turbulent and no turbulence model is applied: the wall law and the dynamic subscales of QSVMS stand in, so treat the forces as a first estimate. Choose a turbulence model in the Flow step for a RANS case.`);
  } else if (mode === "embedded") {
    errors.push("A turbulence model needs the body-fitted mesh: the RANS wall function is applied to a wall part, which an embedded body does not have.");
  } else {
    warnings.push(`The case uses the ${flow.turbulence.replace(/_/g, "-")} RANS model with the logarithmic wall function (Re = ${boundaryLayer.reynolds.toExponential(2)}): keep the first node row at y+ 30–100, and expect a steady solution only where the flow is steady.`);
    if (yPlus < 30 || yPlus > 300) warnings.push(`A wall function assumes the first node in the logarithmic layer; y+ ${yPlus} is outside the usual 30–300.`);
  }

  const wall: WallLayerSpec = {
    firstHeight,
    growth,
    tangentialSize: surface,
    tangentialGrowth: 0.25,
    hmax: far,
    maxAspect,
  };
  const gradation = 0.25;
  const wakeExpr = wakeLength > 0 ? wakeSizeExpr(domain, L, wakeLength, wake, gradation) : undefined;
  const carveSurface = surface * Math.min(1, Math.max(0.2, mesh.carveFactor ?? 0.7));
  const wallLaw = `clamp(${+carveSurface.toPrecision(6)} + ${gradation}*abs(${SDF_FIELD}), ${+carveSurface.toPrecision(6)}, ${+far.toPrecision(6)})`;
  const sizeExpr = wakeExpr ? `min(${wallLaw}, ${wakeExpr})` : wallLaw;

  const maxTetrahedra = mesh.maxTetrahedra ?? DEFAULT_MAX_TETRAHEDRA;
  const estimate = estimateMesh({ volume: domain.volume, surfaceArea: body.surfaceArea * (domain.halfModel ? 0.5 : 1), wall });
  if (mode === "embedded") {
    // No wall layer to pay for: the layer cannot be built on a surface the mesh does not follow.
    estimate.notes.push("Embedded mode has no wall layer: the count is the lattice refined to the surface size, not the stretched stack.");
  }
  if (estimate.expectedTetrahedra > maxTetrahedra) {
    errors.push(
      `The mesh would have about ${Math.round(estimate.expectedTetrahedra).toLocaleString("en-US")} tetrahedra, above the limit of ${maxTetrahedra.toLocaleString("en-US")}. Raise the surface or far size, the y+ target or the maximum aspect ratio, or raise the limit if the machine can take it.`
    );
  } else if (estimate.expectedTetrahedra > 1_000_000) {
    warnings.push(`About ${Math.round(estimate.expectedTetrahedra).toLocaleString("en-US")} tetrahedra: the meshing runs for many minutes and uses several GB.`);
  }

  const passes = Math.min(4, Math.max(2, Math.ceil(Math.log2(Math.max(1, core / surface)) / 1.5) + 1));
  const common = { hmin: +(Math.min(carveSurface, firstHeight) / 2).toPrecision(4), hmax: +far.toPrecision(6), hausd: +hausd.toPrecision(4), hgrad: 1.3 };
  const refine: OpRecord = { op: "remesh", mode: "expr", sizeExpr, ...common };
  const steps: WindTunnelStep[] = [
    { id: "body", label: "Place the body in the tunnel frame", weight: 1 },
    { id: "lattice", label: "Build the background lattice", weight: 1 },
  ];
  for (let p = 0; p < passes; p++) {
    steps.push({ id: `size-${p}`, label: `Refine towards the body (pass ${p + 1} of ${passes})`, ops: [{ op: "sdfDistance", path: "<body>", sign: "winding", output: SDF_FIELD } as OpRecord, refine], weight: 3 });
  }
  if (mode === "bodyFitted") {
    steps.push({
      id: "carve",
      label: "Carve the body out of the tunnel",
      ops: [{ op: "sdfDistance", path: "<body>", sign: "winding", output: SDF_FIELD } as OpRecord, { op: "levelset", variable: SDF_FIELD, ...common } as OpRecord],
      weight: 5,
    });
    steps.push({ id: "tidy", label: "Name the parts and drop the body interior", weight: 1 });
    if (mesh.snap ?? true) {
      steps.push({ id: "snap", label: "Snap the wall onto the surface", weight: 2 });
    }
    steps.push({
      id: "wall",
      label: "Build the wall layer",
      ops: [
        { op: "sdfDistance", path: "<body>", sign: "winding", output: SDF_FIELD } as OpRecord,
        {
          op: "remesh",
          mode: "wall",
          variable: SDF_FIELD,
          firstHeight: +firstHeight.toPrecision(6),
          growth,
          tangentialSize: +surface.toPrecision(6),
          tangentialGrowth: 0.25,
          maxAspect,
          ...(wakeExpr ? { sizeExpr: wakeExpr } : {}),
          ...common,
          hausd: +(hausd * 0.5).toPrecision(4),
        } as OpRecord,
      ],
      weight: 6,
    });
  } else {
    steps.push({
      id: "distance",
      label: "Write the signed distance for the embedded solver",
      ops: [{ op: "sdfDistance", path: "<body>", sign: "winding", output: "DISTANCE" } as OpRecord],
      weight: 1,
    });
  }
  steps.push({ id: "check", label: "Check the mesh", weight: 1 }, { id: "write", label: "Write the mesh and the recipe", weight: 1 });

  void yPlusAt;
  return {
    params: { ...params, flow: params.flow },
    scale,
    placed,
    body,
    domain,
    flow,
    boundaryLayer,
    wall,
    sizes: { surface, far, core, wake, hausd, gradation },
    sizeExpr,
    mode,
    passes,
    estimate,
    maxTetrahedra,
    steps,
    warnings,
    errors,
  };
}

/** The reference quantities a force coefficient needs, from the plan. */
export function referenceQuantities(plan: WindTunnelPlan): { area: number; length: number; dynamicPressure: number } {
  return {
    area: plan.body.frontalArea,
    length: plan.body.size[0],
    dynamicPressure: 0.5 * plan.flow.density * plan.flow.speed ** 2,
  };
}

/** A plan as plain JSON for a tool or the wizard: everything but the placed body model. */
export function summarizePlan(plan: WindTunnelPlan): Record<string, unknown> {
  const ref = referenceQuantities(plan);
  const sig = (v: number): number => +v.toPrecision(5);
  return {
    mode: plan.mode,
    runnable: plan.errors.length === 0,
    errors: plan.errors,
    warnings: plan.warnings,
    body: {
      triangles: plan.body.triangles,
      size: plan.body.size.map(sig),
      surfaceArea: sig(plan.body.surfaceArea),
      frontalArea: sig(plan.body.frontalArea),
      volume: sig(plan.body.signedVolume),
      closed: plan.body.closed,
      problems: plan.body.problems,
      unitScale: plan.scale,
    },
    tunnel: {
      min: plan.domain.min.map(sig),
      max: plan.domain.max.map(sig),
      blockage: sig(plan.domain.blockage),
      volume: sig(plan.domain.volume),
      halfModel: plan.domain.halfModel,
      ground: plan.domain.ground,
    },
    flow: { ...plan.flow, reynolds: sig(plan.boundaryLayer.reynolds), regime: plan.boundaryLayer.regime, dynamicPressure: sig(ref.dynamicPressure) },
    boundaryLayer: {
      firstHeight: sig(plan.boundaryLayer.firstHeight),
      layers: plan.boundaryLayer.layers,
      thickness: sig(plan.boundaryLayer.thickness),
      frictionVelocity: sig(plan.boundaryLayer.uTau),
      basis: plan.boundaryLayer.basis,
    },
    sizes: Object.fromEntries(Object.entries(plan.sizes).map(([k, v]) => [k, sig(v)])),
    estimate: {
      expectedTetrahedra: Math.round(plan.estimate.expectedTetrahedra),
      nodes: Math.round(plan.estimate.nodes),
      memoryMb: Math.round(plan.estimate.memoryMb),
      seconds: Math.round(plan.estimate.seconds),
      limit: plan.maxTetrahedra,
      notes: plan.estimate.notes,
    },
    reference: { area: sig(ref.area), length: sig(ref.length) },
    steps: plan.steps.map((s) => ({ id: s.id, label: s.label })),
  };
}
