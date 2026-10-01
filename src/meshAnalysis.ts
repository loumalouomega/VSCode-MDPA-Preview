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
import { describeFlowBalance, flowBalance, FlowBalanceSpec } from "./parser/flowBalance";
import { lodSurface } from "./parser/lodSurface";
import { probeAlongPath } from "./parser/pathProbe";
import { describeStreamlines, streamlinePolylines, traceStreamlines, StreamSeeds } from "./parser/streamlines";
import type { StreamlineOptions, StreamlineParams, StreamlineResult } from "./parser/streamlines";
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
  /** Streamlines kind (`variable` names the Nodal vector field): where to seed and the integration bounds — see streamlines.ts. */
  seeds?: StreamSeeds;
  direction?: "forward" | "backward" | "both";
  maxSteps?: number;
  maxLength?: number;
  stepFraction?: number;
  minSpeed?: number;
  maxSeeds?: number;
  /** Flow-balance kind: the sections, fields and conventions — see flowBalance.ts. `seq` is echoed like the probe's. */
  flow?: FlowBalanceSpec;
}

/**
 * Runs one analysis and returns the reply to post. Errors become a `message`
 * on the reply rather than a rejection: a failed analysis should show a line in
 * the panel, never tear down the message handler.
 *
 * `opts.traceRunner` is the worker seam for streamlines (roadmap item 9): the
 * providers pass `runStreamlinesInWorker` so a large seed set never blocks the
 * host, with `signal`/`onProgress` carried through; every other caller keeps
 * the in-process default, which is the same `traceStreamlines` core either way.
 */
export async function runMeshAnalysis(
  msg: MeshAnalysisMessage,
  model: MdpaModel | undefined,
  opts: StreamlineOptions & {
    traceRunner?: (model: MdpaModel, params: StreamlineParams, opts?: StreamlineOptions) => Promise<StreamlineResult>;
  } = {}
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
    if (kind === "streamlines") {
      // Steady streamlines of the CURRENT frame, drawn as a live overlay. The same
      // `traceStreamlines` core `mesh_derive` kind "streamlines" writes to a file,
      // so the picture and the export cannot disagree. The reply repeats `seq` so
      // the webview can drop a straggler that a newer request has superseded.
      if (!msg.variable) return { type: "meshAnalysisResult", kind, message: "Pick a Nodal vector field to trace.", seq: msg.seq };
      if (!msg.seeds) return { type: "meshAnalysisResult", kind, message: "Choose where to seed the streamlines.", seq: msg.seq };
      const r = await (opts.traceRunner ?? traceStreamlines)(
        model,
        {
          variable: msg.variable,
          seeds: msg.seeds,
          direction: msg.direction,
          maxSteps: msg.maxSteps,
          maxLength: msg.maxLength,
          stepFraction: msg.stepFraction,
          minSpeed: msg.minSpeed,
          maxSeeds: msg.maxSeeds,
        },
        { signal: opts.signal, onProgress: opts.onProgress }
      );
      const d = streamlinePolylines(r);
      return {
        type: "meshAnalysisResult",
        kind,
        seq: msg.seq,
        summary: describeStreamlines(r),
        streamlines: {
          points: d.points,
          lines: d.lines,
          speed: d.speed,
          termination: d.termination,
          lineCount: r.lines.length,
          seedCount: r.seeds.length,
          rejected: r.rejected.length,
          truncated: r.truncated,
        },
      };
    }
    if (kind === "flowBalance") {
      // Signed boundary flux and pressure of the CURRENT frame — the same
      // `flowBalance` core MCP `mesh_flow_balance` calls, so the panel's numbers
      // equal the tool's. `seq` rides every reply (also a refusal and a failure)
      // so a delayed answer for an older frame or request can be told apart.
      if (!msg.flow) return { type: "meshAnalysisResult", kind, message: "Choose the sections to balance.", seq: msg.seq };
      const result = flowBalance(model, msg.flow);
      return { type: "meshAnalysisResult", kind, seq: msg.seq, summary: describeFlowBalance(result), flow: result };
    }
    return { type: "meshAnalysisResult", kind, message: `Unknown analysis "${kind}".` };
  } catch (err) {
    return {
      type: "meshAnalysisResult",
      kind,
      message: err instanceof Error ? err.message : String(err),
      // A failed streamline trace must still carry its sequence tag, or a
      // delayed error could not be told apart from the current request's.
      ...(kind === "streamlines" || kind === "flowBalance" ? { seq: msg.seq } : {}),
    };
  }
}
