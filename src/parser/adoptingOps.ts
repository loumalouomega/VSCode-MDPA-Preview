/**
 * The operations that adopt a meshio++ RESULT as the new mesh (through
 * `meshioFidelity.ts`'s `adoptMeshioMesh`) rather than using meshio++ as an
 * oracle whose answer is applied onto our own model.
 *
 * A zero-import leaf on purpose: `meshCapabilities.ts` publishes this list
 * through `mesh_capabilities`, and `operations.ts` asserts (in its tests) that
 * every entry is a real asynchronous op, so neither may import the other.
 * Adding an adopting op means appending its `OpRecord.op` name here.
 */
import type { OpName } from "./opLabels";

export const ADOPTING_OPS: readonly OpName[] = ["repairSurface", "surfaceRemesh", "volumeMesh", "optimizeVolume"];
