import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { extractSkinModel, extractSkinModelTs } from "../parser/extractSkin";
import { isMdpaWasmAvailable, loadMdpaWasm } from "../parser/mdpaWasm";
import { parseMdpaTs } from "../parser/mdpaParser";
import { VtkCellType as C } from "../parser/geometryMap";
import type { MdpaModel } from "../parser/types";

// Roadmap item 87, Phase 2: the Rust skin extractor must agree with the
// TypeScript implementation, which stays as the oracle and the fallback.

const available = isMdpaWasmAvailable() && !!loadMdpaWasm()?.WasmSkinExtractor;
const opts = { skip: available ? false : "mdpa-core WASM with WasmSkinExtractor not built" };

function hexAndTetModel(): MdpaModel {
  // 2x1x1 grid of 12 nodes: left cube is a hex (1..8), right cube is 5 tets (5..8, 9..12).
  // Also include a pre-existing surface triangle on the outer face to test cross-dedup.
  const coords = new Float32Array([
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
    0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
    0, 0, 2, 1, 0, 2, 1, 1, 2, 0, 1, 2,
  ]);
  const nodeIds = Int32Array.from({ length: 12 }, (_, i) => i + 1);
  return {
    nodeCount: 12,
    nodeIds,
    coords,
    blocks: [
      {
        kind: "Elements",
        name: "Hex",
        vtkCellType: C.HEXAHEDRON,
        count: 1,
        stride: 8,
        entityIds: new Int32Array([1]),
        propertyIds: new Int32Array([1]),
        connectivity: new Int32Array([1, 2, 3, 4, 5, 6, 7, 8]),
      },
      {
        kind: "Elements",
        name: "Tet",
        vtkCellType: C.TETRA,
        count: 5,
        stride: 4,
        entityIds: new Int32Array([2, 3, 4, 5, 6]),
        propertyIds: new Int32Array([1, 1, 1, 1, 1]),
        connectivity: new Int32Array([
          5, 6, 7, 10,
          5, 7, 8, 12,
          5, 9, 10, 12,
          11, 10, 7, 12,
          5, 10, 7, 12,
        ]),
      },
      {
        kind: "Conditions",
        name: "OuterTri",
        vtkCellType: C.TRIANGLE,
        count: 1,
        stride: 3,
        entityIds: new Int32Array([10]),
        propertyIds: new Int32Array([0]),
        connectivity: new Int32Array([9, 10, 12]),
      },
    ],
    subModelParts: [
      {
        name: "Inlet",
        path: "Inlet",
        nodeIds: new Int32Array([1, 2, 3, 4, 5]),
        elementIds: new Int32Array([1]),
        conditionIds: new Int32Array(0),
        geometryIds: new Int32Array(0),
        constraintIds: new Int32Array(0),
        children: [],
      },
    ],
    meta: [],
    fields: [
      {
        kind: "Nodal",
        variable: "PRESSURE",
        components: 1,
        ids: nodeIds,
        values: Float64Array.from({ length: 12 }, (_, i) => i * 10),
      },
    ],
    diagnostics: [],
    is3D: true,
    bounds: { min: [0, 0, 0], max: [1, 1, 2] },
  };
}

test("skin extractor WASM matches TS on mixed hex/tet + surface + missing node", opts, () => {
  const model = hexAndTetModel();
  assert.deepEqual(extractSkinModel(model), extractSkinModelTs(model));

  // Missing node drops the cell in both.
  const broken = hexAndTetModel();
  broken.blocks[0].connectivity[0] = 99999;
  assert.deepEqual(extractSkinModel(broken), extractSkinModelTs(broken));
});

test("skin extractor WASM matches TS on committed fixtures", opts, () => {
  const root = path.resolve(__dirname, "../../src/test/fixtures");
  const walk = (dir: string, out: string[]): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f, out);
      else if (e.name.endsWith(".mdpa")) out.push(f);
    }
    return out;
  };
  for (const f of walk(root, [])) {
    const model = parseMdpaTs(fs.readFileSync(f, "utf8"));
    assert.deepEqual(extractSkinModel(model), extractSkinModelTs(model), f);
  }
});
