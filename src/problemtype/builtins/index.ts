/** The built-in problemtype registry. */

import { ProblemtypeRuntime } from "../types";
import { structural } from "./structural";
import { fluid } from "./fluid";
import { convectionDiffusion } from "./convectionDiffusion";

export const BUILTIN_PROBLEMTYPES: ProblemtypeRuntime[] = [
  structural,
  fluid,
  convectionDiffusion,
];
