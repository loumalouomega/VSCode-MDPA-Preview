import { test } from "node:test";
import assert from "node:assert/strict";
import { cellLabelPoints, cellLabelText } from "../parser/render/cellLabels";
import { buildMembershipIndex } from "../parser/smpMembership";
import type { EntityBlock, SubModelPart } from "../parser/types";

const prep: any = {
  coords: new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0, 5, 5, 5]),
  index: new Map([[10, 0], [11, 1], [12, 2], [13, 3]]),
};
const el: EntityBlock = { kind: "Elements", name: "T", count: 1, stride: 3, entityIds: Int32Array.from([48211]), propertyIds: Int32Array.from([7]), connectivity: Int32Array.from([10, 11, 12]) };
const co: EntityBlock = { kind: "Conditions", name: "L", count: 2, stride: 2, entityIds: Int32Array.from([1, 2]), connectivity: Int32Array.from([10, 11, 11, 99]) };

test("centroids are per kind, in block order, NaN for an unresolved corner", () => {
  const e = cellLabelPoints([co, el], "Elements", prep);
  assert.equal(e.xyz.length, 3);
  assert.ok(Math.abs(e.xyz[0] - 2 / 3) < 1e-6);
  const c = cellLabelPoints([co, el], "Conditions", prep);
  assert.equal(c.xyz[0], 1);
  assert.ok(Number.isNaN(c.xyz[3]));
});
test("label text per source", () => {
  const parts: SubModelPart[] = [{ name: "P", path: "P", nodeIds: new Int32Array(), elementIds: Int32Array.from([48211]), conditionIds: new Int32Array(), geometryIds: new Int32Array(), children: [] } as any];
  const blocks = [co, el];
  const pts = cellLabelPoints(blocks, "Elements", prep);
  const ctx = { blocks, kind: "Elements" as const, membership: buildMembershipIndex(parts), fieldText: (id: number) => (id === 48211 ? "1.5" : undefined) };
  assert.equal(cellLabelText("id", pts, 0, ctx), "48211");
  assert.equal(cellLabelText("propertyId", pts, 0, ctx), "7");
  assert.equal(cellLabelText("smp", pts, 0, ctx), "P");
  assert.equal(cellLabelText("field", pts, 0, ctx), "1.5");
  const cpts = cellLabelPoints(blocks, "Conditions", prep);
  assert.equal(cellLabelText("propertyId", cpts, 0, { ...ctx, kind: "Conditions" }), "");
});
