/**
 * Per-format audit of high-order node ordering (roadmap item 10). A quadratic
 * cell with every mid node exactly on its edge is written through each
 * meshio++ writer, read back, and each mid node must still sit on the
 * midpoint of the VTK-ordered edge it belongs to. A format whose writer or
 * reader permutes the mid nodes moves a point off the edge and fails here,
 * naming the format and cell type.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { parseMdpa } from "../parser/mdpaParser";
import { parseMeshFile } from "../parser/meshFileParser";
import { linearToQuadratic } from "../parser/linearToQuadratic";
import { writeMeshFileAsync } from "../parser/writers/meshWriter";
import type { MdpaModel } from "../parser/types";

type Edges = number[][];
interface Shape { name: string; element: string; nodes: number[][]; edges: Edges; }

const TET: Edges = [[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]];
const HEX: Edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
const WEDGE: Edges = [[0, 1], [1, 2], [2, 0], [3, 4], [4, 5], [5, 3], [0, 3], [1, 4], [2, 5]];
const PYR: Edges = [[0, 1], [1, 2], [2, 3], [3, 0], [0, 4], [1, 4], [2, 4], [3, 4]];
const TRI: Edges = [[0, 1], [1, 2], [2, 0]];
const QUAD: Edges = [[0, 1], [1, 2], [2, 3], [3, 0]];

// Deliberately asymmetric coordinates, so a swapped pair of mid nodes cannot
// land on another edge's midpoint by symmetry.
const SHAPES: Shape[] = [
  { name: "tet10", element: "Element3D4N", edges: TET, nodes: [[0, 0, 0], [2, 0.1, 0], [0.2, 1.5, 0.1], [0.3, 0.2, 1.7]] },
  { name: "hex20", element: "Element3D8N", edges: HEX, nodes: [[0, 0, 0], [2, 0, 0], [2.2, 1.5, 0], [0, 1.4, 0.1], [0, 0.1, 1.8], [2.1, 0, 1.7], [2, 1.5, 1.9], [0, 1.6, 1.6]] },
  { name: "wedge15", element: "Prism3D6N", edges: WEDGE, nodes: [[0, 0, 0], [2, 0, 0], [0.3, 1.5, 0], [0, 0, 1.8], [2, 0.1, 1.7], [0.3, 1.5, 1.9]] },
  { name: "pyramid13", element: "Pyramid3D5N", edges: PYR, nodes: [[0, 0, 0], [2, 0, 0], [2.1, 1.5, 0], [0, 1.4, 0], [0.9, 0.7, 1.6]] },
  { name: "tri6", element: "Element2D3N", edges: TRI, nodes: [[0, 0, 0], [2, 0.1, 0], [0.3, 1.5, 0]] },
  { name: "quad8", element: "Element2D4N", edges: QUAD, nodes: [[0, 0, 0], [2, 0, 0], [2.2, 1.5, 0], [0, 1.4, 0]] },
];

/** One mesh holding one quadratic cell of each given shape (disjoint nodes), so a format costs one write and one read. */
function quadraticModel(shapes: Shape[]): MdpaModel {
  let nodeBase = 0;
  const nodeLines: string[] = [];
  const blocks: string[] = [];
  shapes.forEach((s, k) => {
    s.nodes.forEach((p, i) => nodeLines.push(`  ${nodeBase + i + 1} ${p.join(" ")}`));
    const ids = s.nodes.map((_, i) => nodeBase + i + 1).join(" ");
    blocks.push(`Begin Elements ${s.element}\n  ${k + 1} 0 ${ids}\nEnd Elements\n`);
    nodeBase += s.nodes.length;
  });
  const text = ["Begin Properties 0", "End Properties", "", "Begin Nodes", ...nodeLines, "End Nodes", "", ...blocks].join("\n");
  const r = linearToQuadratic(parseMdpa(text));
  assert.equal(r.convertedCells, shapes.length);
  return r.model;
}

const cornerCount = (edges: Edges): number => new Set(edges.flat()).size;

/** Largest distance of a mid node from the midpoint of the edge the VTK numbering assigns it. */
function worstMidOffset(model: MdpaModel, edges: Edges): number {
  const index = new Map<number, number>();
  model.nodeIds.forEach((id, i) => index.set(id, i));
  const at = (id: number): number[] => {
    const i = index.get(id)!;
    return [model.coords[i * 3], model.coords[i * 3 + 1], model.coords[i * 3 + 2]];
  };
  const corners = cornerCount(edges);
  const stride = corners + edges.length;
  const found = model.blocks.filter((b) => b.stride === stride);
  assert.equal(found.length, 1, `exactly one block of stride ${stride} expected`);
  const b = found[0];
  let worst = 0;
  for (let c = 0; c < b.connectivity.length / stride; c++) {
    const ids = Array.from(b.connectivity.subarray(c * stride, c * stride + stride));
    edges.forEach(([a, z], k) => {
      const pa = at(ids[a]);
      const pz = at(ids[z]);
      const pm = at(ids[corners + k]);
      for (let d = 0; d < 3; d++) worst = Math.max(worst, Math.abs(pm[d] - (pa[d] + pz[d]) / 2));
    });
  }
  return worst;
}

/** extension and label; `.vtu` is our native writer and acts as the control. */
const FORMATS: { ext: string; label: string }[] = [
  { ext: ".vtu", label: "vtu (native control)" },
  { ext: ".msh", label: "gmsh" },
  { ext: ".med", label: "med" },
  { ext: ".inp", label: "abaqus" },
  { ext: ".exo", label: "exodus" },
  { ext: ".cgns", label: "cgns" },
  { ext: ".bdf", label: "nastran" },
  { ext: ".unv", label: "unv" },
];

/** format label → cell types the format cannot carry, with the reason (measured at meshio++ 17.13.0). */
const UNSUPPORTED: Record<string, Record<string, string>> = {
  abaqus: { pyramid13: "the Abaqus writer rejects pyramid13 (\"unsupported cell type\")" },
};

// One wasm write plus one read per format and mesh: a fresh kernel instance per
// operation made the per-shape version hold ~4 GB, enough to stall CI runners.
for (const f of FORMATS) {
  test(`${f.label}: quadratic mid nodes keep VTK order`, async () => {
    const skip = UNSUPPORTED[f.label] ?? {};
    const shapes = SHAPES.filter((s) => !skip[s.name]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoo-"));
    try {
      // 3D and 2D cells go in separate meshes: several writers take one dimension.
      const flat = (s: Shape) => s.name === "tri6" || s.name === "quad8";
      for (const [dim, set] of [["3d", shapes.filter((s) => !flat(s))], ["2d", shapes.filter(flat)]] as const) {
        const file = path.join(dir, `cell${dim}${f.ext}`);
        const w = await writeMeshFileAsync(quadraticModel(set), f.ext, { stem: path.basename(file, f.ext) } as never);
        fs.writeFileSync(file, w.data as Uint8Array);
        for (const c of w.companions ?? []) {
          const p = path.join(dir, c.name);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, c.data as Uint8Array);
        }
        const back = await parseMeshFile(file);
        for (const s of set) assert.ok(worstMidOffset(back, s.edges) < 1e-5, `${f.label} ${s.name}: mid node off its edge`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("abaqus: pyramid13 is rejected by the writer (recorded gap)", async () => {
  const pyr = SHAPES.find((s) => s.name === "pyramid13")!;
  await assert.rejects(writeMeshFileAsync(quadraticModel([pyr]), ".inp", { stem: "p" } as never), /unsupported cell type/);
});
