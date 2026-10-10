/** The built-in problemtype registry. */

import { ProblemtypeRuntime } from "../types";
import { structural } from "./structural";
import { fluid } from "./fluid";
import { convectionDiffusion } from "./convectionDiffusion";
import { potentialFlow } from "./potentialFlow";
import { shallowWater } from "./shallowWater";
import { compressibleFluid } from "./compressibleFluid";
import { embeddedFluid } from "./embeddedFluid";
import { freeSurface } from "./freeSurface";
import { buoyancy } from "./buoyancy";
import { fsi } from "./fsi";
import { conjugateHeatTransfer } from "./conjugateHeatTransfer";
import { flowgraph } from "./flowgraph";

/**
 * Dropdown order within a family is declaration order here. The catalog groups
 * by `decl.family` (solids, fluids, thermal, coupled…), so the list below only
 * has to keep related problemtypes together.
 */
export const BUILTIN_PROBLEMTYPES: ProblemtypeRuntime[] = [
  structural,
  fluid,
  compressibleFluid,
  embeddedFluid,
  freeSurface,
  potentialFlow,
  shallowWater,
  convectionDiffusion,
  buoyancy,
  conjugateHeatTransfer,
  fsi,
  flowgraph,
];
