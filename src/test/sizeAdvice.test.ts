import { test } from "node:test";
import assert from "node:assert/strict";
import { adviseElementSize, adviseWavelengthSize } from "../problemtype/sizeAdvice";
import { yPlusAt } from "../problemtype/windTunnel/estimate";

const air = [{ smpPath: "Fluid", lawId: "newtonian", values: { DENSITY: 1.2, DYNAMIC_VISCOSITY: 1.8e-5 } }];

test("fluid wall rule: the recommended height gives the target y+ back, with its inputs shown (item 33)", () => {
  const a = adviseElementSize("fluid", { refVelocity: 10 }, air, [0, 0, 0], [1, 0.2, 0.2], 30)!;
  assert.equal(a.rule, "wall-y-plus");
  assert.deepEqual(a.inputs, { velocity: 10, density: 1.2, dynamicViscosity: 1.8e-5, referenceLength: 1, targetYPlus: 30 });
  const back = yPlusAt({ speed: 10, density: 1.2, viscosity: 1.8e-5 }, 1, a.firstCellHeight);
  assert.ok(Math.abs(back - 30) / 30 < 1e-9);
  assert.ok(a.layers >= 1);
});

test("no rule or a missing input publishes nothing rather than a guess", () => {
  assert.equal(adviseElementSize("structural", { refVelocity: 10 }, air, [0, 0, 0], [1, 1, 1]), undefined);
  assert.equal(adviseElementSize("fluid", { refVelocity: 0 }, air, [0, 0, 0], [1, 1, 1]), undefined);
  assert.equal(adviseElementSize("fluid", { refVelocity: 10 }, [], [0, 0, 0], [1, 1, 1]), undefined);
  assert.equal(adviseElementSize("fluid", { refVelocity: 10 }, air, [0, 0, 0], [0, 0, 0]), undefined);
});

test("wavelength rule: h <= lambda/5, from a wavelength or from c/f, nothing inferred (item 33)", () => {
  const a = adviseWavelengthSize({ wavelength: 2 })!;
  assert.equal(a.maxElementSize, 0.4);
  const b = adviseWavelengthSize({ frequency: 100, waveSpeed: 340 }, 10)!;
  assert.ok(Math.abs(b.maxElementSize - 0.34) < 1e-12);
  assert.deepEqual(b.inputs, { wavelength: 3.4, pointsPerWavelength: 10, frequency: 100, waveSpeed: 340 });
  assert.equal(adviseWavelengthSize({}), undefined);
  assert.equal(adviseWavelengthSize({ frequency: 100 }), undefined);
  assert.equal(adviseWavelengthSize({ wavelength: -1 }), undefined);
  assert.equal(adviseWavelengthSize({ wavelength: 2 }, 0), undefined);
});
