import { test } from "node:test";
import assert from "node:assert";
import { toWireModel, fieldRowCount, shouldStageFields, stagedHead, toWireField } from "../parser/modelWire";
import { MdpaModel } from "../parser/types";

function minimalModel(): MdpaModel {
  return {
    nodeIds: new Int32Array([1, 2, 3]),
    coords: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    nodeCount: 3,
    blocks: [],
    subModelParts: [],
    fields: [
      {
        kind: "Nodal",
        variable: "DISTANCE",
        components: 1,
        ids: new Int32Array([1, 2, 3]),
        values: new Float64Array([0.1, 0.2, 0.3]),
        fixed: new Uint8Array([0, 1, 0]),
      },
    ],
    diagnostics: [],
    bounds: { min: [0, 0, 0], max: [1, 1, 0] },
    is3D: false,
  } as unknown as MdpaModel;
}

test("toWireModel converts field ids/values/fixed to plain arrays with identical content", () => {
  const model = minimalModel();
  const wire = toWireModel(model);

  const field = wire.fields[0];
  assert.deepStrictEqual(Array.from(field.ids as unknown as number[]), [1, 2, 3]);
  assert.deepStrictEqual(Array.from(field.values as unknown as number[]), [0.1, 0.2, 0.3]);
  assert.deepStrictEqual(Array.from(field.fixed as unknown as number[]), [0, 1, 0]);
});

test("toWireModel does not mutate the original model's typed arrays", () => {
  const model = minimalModel();
  toWireModel(model);
  assert.ok(model.fields[0].ids instanceof Int32Array);
  assert.ok(model.fields[0].values instanceof Float64Array);
  assert.ok(model.fields[0].fixed instanceof Uint8Array);
});

test("toWireModel leaves geometry (nodeIds/coords) untouched", () => {
  const model = minimalModel();
  const wire = toWireModel(model);
  assert.strictEqual(wire.nodeIds, model.nodeIds);
  assert.strictEqual(wire.coords, model.coords);
  assert.ok(wire.nodeIds instanceof Int32Array);
});

test("toWireModel handles a field with no fixed array", () => {
  const model = minimalModel();
  delete model.fields[0].fixed;
  const wire = toWireModel(model);
  assert.strictEqual(wire.fields[0].fixed, undefined);
});

test("toWireModel handles a model with zero fields", () => {
  const model = minimalModel();
  model.fields = [];
  const wire = toWireModel(model);
  assert.deepStrictEqual(wire.fields, []);
});

test("staging is off below the row threshold and on above it", () => {
  const model = minimalModel();
  assert.strictEqual(fieldRowCount(model), 3);
  assert.strictEqual(shouldStageFields(model), false);
  assert.strictEqual(shouldStageFields(model, 2), true);
  assert.strictEqual(shouldStageFields({ ...model, fields: [] }, 0), false);
});

test("stagedHead keeps geometry and drops fields without mutating the model", () => {
  const model = minimalModel();
  const head = stagedHead(model);
  assert.strictEqual(head.fields.length, 0);
  assert.strictEqual(head.coords, model.coords);
  assert.strictEqual(model.fields.length, 1);
  assert.deepStrictEqual(Array.from(toWireField(model.fields[0]).values as unknown as number[]), [0.1, 0.2, 0.3]);
});
