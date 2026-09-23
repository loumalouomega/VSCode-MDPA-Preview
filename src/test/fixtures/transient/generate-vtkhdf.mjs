// Regenerate two-step.vtkhdf: a genuine multi-step VTKHDF file, written
// directly by meshio++'s own sequenceToTimeseries (roadmap item 3) — no
// h5py surgery needed, unlike generate.py's med/cgns/h5m fixtures, because
// the wasm build can itself write a real VTKHDF time series.
//
// Run from the repo root: node src/test/fixtures/transient/generate-vtkhdf.mjs
// Requires no build step — it calls the installed @meshioplusplus/wasm
// package directly, the same three-node-triangle / TEMP-field shape as the
// other two-step.* fixtures in this directory (values [10,20,30] then
// [40,50,60], at times 0 and 1).
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadMeshioPlusPlus } from "@meshioplusplus/wasm";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function triMesh(values) {
  return {
    points: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    dim: 3,
    cells: [{ type: "triangle", data: new Int32Array([0, 1, 2]), nodesPerCell: 3 }],
    point_data: { TEMP: new Float64Array(values) },
  };
}

const m = await loadMeshioPlusPlus({}, { variant: "seq" });
m.writeMesh("/step0.vtu", triMesh([10, 20, 30]), "vtu");
m.writeMesh("/step1.vtu", triMesh([40, 50, 60]), "vtu");

const steps = m.sequenceToTimeseries(
  ["/step0.vtu", "/step1.vtu"],
  "/out.vtkhdf",
  "vtkhdf",
  { times: [0, 1] }
);
if (steps !== 2) throw new Error(`expected 2 steps written, got ${steps}`);

// Verify the shape this fixture exists to pin, before committing it.
const md = m.readMetadata("/out.vtkhdf", "vtkhdf");
if (JSON.stringify(md.timeValues) !== JSON.stringify([0, 1])) {
  throw new Error(`expected timeValues [0, 1], got ${JSON.stringify(md.timeValues)}`);
}
if (md.fellBackToFullRead !== false) {
  throw new Error("expected fellBackToFullRead: false — this is the header-only claim being pinned");
}
for (const [step, expected] of [[0, [10, 20, 30]], [1, [40, 50, 60]]]) {
  const raw = m.readMeshSelective("/out.vtkhdf", { format: "vtkhdf", timeStep: step });
  const got = [...raw.point_data.TEMP];
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    throw new Error(`step ${step}: expected ${expected}, got ${got}`);
  }
}

writeFileSync(path.join(HERE, "two-step.vtkhdf"), m.FS.readFile("/out.vtkhdf"));
console.log("wrote two-step.vtkhdf:", md.timeValues, "fellBackToFullRead:", md.fellBackToFullRead);
