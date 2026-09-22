// Regenerate two-piece.pvtu + pieceA.vtu + pieceB.vtu: a hand-built
// parallel/partitioned VTK XML fixture (roadmap item 3, Step 4/4b), since
// meshio++'s own writers produce only a SINGLE-piece .pvtu (one `<Piece
// Source="…"/>` per writeMesh call, measured directly against the live
// wasm) — there is no dedicated multi-piece pvtu writer to fan out from,
// unlike sequenceToTimeseries for vtkhdf/pvd. So this writes the two pieces
// separately via the ordinary .vtu writer and splices a two-`<Piece>` index
// by hand, following the `PUnstructuredGrid`/`PPointData`/`PCellData`/
// `PPoints` shape meshio++'s own single-piece writer emits.
//
// Piece 0 (pieceA.vtu): one triangle at x∈[0,1], TEMP=[10,20,30]. No ghost
// cells.
// Piece 1 (pieceB.vtu): two triangles — cell 0 is a genuine, disjoint
// triangle at x∈[2,3] (TEMP=[40,50,60]); cell 1 DUPLICATES piece A's
// triangle exactly (same coordinates and TEMP) and carries a `vtkGhostType`
// cell-data array with the bit set — the real partition-boundary shape
// `dropGhosts` exists for. Per meshioplusplus/src/cpp/src/formats/
// pindex_common.hpp's `drop_ghosts()`: a piece with no `vtkGhostType`
// cell-data array is left untouched, one with the bit set has that cell
// (and any point used only by it) removed.
//
// Measured against the live 15.4.0 wasm: `readMeshSelective`'s own default
// (no `dropGhosts` passed at all) KEEPS the ghost cell — 9 points / 3
// cells — so the "dropGhosts: true by default for .pvtu/.pvtp" behaviour
// this extension documents is applied by meshFileParser.ts's own dispatch,
// not inherited from the wasm.
//
// Run from the repo root: node src/test/fixtures/pvtu/generate-pvtu.mjs
// Requires no build step — it calls the installed @meshioplusplus/wasm
// package directly.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadMeshioPlusPlus } from "@meshioplusplus/wasm";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const m = await loadMeshioPlusPlus({}, { variant: "seq" });

const pieceA = {
  points: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  dim: 3,
  cells: [{ type: "triangle", data: new Int32Array([0, 1, 2]), nodesPerCell: 3 }],
  point_data: { TEMP: new Float64Array([10, 20, 30]) },
};

const pieceB = {
  points: new Float64Array([2, 0, 0, 3, 0, 0, 2, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0]),
  dim: 3,
  cells: [{ type: "triangle", data: new Int32Array([0, 1, 2, 3, 4, 5]), nodesPerCell: 3 }],
  point_data: { TEMP: new Float64Array([40, 50, 60, 10, 20, 30]) },
  // One DataArray per cell block (this mesh has exactly one triangle
  // block): scalar UInt8, cell 0 real (0), cell 1 ghost (1).
  cell_data: { vtkGhostType: [new Uint8Array([0, 1])] },
};

m.writeMesh("/pieceA.vtu", pieceA, "vtu");
m.writeMesh("/pieceB.vtu", pieceB, "vtu");

const pvtu = `<?xml version="1.0"?>
<VTKFile type="PUnstructuredGrid" version="1.0" byte_order="LittleEndian">
<!--Hand-built fixture (roadmap item 3): two pieces, piece 1 carries one
     vtkGhostType-tagged duplicate cell -- see generate-pvtu.mjs.-->
<PUnstructuredGrid GhostLevel="0">
<PPointData>
<PDataArray type="Float64" Name="TEMP"/>
</PPointData>
<PCellData>
<PDataArray type="UInt8" Name="vtkGhostType"/>
</PCellData>
<PPoints>
<PDataArray type="Float64" Name="Points" NumberOfComponents="3"/>
</PPoints>
<Piece Source="pieceA.vtu"/>
<Piece Source="pieceB.vtu"/>
</PUnstructuredGrid>
</VTKFile>
`;
m.FS.writeFile("/two-piece.pvtu", pvtu);

// Verify the shape this fixture exists to pin, before committing it.
const dropped = m.readMeshSelective("/two-piece.pvtu", { format: "pvtu", dropGhosts: true });
if (dropped.points.length / 3 !== 6 || dropped.cells[0].data.length / 3 !== 2) {
  throw new Error(
    `dropGhosts:true: expected 6 points / 2 cells, got ${dropped.points.length / 3} / ${dropped.cells[0].data.length / 3}`
  );
}
const kept = m.readMeshSelective("/two-piece.pvtu", { format: "pvtu", dropGhosts: false });
if (kept.points.length / 3 !== 9 || kept.cells[0].data.length / 3 !== 3) {
  throw new Error(
    `dropGhosts:false: expected 9 points / 3 cells, got ${kept.points.length / 3} / ${kept.cells[0].data.length / 3}`
  );
}
const bareDefault = m.readMeshSelective("/two-piece.pvtu", { format: "pvtu" });
if (bareDefault.points.length / 3 !== 9) {
  throw new Error("expected the wasm's own bare default to KEEP ghosts (9 points) — see the header comment");
}
const piece1 = m.readMeshSelective("/two-piece.pvtu", { format: "pvtu", piece: 1, dropGhosts: false });
if (JSON.stringify([...piece1.point_data.TEMP]) !== JSON.stringify([40, 50, 60, 10, 20, 30])) {
  throw new Error(`piece 1 alone: unexpected TEMP ${JSON.stringify([...piece1.point_data.TEMP])}`);
}
const piece0 = m.readMeshSelective("/two-piece.pvtu", { format: "pvtu", piece: 0 });
if (JSON.stringify([...piece0.point_data.TEMP]) !== JSON.stringify([10, 20, 30])) {
  throw new Error(`piece 0 alone: unexpected TEMP ${JSON.stringify([...piece0.point_data.TEMP])}`);
}

writeFileSync(path.join(HERE, "two-piece.pvtu"), pvtu);
writeFileSync(path.join(HERE, "pieceA.vtu"), m.FS.readFile("/pieceA.vtu"));
writeFileSync(path.join(HERE, "pieceB.vtu"), m.FS.readFile("/pieceB.vtu"));
console.log("wrote two-piece.pvtu + pieceA.vtu + pieceB.vtu");
