/**
 * Running a wind-tunnel plan: the lattice, the distance-driven refinement, the
 * carve, the wall layer and the checks, in the order `planWindTunnel` listed
 * them, with progress, cancellation and a report of what was achieved.
 *
 * The runner is the only part that touches the file system (the placed body is
 * written as an STL because the distance operation reads a file, the same way
 * MCP `mesh_transform` does). Everything it computes goes through the ordinary
 * operations, so each step is the same undoable, cancellable op a user could
 * apply by hand.
 *
 * No vscode import: the viewer and the MCP server both call this.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { applyOpAsync } from "../../parser/operations";
import type { OpOutcome, OpRecord } from "../../parser/operations";
import { writeMeshFile } from "../../parser/writers/meshWriter";
import { triangleSurfaceOf } from "../../parser/gridSample";
import { decimateModel } from "../../parser/decimate";
import type { MdpaModel } from "../../parser/types";
import { buildTunnelBackground, gradedAxis } from "./backgroundMesh";
import { finishCarvedMesh, checkFluidMesh } from "./finish";
import type { MeshCheck } from "./finish";
import { WIND_TUNNEL_VERSION } from "./plan";
import type { WindTunnelPlan } from "./plan";
import { yPlusAt } from "./estimate";

export interface WindTunnelProgress {
  stepIndex: number;
  steps: number;
  id: string;
  label: string;
  /** Latest line from the operation under way, when it reports one. */
  message?: string;
}

export interface WindTunnelRunOptions {
  /** Folder for the mesh, the placed body and the recipe. Created when missing. */
  folder: string;
  /** File stem. Default "tunnel". */
  stem?: string;
  signal?: AbortSignal;
  onProgress?: (p: WindTunnelProgress) => void;
  /** Replace the operation runner (tests drive a faster or fake one). */
  applyOp?: (model: MdpaModel, rec: OpRecord, o?: { signal?: AbortSignal; onProgress?: (m: string) => void }) => Promise<OpOutcome>;
}

export interface WindTunnelReport {
  version: number;
  mode: "bodyFitted" | "embedded";
  tetrahedra: number;
  nodes: number;
  estimate: { expectedTetrahedra: number; ratio: number };
  check: MeshCheck;
  /** Largest and mean gap between the wall nodes and the surface, as fractions of the body length. */
  wallFit?: { max: number; mean: number; nodes: number };
  /** The first node row actually achieved, from the distance of the layer's first nodes (m). */
  firstLayer?: { requested: number; achieved: number; yPlus: number };
  removedTetrahedra: number;
  seconds: number;
  log: string[];
  warnings: string[];
}

export interface WindTunnelResult {
  model: MdpaModel;
  report: WindTunnelReport;
  files: { mesh: string; body: string; sdfBody?: string; recipe: string };
}

class Cancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

function writeStl(file: string, model: MdpaModel): void {
  fs.writeFileSync(file, writeMeshFile(triangleSurfaceOf(model).surface, ".stl"));
}

const nodeIndex = (m: MdpaModel): Map<number, number> => new Map(Array.from(m.nodeIds, (id, i) => [id, i]));

/** Gap between the wall nodes and the surface, from the distance field the last distance step left. */
function wallFit(model: MdpaModel, bodyName: string, field: string, length: number): WindTunnelReport["wallFit"] | undefined {
  const body = model.subModelParts.find((p) => p.name === bodyName);
  const d = model.fields.find((f) => f.kind === "Nodal" && f.variable === field);
  if (!body || !d) return undefined;
  const row = new Map<number, number>();
  for (let i = 0; i < d.ids.length; i++) row.set(d.ids[i], i);
  let max = 0;
  let sum = 0;
  let n = 0;
  for (const id of body.nodeIds) {
    const r = row.get(id);
    if (r === undefined) continue;
    const v = Math.abs(d.values[r]);
    if (Number.isFinite(v)) {
      max = Math.max(max, v);
      sum += v;
      n++;
    }
  }
  return n === 0 ? undefined : { max: max / length, mean: sum / n / length, nodes: n };
}

/** The distance of the first node row off the wall: the 5th percentile of the non-wall nodes' distance in the layer. */
function firstRow(model: MdpaModel, field: string, requested: number): number | undefined {
  const d = model.fields.find((f) => f.kind === "Nodal" && f.variable === field);
  if (!d) return undefined;
  const near = Array.from(d.values, Math.abs).filter((v) => v > 0.35 * requested && v < 10 * requested).sort((a, b) => a - b);
  if (near.length < 10) return undefined;
  return near[Math.floor(near.length * 0.05)];
}

export async function runWindTunnel(plan: WindTunnelPlan, opts: WindTunnelRunOptions): Promise<WindTunnelResult> {
  if (plan.errors.length > 0) throw new Error(`The plan cannot run:\n- ${plan.errors.join("\n- ")}`);
  const started = Date.now();
  const log: string[] = [];
  const warnings = [...plan.warnings];
  const apply = opts.applyOp ?? applyOpAsync;
  const stem = opts.stem ?? "tunnel";
  fs.mkdirSync(opts.folder, { recursive: true });
  const files = {
    mesh: path.join(opts.folder, `${stem}.mdpa`),
    body: path.join(opts.folder, `${stem}_body.stl`),
    sdfBody: undefined as string | undefined,
    recipe: path.join(opts.folder, `${stem}.kratosvwt.json`),
  };
  const total = plan.steps.length;
  let stepIndex = 0;
  const say = (id: string, label: string, message?: string): void => {
    if (opts.signal?.aborted) throw new Cancelled();
    opts.onProgress?.({ stepIndex, steps: total, id, label, message });
  };

  let model: MdpaModel | undefined;
  let sdfPath = files.body;
  let removedTetrahedra = 0;
  const L = plan.body.size[0];

  const run = async (rec: OpRecord, step: { id: string; label: string }): Promise<void> => {
    const withPath = (rec as { path?: string }).path === "<body>" ? ({ ...rec, path: sdfPath } as OpRecord) : rec;
    const out = await apply(model!, withPath, { signal: opts.signal, onProgress: (m) => say(step.id, step.label, m) });
    if (opts.signal?.aborted) throw new Cancelled();
    if (out.noop) throw new Error(`${step.label}: ${out.message ?? "the operation changed nothing"}`);
    model = out.model;
    if (out.message) log.push(`${step.label}: ${out.message}`);
  };

  for (const step of plan.steps) {
    say(step.id, step.label);
    switch (step.id) {
      case "body": {
        writeStl(files.body, plan.placed);
        const triangles = plan.body.triangles;
        const limit = plan.params.mesh?.sdfMaxTriangles ?? 300_000;
        if (triangles > limit) {
          const surface = triangleSurfaceOf(plan.placed).surface;
          const r = await decimateModel(surface, { targetFaces: limit, preserveFeatures: true, featureAngle: 30 });
          files.sdfBody = path.join(opts.folder, `${stem}_sdf.stl`);
          writeStl(files.sdfBody, r.model);
          sdfPath = files.sdfBody;
          warnings.push(`The body has ${triangles.toLocaleString("en-US")} triangles; the distance is sampled against a copy simplified to ${r.facesAfter.toLocaleString("en-US")} .`);
        }
        break;
      }
      case "lattice": {
        const d = plan.domain;
        const s = plan.sizes;
        const L3 = plan.body.size;
        const focus = (lo: number, hi: number, pad: number): [number, number] => [lo - pad, hi + pad];
        const [fx0, fx1] = focus(d.bodyMin[0], d.bodyMax[0] + Math.max(0, (plan.params.mesh?.wakeLength ?? 2)) * L3[0] * 0.5, 0.1 * L3[0]);
        const [fy0, fy1] = focus(d.bodyMin[1], d.bodyMax[1], 0.1 * L3[1]);
        const [fz0, fz1] = focus(d.bodyMin[2], d.bodyMax[2], 0.1 * L3[2]);
        const axis = (min: number, max: number, a: number, b: number) =>
          gradedAxis({ min, max, focusMin: Math.max(a, min), focusMax: Math.min(b, max), fine: s.core, coarse: s.far, growth: 1.25 });
        model = buildTunnelBackground(axis(d.min[0], d.max[0], fx0, fx1), axis(d.min[1], d.max[1], fy0, fy1), axis(d.min[2], d.max[2], fz0, fz1), {
          names: d.halfModel ? { sideLow: "Symmetry" } : undefined,
        });
        log.push(`Lattice: ${model.nodeCount.toLocaleString("en-US")} nodes.`);
        break;
      }
      case "tidy": {
        const f = finishCarvedMesh(model!);
        model = f.model;
        removedTetrahedra = f.removedTetrahedra;
        log.push(...f.messages, `Dropped ${f.removedTetrahedra.toLocaleString("en-US")} tetrahedra inside the body.`);
        break;
      }
      case "check":
      case "write":
        break;
      default:
        for (const rec of step.ops ?? []) await run(rec, step);
    }
    stepIndex++;
  }

  // A fresh distance on the final mesh: the one the wall remesh carried over is only interpolated.
  if (plan.mode === "bodyFitted") {
    say("check", "Measure the wall");
    await run({ op: "sdfDistance", path: sdfPath, sign: "winding", output: "d" } as OpRecord, { id: "check", label: "Measure the wall" });
  }
  const lastDistance = plan.mode === "embedded" ? "DISTANCE" : "d";
  const fit = plan.mode === "bodyFitted" ? wallFit(model!, "Body", lastDistance, L) : undefined;
  const achieved = plan.mode === "bodyFitted" ? firstRow(model!, lastDistance, plan.wall.firstHeight) : undefined;
  // The carried distance is a working field, not part of the result.
  if (plan.mode === "bodyFitted") model = { ...model!, fields: model!.fields.filter((f) => f.variable !== "d") };
  else model = { ...model!, fields: model!.fields.filter((f) => f.variable !== "d") };
  say("check", "Check the mesh");
  const check = checkFluidMesh(model!);
  if (check.problems.length > 0) warnings.push(`Mesh check: ${check.problems.join("; ")}.`);
  if (fit && fit.max * L > 0.5 * plan.sizes.surface) {
    warnings.push(`The wall lies up to ${(fit.max * L).toPrecision(2)} m (${(fit.max * 100).toFixed(2)}% of the body length) from the surface, more than half the surface size: lower the surface size or the fit.`);
  }

  say("write", "Write the mesh and the recipe");
  fs.writeFileSync(files.mesh, writeMeshFile(model!, ".mdpa"));
  const report: WindTunnelReport = {
    version: WIND_TUNNEL_VERSION,
    mode: plan.mode,
    tetrahedra: check.tetrahedra,
    nodes: check.nodes,
    estimate: { expectedTetrahedra: plan.estimate.expectedTetrahedra, ratio: check.tetrahedra / Math.max(1, plan.estimate.expectedTetrahedra) },
    check,
    wallFit: fit,
    firstLayer:
      achieved !== undefined
        ? {
            requested: plan.wall.firstHeight,
            achieved,
            yPlus: yPlusAt({ speed: plan.flow.speed, density: plan.flow.density, viscosity: plan.flow.viscosity }, L, achieved),
          }
        : undefined,
    removedTetrahedra,
    seconds: (Date.now() - started) / 1000,
    log,
    warnings,
  };
  fs.writeFileSync(
    files.recipe,
    JSON.stringify({ version: WIND_TUNNEL_VERSION, params: plan.params, report, files: { mesh: path.basename(files.mesh), body: path.basename(files.body) } }, null, 2) + "\n"
  );
  stepIndex = total;
  opts.onProgress?.({ stepIndex, steps: total, id: "done", label: "Done" });
  void nodeIndex;
  return { model: model!, report, files };
}

export { Cancelled as WindTunnelCancelled };
