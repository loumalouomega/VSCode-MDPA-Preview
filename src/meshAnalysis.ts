import { qualityGate, hausdorff, periodicNodes, featureEdges, PeriodicOptions, FeatureEdgeOptions } from "./parser/analysisOps";
import { parseMeshFile } from "./parser/meshFileParser";
import { parseMdpa } from "./parser/mdpaParser";
import { meshExtname } from "./parser/meshFormats";
import * as fs from "node:fs/promises";
/**
 * Host side of the webview's read-only mesh analyses.
 *
 * These two questions — "is this boundary closed?" and "what does this field
 * integrate to?" — are answered by meshio++, and the wasm is host-only (the
 * package is `external` and lives in `dist/meshio/`, unreachable from the
 * webview bundle). Every other analysis panel in this extension computes in the
 * webview from pure modules; these cannot, so they take one message round trip.
 *
 * One request/response pair covers both rather than two, because the shape is
 * identical — a kind, an optional argument, and a result or an error — and a
 * third analysis should be a new `kind`, not a third pair of message types.
 *
 * Neither analysis modifies the model, so neither goes through the operation
 * history and neither leaves an undo entry.
 */

import { watertightReport, watertightSummary } from "./parser/watertight";
import { integrateFields } from "./parser/fieldIntegrate";
import { lodSurface } from "./parser/lodSurface";
import { probeAlongPath } from "./parser/pathProbe";
import { MdpaModel } from "./parser/types";

export interface MeshAnalysisMessage extends FeatureEdgeOptions {
  require?: string; maxInverted?: number; maxDegenerate?: number;
  path?: string; faceSamples?: number;
  slave?: string; master?: string; matrix?: number[]; translate?: number[]; rotate?: PeriodicOptions["rotate"]; atol?: number; requireComplete?: boolean;
  type: "meshAnalysis";
  kind?: string;
  variables?: string[];
  /** Probe kind: the polyline's vertices (≥2), a nodal variable and the
   *  equidistant sample count along it (pathProbe.ts's own defaults). */
  points?: number[][];
  variable?: string;
  samples?: number;
  /** Echoed verbatim on the probe reply so the webview can drop a stale one
   *  (an older sequence straggling behind a newer re-request during playback). */
  seq?: number;
}

/**
 * Runs one analysis and returns the reply to post. Errors become a `message`
 * on the reply rather than a rejection: a failed analysis should show a line in
 * the panel, never tear down the message handler.
 */
export async function runMeshAnalysis(
  msg: MeshAnalysisMessage,
  model: MdpaModel | undefined
): Promise<Record<string, unknown>> {
  const kind = msg.kind ?? "";
  if (!model) return { type: "meshAnalysisResult", kind, message: "No mesh is loaded." };
  try {
    if (kind === "qualityGate") return { type: "meshAnalysisResult", kind, report: await qualityGate(model, msg.require, msg.maxInverted, msg.maxDegenerate) };
    if (kind === "hausdorff") {
      if (!msg.path) throw new Error("Choose a comparison mesh path.");
      const other = meshExtname(msg.path) === ".mdpa" ? parseMdpa(await fs.readFile(msg.path,"utf8")) : await parseMeshFile(msg.path);
      return { type: "meshAnalysisResult", kind, report: await hausdorff(model, other, msg.faceSamples) };
    }
    if (kind === "periodicNodes") return { type: "meshAnalysisResult", kind, report: await periodicNodes(model, { ...msg, slave: msg.slave ?? "", master: msg.master ?? "" }) };
    if (kind === "featureEdges") {
      const r = await featureEdges(model,msg);
      const lines: number[] = [];
      const nodeIndex = new Map(Array.from(r.model.nodeIds,(id,i)=>[id,i]));
      for (const b of r.model.blocks) for (let i=0;i<b.count;i++) lines.push(2,nodeIndex.get(b.connectivity[i*b.stride])!,nodeIndex.get(b.connectivity[i*b.stride+1])!);
      return { type: "meshAnalysisResult", kind, report: r.counts, edges: { points: Array.from(r.model.coords), lines } };
    }

    if (kind === "watertight") {
      const report = await watertightReport(model);
      return report
        ? { type: "meshAnalysisResult", kind, report, summary: watertightSummary(report) }
        : { type: "meshAnalysisResult", kind, message: "The mesh has no cells to check." };
    }
    if (kind === "integrate") {
      const integrals = await integrateFields(model, msg.variables ?? []);
      return { type: "meshAnalysisResult", kind, integrals };
    }
    if (kind === "lod") {
      // The preview level of detail: a decimated surface to draw in place of the
      // full layers. Read-only — the mesh and its history are untouched.
      const lod = await lodSurface(model);
      return { type: "meshAnalysisResult", kind, lod };
    }
    if (kind === "probe") {
      // Interactive line probe: distance-versus-value along a polyline through
      // the CURRENT frame. Same `probeAlongPath` core the `mesh_probe` MCP tool
      // calls, so the UI's numbers equal the tool's for the same endpoints. The
      // webview follows the timeline by re-posting per frame; a stale reply is
      // the webview's sequence-tag problem, not this function's.
      const points = msg.points ?? [];
      const variable = msg.variable ?? "";
      if (!Array.isArray(points) || points.length < 2) {
        return { type: "meshAnalysisResult", kind, message: "A probe needs at least two path points." };
      }
      if (!variable) {
        return { type: "meshAnalysisResult", kind, message: "Pick a field for the probe." };
      }
      const probe = await probeAlongPath(model, {
        points: points as [number, number, number][],
        samples: msg.samples ?? 101,
        variable,
      });
      return { type: "meshAnalysisResult", kind, probe, seq: msg.seq };
    }
    return { type: "meshAnalysisResult", kind, message: `Unknown analysis "${kind}".` };
  } catch (err) {
    return {
      type: "meshAnalysisResult",
      kind,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
