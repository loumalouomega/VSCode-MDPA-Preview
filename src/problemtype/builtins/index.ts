/** The built-in problemtype registry. */

import { ProblemtypeRuntime } from "../types";
import { structural } from "./structural";
import { fluid } from "./fluid";
import { convectionDiffusion } from "./convectionDiffusion";
import { potentialFlow } from "./potentialFlow";
import { shallowWater } from "./shallowWater";
import { flowgraph } from "./flowgraph";

export const BUILTIN_PROBLEMTYPES: ProblemtypeRuntime[] = [
  structural,
  fluid,
  convectionDiffusion,
  potentialFlow,
  shallowWater,
  flowgraph,
];
