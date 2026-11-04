// vscode-free: the `.step` export's fit levels (meshExport.ts's pickStepFit shows them).
import type { FitCadOptions } from "@meshioplusplus/wasm";

/**
 * Refine the patches before fitting, at a tolerance just above a rough skin's own
 * roughness (a fraction of the bounding-box diagonal). Measured on the 22 236-triangle
 * hook a Structural Optimization run ends with: the kernel defaults left 94.7 % of the
 * area faceted; this left 41.9 % (20 planes, 13 cylinders, 7 cones, 12 B-splines, a
 * sphere and 3 tori) in ~3 minutes, the solid up to ~0.4 % of the diagonal from the
 * skin. The freeform modes are NOT offered here: on a 3 000-triangle copy of the same
 * skin they took 8-12x the time for a modest gain and a larger deviation.
 */
export const REFINE_PATCHES_FIT: FitCadOptions = { refineSegmentation: true, refineTolerance: 2e-3 };
