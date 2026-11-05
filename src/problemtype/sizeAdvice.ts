/**
 * Recommended element size from the physics (roadmap item 33). Advice with its
 * inputs shown; the mesher decides, and nothing here changes a generated file.
 *
 * Only rules that are defensible from values the case already holds are given.
 * Fluid problemtypes: a wall rule, the first-cell height for a target y+ from the
 * reference velocity (`refVelocity`, the same input `timeStepEstimate.ts` reads),
 * the fluid material's density and dynamic viscosity, and a reference length
 * taken from the mesh's longest bounding-box side — through the flat-plate
 * friction law already used by the virtual wind tunnel. A problemtype without a
 * rule, or a case missing an input, publishes nothing rather than a guess.
 */
import { boundaryLayerEstimate } from "./windTunnel/estimate";
import type { JsonValue, MaterialAssignment } from "./types";

export interface SizeAdvice {
  rule: "wall-y-plus";
  /** Recommended first-cell height normal to a wall (mesh length unit, assumed SI metres). */
  firstCellHeight: number;
  /** Boundary-layer layers needed at growth 1.2 to span the estimated thickness. */
  layers: number;
  /** Every input the number came from, so it can be checked. */
  inputs: { velocity: number; density: number; dynamicViscosity: number; referenceLength: number; targetYPlus: number };
  basis: string;
  note: string;
}

const FLUID_IDS = new Set(["fluid", "rans", "buoyancy", "embeddedFluid", "compressibleFluid", "twoFluids"]);

export function adviseElementSize(
  problemtypeId: string,
  values: Record<string, JsonValue>,
  materials: MaterialAssignment[],
  boundsMin: readonly number[],
  boundsMax: readonly number[],
  targetYPlus = 30
): SizeAdvice | undefined {
  if (!FLUID_IDS.has(problemtypeId)) return undefined;
  const velocity = Math.abs(Number(values.refVelocity));
  const mat = materials.find((m) => Number.isFinite(Number(m.values.DENSITY)) && Number.isFinite(Number(m.values.DYNAMIC_VISCOSITY)));
  if (!mat || !(velocity > 0)) return undefined;
  const density = Number(mat.values.DENSITY);
  const dynamicViscosity = Number(mat.values.DYNAMIC_VISCOSITY);
  const referenceLength = Math.max(...[0, 1, 2].map((i) => (boundsMax[i] ?? 0) - (boundsMin[i] ?? 0)));
  if (!(density > 0) || !(dynamicViscosity > 0) || !(referenceLength > 0)) return undefined;
  const est = boundaryLayerEstimate({ speed: velocity, density, viscosity: dynamicViscosity }, referenceLength, targetYPlus);
  return {
    rule: "wall-y-plus",
    firstCellHeight: est.firstHeight,
    layers: est.layers,
    inputs: { velocity, density, dynamicViscosity, referenceLength, targetYPlus },
    basis: est.basis,
    note: "Flat-plate estimate over the mesh's longest side; a guide for the first wall cell, not a prediction for the actual geometry.",
  };
}

export interface WavelengthAdvice {
  rule: "wavelength";
  /** Largest element size that still resolves the wave at `pointsPerWavelength`. */
  maxElementSize: number;
  inputs: { wavelength: number; pointsPerWavelength: number; frequency?: number; waveSpeed?: number };
  basis: string;
}

/**
 * Wave resolution rule: h <= wavelength / n (default n = 5). Everything is
 * supplied by the caller — a wavelength, or a frequency with a wave speed
 * (lambda = c / f) — and nothing is inferred from the mesh or a problemtype;
 * a missing or non-positive input publishes nothing.
 */
export function adviseWavelengthSize(
  input: { wavelength?: number; frequency?: number; waveSpeed?: number },
  pointsPerWavelength = 5
): WavelengthAdvice | undefined {
  if (!(pointsPerWavelength > 0) || !Number.isFinite(pointsPerWavelength)) return undefined;
  let wavelength = input.wavelength;
  const fromSpeed = wavelength === undefined;
  if (fromSpeed) {
    const { frequency, waveSpeed } = input;
    if (frequency === undefined || waveSpeed === undefined || !(frequency > 0) || !(waveSpeed > 0)) return undefined;
    wavelength = waveSpeed / frequency;
  }
  if (!(wavelength! > 0) || !Number.isFinite(wavelength!)) return undefined;
  return {
    rule: "wavelength",
    maxElementSize: wavelength! / pointsPerWavelength,
    inputs: {
      wavelength: wavelength!,
      pointsPerWavelength,
      ...(fromSpeed ? { frequency: input.frequency, waveSpeed: input.waveSpeed } : {}),
    },
    basis: `h <= lambda / ${pointsPerWavelength}` + (fromSpeed ? ", lambda = c / f" : ""),
  };
}
