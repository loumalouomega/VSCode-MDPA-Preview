import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { encodeNpy, parseNpy } from "../parser/npyReader";

test("float64 and int64 arrays round-trip through the encoder", () => {
  const f = parseNpy(encodeNpy([1.5, -2, 3e-12]));
  assert.deepEqual(f, { shape: [3], dtype: "<f8", data: [1.5, -2, 3e-12] });
  const i = parseNpy(encodeNpy([7, 12, 340], "<i8"));
  assert.deepEqual(i.data, [7, 12, 340]);
  const m = parseNpy(encodeNpy([1, 2, 3, 4, 5, 6], "<f8", [2, 3]));
  assert.deepEqual(m.shape, [2, 3]);
});

test("refusals name what is unsupported", () => {
  assert.throws(() => parseNpy(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])), /missing the \\x93NUMPY magic/);
  const big = encodeNpy([1]);
  const text = Buffer.from(big).toString("latin1").replace("<f8", ">f8");
  assert.throws(() => parseNpy(Uint8Array.from(Buffer.from(text, "latin1"))), /Unsupported \.npy dtype ">f8"/);
  const fortran = Buffer.from(big).toString("latin1").replace("False", "True ");
  assert.throws(() => parseNpy(Uint8Array.from(Buffer.from(fortran, "latin1"))), /Fortran-ordered/);
  assert.throws(() => parseNpy(encodeNpy([1, 2, 3]).subarray(0, 140)), /shorter than its header/);
});

const numpy = spawnSync("python3", ["-c", "import numpy"]).status === 0;

test("files written by numpy itself parse (int32, float32, int64, uint8)", { skip: !numpy }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npy-"));
  const script = `
import numpy as np, sys, os
d = sys.argv[1]
np.save(os.path.join(d, "f4.npy"), np.array([0.5, 1.5], dtype=np.float32))
np.save(os.path.join(d, "i4.npy"), np.array([-3, 4], dtype=np.int32))
np.save(os.path.join(d, "i8.npy"), np.array([10, 20, 30]))
np.save(os.path.join(d, "u1.npy"), np.array([255, 1], dtype=np.uint8))
np.save(os.path.join(d, "m.npy"), np.arange(6.0).reshape(2, 3))
`;
  const run = spawnSync("python3", ["-c", script, dir]);
  assert.equal(run.status, 0, String(run.stderr));
  const load = (n: string) => parseNpy(fs.readFileSync(path.join(dir, n)));
  assert.deepEqual(load("f4.npy").data, [0.5, 1.5]);
  assert.deepEqual(load("i4.npy").data, [-3, 4]);
  assert.deepEqual(load("i8.npy").data, [10, 20, 30]);
  assert.deepEqual(load("u1.npy").data, [255, 1]);
  assert.deepEqual(load("m.npy"), { shape: [2, 3], dtype: "<f8", data: [0, 1, 2, 3, 4, 5] });
});
