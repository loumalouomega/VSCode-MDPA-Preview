/**
 * Derived meshes made by the meshio++ 17.23.0 sweep / layer / volume kernels:
 * `extrude`, `revolve`, `mirror`, `boundaryLayer`, `tetrahedralize`,
 * `errorSize` and `checkConformity`.
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
import { loadMeshio } from "./meshio";
import { triangleSurfaceOf } from "./gridSample";
import { withKratosBlockNames, legalFields, type KernelMeshResult } from "./kernelMeshes";

export const KERNEL_OP_KINDS = ["extrude", "revolve", "mirror", "boundaryLayer", "tetrahedralize", "errorSize", "checkConformity"] as const;
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

/** The volume cells a sweep made, e.g. "48 hexahedra, 4 wedges". */
function cellMix(r: { numHexahedra: number; numWedges: number; numPyramids: number; numTetrahedra: number }): string {
  const parts = [["hexahedra", r.numHexahedra], ["wedges", r.numWedges], ["pyramids", r.numPyramids], ["tetrahedra", r.numTetrahedra]] as const;
  return parts.filter(([, c]) => c > 0).map(([name, c]) => `${n(c)} ${name}`).join(", ") || "no cells";
}

/** Runs one of the 17.23.0 kernels on the open mesh and reads its mesh back. */
export async function kernelOpModel(model: MdpaModel, spec: KernelOpSpec, diagnostics: MdpaDiagnostic[] = []): Promise<KernelMeshResult> {
  if (!(KERNEL_OP_KINDS as readonly string[]).includes(spec.kind)) throw new Error(`kind must be one of ${KERNEL_OP_KINDS.join(", ")}.`);
  const options = defined(spec.options ?? {});
  const m = await loadMeshio();
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
          (!m.hasNetgen() ? " (This build has no Netgen backend, so the native octree mesher ran.)" : "") + warn(r.warnings.filter((w) => !/no Netgen/.test(w))),
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
