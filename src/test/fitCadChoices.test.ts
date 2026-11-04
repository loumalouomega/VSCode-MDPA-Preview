import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REFINE_PATCHES_FIT } from "../parser/fitCadChoices";

describe("the refine-patches STEP fit level", () => {
  it("refines the segmentation at 0.2 % of the diagonal", () => {
    assert.deepEqual(REFINE_PATCHES_FIT, { refineSegmentation: true, refineTolerance: 2e-3 });
  });
  it("leaves the freeform modes out (slow, larger deviation)", () => {
    assert.equal(REFINE_PATCHES_FIT.freeformMode, undefined);
  });
});
