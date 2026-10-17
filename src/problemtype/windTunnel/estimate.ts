/**
 * What a virtual wind tunnel will cost and what its boundary layer should look
 * like, before any mesh is made: flat-plate wall-unit estimates for the first
 * cell height, and an integral of the sizing law over the fluid volume for the
 * cell count.
 *
 * These are guidance with the assumptions stated, never measurements: a
 * flat-plate friction law is not the friction on a car, and the cell count is
 * an ideal-tetrahedron count that MMG's real output exceeds by a calibrated
 * factor. The wizard shows them as "about", and gates on the count only to stop
 * a request that cannot fit in memory.
 *
 * Pure: no vscode, no wasm.
 */

import { layersToThickness, wallLayerSizes } from "../../parser/anisoMetric";
import type { WallLayerSpec } from "../../parser/anisoMetric";

export interface FlowSpec {
  /** Free-stream speed (m/s). */
  speed: number;
  /** Density (kg/m³). */
  density: number;
  /** Dynamic viscosity (Pa·s). */
  viscosity: number;
}

export const AIR_20C: Omit<FlowSpec, "speed"> = { density: 1.204, viscosity: 1.825e-5 };

export interface BoundaryLayerEstimate {
  reynolds: number;
  regime: "laminar" | "turbulent";
  /** Skin friction coefficient assumed by the estimate. */
  cf: number;
  /** Friction velocity (m/s). */
  uTau: number;
  /** Boundary-layer thickness at the end of a plate of the reference length (m). */
  thickness: number;
  /** Distance of the first node row from the wall that gives the target y+ (m). */
  firstHeight: number;
  /** Layers needed to span the thickness with the chosen growth. */
  layers: number;
  /** A line to show beside the number. */
  basis: string;
}

/** Reynolds number above which a flat plate is taken as turbulent. */
const TRANSITION_RE = 5e5;

/**
 * First-cell height for a target y+.
 *
 * Turbulent: Cf = 0.026 Re^(-1/7) (a Prandtl power-law friction law),
 * tau_w = Cf rho U²/2, u_tau = sqrt(tau_w/rho), y = y+ nu/u_tau, thickness
 * 0.37 L Re^(-1/5). Laminar: there is no wall function to satisfy, so the first
 * height is chosen so that `laminarLayers` layers span the Blasius thickness
 * 5 L/sqrt(Re).
 */
export function boundaryLayerEstimate(flow: FlowSpec, length: number, yPlus: number, growth = 1.2, laminarLayers = 15): BoundaryLayerEstimate {
  if (!(flow.speed > 0) || !(flow.density > 0) || !(flow.viscosity > 0)) throw new Error("Speed, density and viscosity must be above zero.");
  if (!(length > 0)) throw new Error("The reference length must be above zero.");
  if (!(yPlus > 0)) throw new Error("The target y+ must be above zero.");
  const nu = flow.viscosity / flow.density;
  const re = (flow.speed * length) / nu;
  const turbulent = re >= TRANSITION_RE;
  const cf = turbulent ? 0.026 * re ** (-1 / 7) : 1.328 / Math.sqrt(re);
  const uTau = Math.sqrt((0.5 * cf * flow.density * flow.speed ** 2) / flow.density);
  const thickness = turbulent ? 0.37 * length * re ** -0.2 : (5 * length) / Math.sqrt(re);
  let firstHeight: number;
  let basis: string;
  if (turbulent) {
    firstHeight = (yPlus * nu) / uTau;
    basis = `turbulent flat plate, Cf = 0.026 Re^(-1/7), target y+ = ${yPlus}`;
  } else {
    const g = Math.max(growth, 1 + 1e-6);
    firstHeight = (thickness * (g - 1)) / (g ** laminarLayers - 1);
    basis = `laminar flat plate (Re below ${TRANSITION_RE.toExponential(0)}): ${laminarLayers} layers across the Blasius thickness`;
  }
  return { reynolds: re, regime: turbulent ? "turbulent" : "laminar", cf, uTau, thickness, firstHeight, layers: layersToThickness(firstHeight, growth, thickness), basis };
}

/** Wall-unit y+ of a first node row at `height`, for the same assumptions. */
export function yPlusAt(flow: FlowSpec, length: number, height: number): number {
  const nu = flow.viscosity / flow.density;
  const re = (flow.speed * length) / nu;
  const cf = re >= TRANSITION_RE ? 0.026 * re ** (-1 / 7) : 1.328 / Math.sqrt(re);
  return (height * Math.sqrt(0.5 * cf) * flow.speed) / nu;
}

export interface MeshEstimateInput {
  /** Fluid volume of the tunnel (m³). */
  volume: number;
  /** Area of the body surface (m²). */
  surfaceArea: number;
  /** Sizing law at the wall. */
  wall: WallLayerSpec;
}

export interface MeshEstimate {
  /** Tetrahedra, ideal count. */
  tetrahedra: number;
  /** Tetrahedra after the calibrated MMG factor — what to expect. */
  expectedTetrahedra: number;
  nodes: number;
  /** Rough resident memory of the meshing and the final model, in MB. */
  memoryMb: number;
  /** Rough wall time of the meshing steps on one thread, in seconds. */
  seconds: number;
  notes: string[];
}

/** Volume of a regular tetrahedron per cube of its edge. */
const TET_VOLUME = Math.SQRT2 / 12;

/**
 * Ratio of the cells MMG really produces to the ideal count, fitted on the
 * sphere-in-a-tunnel spike (an isotropic and a stretched case). MMG splits and
 * grades more finely than a size field alone asks for.
 */
export const MMG_CELL_FACTOR = 1.45;

export function estimateMesh(input: MeshEstimateInput): MeshEstimate {
  const { volume, surfaceArea, wall } = input;
  const reqv = Math.sqrt(surfaceArea / (4 * Math.PI));
  let used = 0;
  let cells = 0;
  let d = 0;
  // March the distance in steps proportional to the local across-size, so the
  // thin layers and the coarse far field are both resolved.
  for (let guard = 0; guard < 100000 && used < volume; guard++) {
    const { normal, tangential } = wallLayerSizes(d, wall);
    const dd = Math.max(normal * 0.5, 1e-12);
    const area = surfaceArea * (1 + d / Math.max(reqv, 1e-9)) ** 2;
    const dv = Math.min(area * dd, volume - used);
    cells += dv / (TET_VOLUME * normal * tangential * tangential);
    used += dv;
    d += dd;
    if (normal >= wall.hmax && tangential >= wall.hmax) {
      cells += (volume - used) / (TET_VOLUME * wall.hmax ** 3);
      used = volume;
    }
  }
  const expected = cells * MMG_CELL_FACTOR;
  const notes = ["An ideal-tetrahedron integral of the sizing law, scaled by the factor fitted on a sphere test; expect it within about a factor of two."];
  return {
    tetrahedra: cells,
    expectedTetrahedra: expected,
    nodes: expected / 5.5,
    // Measured on a sharp box in a tunnel: 413k tetrahedra in 78 s at 3.2 GB, 1.05M in 385 s at 2.8 GB
    // (single process; the extension runs each wasm step in a worker that is released afterwards).
    memoryMb: Math.max(1000, expected * 2.5e-3),
    seconds: 78 * (expected / 413_000) ** 1.75,
    notes,
  };
}

/** Largest tetrahedron count the wizard accepts without an explicit override. */
export const DEFAULT_MAX_TETRAHEDRA = 3_000_000;
