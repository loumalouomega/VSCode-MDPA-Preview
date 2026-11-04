/**
 * Derived meshes made by the meshio++ 17.23.0 sweep / layer / volume kernels:
 * `extrude`, `revolve`, `mirror`, `boundaryLayer`, `tetrahedralize`,
 * `errorSize` and `checkConformity`, and the 18.0.0 MMG family `adapt`,
 * `discretizeLevelset`, `meshDomain` plus `metricFromHessian`.
 *
 * The MMG kernels are the kernel's OWN MMG (5.8.0, linked into the FULL artifact only), a
 * separate path from the extension's in-place `remesh`/`levelset` ops, which keep running on
 * `@loumalouomega/mmg-wasm` and carry block/SubModelPart identity. These write a new mesh.
 * `move` is deliberately not routed: it needs MMG's ELAS library, linked into neither artifact.
 *
 * Like `kernelMeshes.ts` these are DERIVED meshes (a new file, never an edit of
 * the open mesh), dispatched from `deriveMesh.ts` so the UI export and MCP
 * `mesh_derive` share one path, and the result is read back through plain
 * `meshioToModel`: the cells are newly created, so there is no correspondence
 * to the source to preserve. The kernel validates every option key and range
 * itself, so `options` is passed through verbatim (undefined/null dropped) and
 * its own message is the error.
 *
 * `projectToCad` is deliberately not routed: it needs a mesh AND a B-rep from
 * two sources, and the B-rep side channel only exists on an unedited CAD read
 * (see `meshCapabilities.ts`).
 *
 * Pure module (no vscode / DOM): the wasm is loaded through `loadMeshio`.
 */

import type { MdpaDiagnostic, MdpaModel } from "./types";
import { meshioToModel, modelToMeshio } from "./meshioConvert";
import { loadMeshio, loadMeshioFull, meshioFullInstalled, type MeshioModule } from "./meshio";
import { triangleSurfaceOf } from "./gridSample";
import { withKratosBlockNames, legalFields, type KernelMeshResult } from "./kernelMeshes";

export const KERNEL_OP_KINDS = ["extrude", "revolve", "mirror", "boundaryLayer", "tetrahedralize", "errorSize", "checkConformity", "adapt", "discretizeLevelset", "meshDomain", "metricFromHessian", "findIntersections", "tetToPoly", "convexHull", "delaunay2d", "reconstructSurface", "estimateNormals", "parameterize"] as const;
/** The kinds that need MMG, which only the full artifact links (meshio++ 18.0.0). */
export const MMG_KERNEL_KINDS: readonly KernelOpKind[] = ["adapt", "discretizeLevelset", "meshDomain"];
export type KernelOpKind = (typeof KERNEL_OP_KINDS)[number];

export interface KernelOpSpec {
  kind: KernelOpKind;
  /** meshio++ options of that kernel, verbatim (see the kernel's documentation); the kernel refuses unknown keys. */
  options?: Record<string, unknown>;
}

const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
const n = (x: number) => x.toLocaleString("en-US");
const f = (x: number) => (Number.isFinite(x) ? String(+x.toPrecision(4)) : "n/a");
type Mesh = Parameters<typeof meshioToModel>[0];

/** One sentence for an MMG report. */
function mmgReport(r: { status: string; library: string; numPointsIn: number; numPointsOut: number; numElementsIn: number; numElementsOut: number; quality: { min: number; mean: number }; warnings: string[] }): string {
  return (
    `${r.library}: ${n(r.numPointsIn)} → ${n(r.numPointsOut)} node(s), ${n(r.numElementsIn)} → ${n(r.numElementsOut)} element(s), quality min ${f(r.quality.min)} / mean ${f(r.quality.mean)}` +
    (r.status === "lowFailure" ? " (MMG reported a low failure: the mesh is valid but not fully adapted)" : "") + "." + (r.warnings.length ? ` ${r.warnings.join(" ")}` : "")
  );
}

/** The volume cells a sweep made, e.g. "48 hexahedra, 4 wedges". */
function cellMix(r: { numHexahedra: number; numWedges: number; numPyramids: number; numTetrahedra: number }): string {
  const parts = [["hexahedra", r.numHexahedra], ["wedges", r.numWedges], ["pyramids", r.numPyramids], ["tetrahedra", r.numTetrahedra]] as const;
  return parts.filter(([, c]) => c > 0).map(([name, c]) => `${n(c)} ${name}`).join(", ") || "no cells";
}

/**
 * The module a kernel needs. The MMG kernels need the full artifact (a lean run would only throw
 * the kernel's own "needs {full: true}" refusal, so it is named here instead); `tetrahedralize`
 * prefers the full one because only it links Netgen, which keeps the surface triangles, and
 * falls back to the lean octree backend when the full pair is absent or `backend: "octree"` is asked.
 */
async function moduleFor(spec: KernelOpSpec, options: Record<string, unknown>): Promise<MeshioModule> {
  if (MMG_KERNEL_KINDS.includes(spec.kind)) {
    if (!meshioFullInstalled()) {
      throw new Error(`${spec.kind} runs on the MMG library that only the full meshio++ artifact links, and this install ships the lean one. Use the in-place Remesh (MMG) operation instead.`);
    }
    return loadMeshioFull();
  }
  if (spec.kind === "tetrahedralize" && options.backend !== "octree" && meshioFullInstalled()) return loadMeshioFull();
  return loadMeshio();
}

/** Runs one of the 17.23.0 / 18.0.0 kernels on the open mesh and reads its mesh back. */
export async function kernelOpModel(model: MdpaModel, spec: KernelOpSpec, diagnostics: MdpaDiagnostic[] = []): Promise<KernelMeshResult> {
  if (!(KERNEL_OP_KINDS as readonly string[]).includes(spec.kind)) throw new Error(`kind must be one of ${KERNEL_OP_KINDS.join(", ")}.`);
  const options = defined(spec.options ?? {});
  const m = await moduleFor(spec, options);
  // The layer and volume meshers read a closed triangle skin; every other kernel takes the mesh as it is.
  const wantsSkin = spec.kind === "boundaryLayer" || spec.kind === "tetrahedralize";
  const { surface, note } = wantsSkin ? triangleSurfaceOf(model) : { surface: model, note: "" };
  const input = modelToMeshio(surface, diagnostics, { dim: 3 });
  const warn = (w: string[]) => (w.length ? ` ${w.join(" ")}` : "");
  const read = (mesh: unknown, rename: Record<string, string> = {}) => legalFields(withKratosBlockNames(meshioToModel(mesh as Mesh, diagnostics)), rename);

  switch (spec.kind) {
    case "extrude": {
      const r = m.extrude(input, options);
      return {
        model: read(r.mesh),
        summary:
          `Extruded: ${n(r.numCells)} cell(s) (${cellMix(r)}); min scaled Jacobian ${f(r.minScaledJacobian)}` +
          (r.numFlipped > 0 ? `, ${n(r.numFlipped)} FLIPPED cell(s)` : "") + "." + warn(r.warnings),
        suffix: "extruded",
      };
    }
    case "revolve": {
      const r = m.revolve(input, options);
      return {
        model: read(r.mesh),
        summary:
          `Revolved${r.full ? " (full turn, closed)" : ""}: ${n(r.numCells)} cell(s) (${cellMix(r)}); ${n(r.numOnAxis)} node(s) on the axis; min scaled Jacobian ${f(r.minScaledJacobian)}` +
          (r.numFlipped > 0 ? `, ${n(r.numFlipped)} FLIPPED cell(s)` : "") + "." + warn(r.warnings),
        suffix: "revolved",
      };
    }
    case "mirror": {
      const r = m.mirror(input, options);
      return {
        model: read(r.mesh),
        summary:
          `Mirrored: ${n(r.numPointsOnPlane)} node(s) on the plane, ${n(r.numFlippedCells)} cell(s) re-wound` +
          (r.numDroppedCells + r.numDroppedSides > 0 ? `, ${n(r.numDroppedCells)} cell(s) and ${n(r.numDroppedSides)} side(s) dropped` : "") + "." + warn(r.warnings),
        suffix: "mirrored",
      };
    }
    case "boundaryLayer": {
      const r = m.boundaryLayer(input, options);
      return {
        model: read(r.mesh),
        summary:
          `Boundary layer on ${note}: ${n(r.numCells)} cell(s) (${cellMix(r)}), thickness ${f(r.minThickness)}–${f(r.maxThickness)}, min scaled Jacobian ${f(r.minScaledJacobian)}` +
          (r.numShrunk + r.numFewerLayers + r.numCollapsed > 0 ? `; ${r.numShrunk} shrunk, ${r.numFewerLayers} with fewer layers, ${r.numCollapsed} collapsed` : "") +
          (r.numFrontCrossings > 0 ? `, ${r.numFrontCrossings} front crossing(s)` : "") +
          `; cap ${r.capClosed ? "closed" : "OPEN"}.` + warn(r.warnings),
        suffix: "boundary_layer",
      };
    }
    case "tetrahedralize": {
      const r = m.tetrahedralize(input, options);
      return {
        model: read(r.mesh, { sdf_distance: "SDF_DISTANCE" }),
        summary:
          `Tetrahedralized ${note} (${r.backend} backend): ${n(r.numTetrahedra)} tetrahedra, ${n(r.numPoints)} node(s), volume ${f(r.volume)}, dihedral ${f(r.minDihedralDeg)}°–${f(r.maxDihedralDeg)}°. ` +
          (r.boundaryPreserved ? "The surface triangles are kept." : `The boundary is fitted within ${f(r.hausdorffToSurface)} of the surface, not kept exactly.`) +
          (!m.hasNetgen() ? " (This build has no Netgen backend, so the native octree mesher ran; the full meshio++ artifact keeps the surface triangles.)" : "") + warn(r.warnings.filter((w) => !/no Netgen/.test(w))),
        suffix: "tetrahedralized",
      };
    }
    case "errorSize": {
      const r = m.errorSize(input, options);
      return {
        model: read(r.mesh),
        summary: `Error-driven size field over ${n(r.numCells)} cell(s) (${n(r.numSkipped)} skipped, ${n(r.numClamped)} clamped to the size limits).` + warn(r.warnings),
        suffix: "error_size",
      };
    }
    case "adapt":
    case "discretizeLevelset": {
      const r = spec.kind === "adapt" ? m.adapt(input, options) : m.discretizeLevelset(input, options);
      return {
        model: read(r.mesh),
        summary: `${spec.kind === "adapt" ? "Adapted" : "Level set discretized"} with ${mmgReport(r.report)}`,
        suffix: spec.kind === "adapt" ? "adapted" : "levelset",
      };
    }
    case "meshDomain": {
      const r = m.meshDomain(input, options);
      return {
        model: read(r.mesh),
        summary: `Meshed the planar domain (${n(r.numSubdomains)} subdomain(s), ${n(r.numHoles)} hole(s)) with ${mmgReport(r.report)}`,
        suffix: "domain",
      };
    }
    case "metricFromHessian": {
      const mesh = m.metricFromHessian(input, options);
      const out = read(mesh);
      const before = new Set(model.fields.map((fd) => `${fd.kind}:${fd.variable}`));
      const added = out.fields.filter((fd) => !before.has(`${fd.kind}:${fd.variable}`)).map((fd) => fd.variable);
      return {
        model: out,
        summary: `Metric from the Hessian: ${added.length > 0 ? `wrote ${added.join(", ")}` : "no new field"} (the size/metric input of an MMG adapt).`,
        suffix: "metric",
      };
    }
    case "tetToPoly": {
      // The median dual: one polyhedron per vertex. Read back through meshioToModel, the polyhedra become
      // tetrahedra plus the `model.polyhedra` side channel, which only the native .vtu writer folds back
      // into real polyhedra (every other writer sees the tetrahedra).
      const r = m.tetToPoly(input, options, true) as { mesh: Mesh; numNewPoints: number; numBoundaryFaces: number; numSplitVertices: number };
      const out = read(r.mesh);
      return {
        model: out,
        summary:
          `Polyhedral dual: ${n(out.polyhedra?.count ?? 0)} polyhedra, ${n(r.numNewPoints)} new point(s), ${n(r.numBoundaryFaces)} boundary face(s)${r.numSplitVertices > 0 ? `, ${n(r.numSplitVertices)} vertex(es) split across blocks` : ""}. ` +
          "Only a .vtu keeps the polyhedra; every other format receives their tetrahedral decomposition.",
        suffix: "dual",
      };
    }
    case "convexHull": {
      const r = m.convexHull(input, options);
      return {
        model: read(r.mesh, { hull_point_id: "SOURCE_NODE_INDEX" }),
        summary:
          `Convex hull (${r.dimension}-D): ${n(r.numVertices)} vertex(es), ${n(r.numFacets)} facet(s)` +
          (r.dimension === 3 ? `, area ${f(r.area)}, volume ${f(r.volume)}` : `, perimeter ${f(r.perimeter)}, area ${f(r.area)}`) + ". " +
          "SOURCE_NODE_INDEX is each vertex's 0-based position in the input node list.",
        suffix: "hull",
      };
    }
    case "delaunay2d": {
      const r = m.delaunay2d(input);
      return {
        model: read(r.mesh),
        summary:
          `Delaunay triangulation of the x, y plane: ${n(r.numTriangles)} triangle(s), ${n(r.numBoundary)} boundary edge(s)` +
          (r.numDuplicates > 0 ? `; ${n(r.numDuplicates)} point(s) coincide in x, y with an earlier one and are in no triangle` : "") + ".",
        suffix: "delaunay",
      };
    }
    case "reconstructSurface": {
      const r = m.reconstructSurface(input, options);
      return {
        model: read(r.mesh),
        summary:
          `Reconstructed a surface from ${n(r.numSamples)} sample(s): ${n(r.numTriangles)} triangle(s), ${n(r.numComponents)} component(s)` +
          (r.estimatedNormals ? ", normals estimated" : "") + (r.numUndefined > 0 ? `; ${n(r.numUndefined)} lattice node(s) undefined (an open scan stays open)` : "") + ".",
        suffix: "reconstructed",
      };
    }
    case "parameterize": {
      const r = m.parameterize(input, options);
      // MdpaModel has no texture-coordinate slot, so the atlas rides as an ordinary 2-component nodal field.
      return {
        model: read(r.mesh, { uv: "UV", parameterize_parent_point: "PARAMETERIZE_PARENT_NODE", parameterize_chart: "PARAMETERIZE_CHART" }),
        summary:
          `UV atlas: ${n(r.numCharts)} chart(s), ${n(r.numSeamPoints)} seam point(s) split, L2 stretch ${f(r.stretch)}, packing ${f(r.packingEfficiency)}` +
          (r.numFlipped > 0 ? `, ${n(r.numFlipped)} FLIPPED triangle(s)` : "") + ". " +
          "The coordinates are the nodal field UV (2 components) — a .vtu or .mdpa keeps it; OBJ/glTF texture coordinates are not written by this extension.",
        suffix: "uv",
      };
    }
    case "estimateNormals": {
      const r = m.estimateNormals(input, options);
      return {
        model: read(r.mesh),
        summary: `Estimated normals for ${n(input.points.length / 3)} point(s) (${n(r.numComponents)} piece(s))` + (r.numDegenerate > 0 ? `; ${n(r.numDegenerate)} degenerate neighbourhood(s) read NaN` : "") + ".",
        suffix: "normals",
      };
    }
    case "findIntersections": {
      const r = m.findIntersections(input, { segments: true, ...options });
      if (!r.segments || r.numSegments === 0) {
        throw new Error(r.clean ? "The surface has no self-intersections, so there are no segments to write." : "The intersection produced no segments (only coplanar overlaps?).");
      }
      return {
        model: read(r.segments),
        summary: `Intersection curve: ${n(r.numSegments)} segment(s) from ${n(r.numPairs)} intersecting facet pair(s)${r.numCoplanar > 0 ? ` (${n(r.numCoplanar)} coplanar)` : ""}.` + warn(r.warnings),
        suffix: "intersections",
      };
    }
    case "checkConformity": {
      const r = m.checkConformity(input, { attachFlags: true, ...options });
      return {
        model: read(r.mesh),
        summary:
          `Conformity (${r.dimension}-D, ${r.interfaceMode}): ${r.conforming ? "conforming" : "NOT conforming"} — ${n(r.numHangingNodes)} hanging node(s), ${n(r.numTJunctions)} T-junction(s), ` +
          `${n(r.numPartialOverlaps)} partial overlap(s), ${n(r.numUnweldedFacets)} unwelded facet(s), ${n(r.numNonManifoldFacets)} non-manifold facet(s); ${n(r.numBoundaryFacets)} boundary facet(s).` + warn(r.warnings),
        suffix: "conformity",
      };
    }
  }
}
