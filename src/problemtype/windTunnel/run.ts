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
import { splitWallByBodies } from "./bodies";
import { invertedCells } from "../../parser/cellInversion";
import { WIND_TUNNEL_VERSION } from "./plan";
import type { WindTunnelPlan } from "./plan";
import { yPlusAt } from "./estimate";
import { windTunnelCase } from "./caseState";
import type { WindTunnelCase } from "./caseState";
import { serializeCase, caseFilePath } from "../caseFile";

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
  /** Per-body wall fits for a multi-body tunnel, in plan order. */
  bodies?: { name: string; wallFit?: { max: number; mean: number; nodes: number } }[];
  /**
   * The Sobolev wall snap: the carve fit before, the fit right after the snap
   * (both as fractions of the body length), the sub-step fraction applied and
   * whether any sub-step was clean. Absent when the plan asks for no snap.
   */
  snap?: { before: number; after: number; fraction: number; applied: boolean };
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
  files: { mesh: string; body: string; sdfBody?: string; recipe: string; caseState: string };
  /** The simulation prepared for the mesh, as written to `caseState`. */
  case: WindTunnelCase;
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
    caseState: caseFilePath(path.join(opts.folder, `${stem}.mdpa`)),
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
  let snap: WindTunnelReport["snap"];
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
      case "snap": {
        // The Sobolev wall snap: project the carved wall onto the surface and
        // keep the largest move that inverts no cell. A size-preserving
        // quality pass comes first (the carve leaves sliver tets at the wall
        // that any move folds), then an exact projection is tried: on a clean
        // mesh the wall lands on the surface with no smoothing at all. When
        // the exact move folds cells, the Body displacement goes through
        // Sobolev smoothing with the far-field and tunnel faces pinned,
        // coarse to fine over up to three passes, and a raw top-up finishes
        // the residual — each step kept only when it inverts nothing,
        // falling back to the carve with a reported gap.
        const dist = (output: string): OpRecord => ({ op: "sdfDistance", path: sdfPath, sign: "winding", output }) as OpRecord;
        const prog = (m: string): void => say(step.id, step.label, m);
        const shrink = (): OpRecord =>
          ({ op: "shrinkwrap", path: sdfPath, movePart: "Body", recordDistance: true, ...(plan.domain.halfModel ? { pinPart: "Symmetry" } : {}) }) as OpRecord;
        const SHRINK_VAR = "SHRINKWRAP_DISTANCE";
        const dropWorking = (m: MdpaModel): MdpaModel => ({
          ...m,
          subModelParts: m.subModelParts.filter((q) => q.name !== "SnapFarField"),
          fields: m.fields.filter((x) => x.variable !== "SNAP_DISPLACEMENT" && x.variable !== SHRINK_VAR),
        });
        const d0 = await apply(model!, dist("d"), { signal: opts.signal, onProgress: prog });
        if (d0.noop) throw new Error(`Snap the wall: ${d0.message ?? "the distance changed nothing"}`);
        model = d0.model;
        const carved = wallFit(model!, "Body", "d", L);
        if (!carved) {
          warnings.push("The wall snap is skipped: no Body wall or distance field to measure the carve fit.");
          break;
        }
        snap = { before: carved.max, after: carved.max, fraction: 0, applied: false };
        const cleanOf = (base: MdpaModel, moved: MdpaModel): boolean => {
          const inv = invertedCells(base, moved);
          return inv.volume === 0 && inv.surface === 0;
        };
        const measure = async (): Promise<number> => {
          const d = await apply(model!, dist("d"), { signal: opts.signal, onProgress: prog });
          if (!d.noop) model = d.model;
          model = { ...model!, fields: model!.fields.filter((x) => x.variable !== SHRINK_VAR) };
          return wallFit(model!, "Body", "d", L)?.max ?? snap!.before;
        };
        // The quality pass: sliver tets at the carved wall fold under any
        // move, so they are optimized away before the projection is tried.
        // The symmetry plane of a half model stays bit-identical: MMG would
        // otherwise slide its nodes off y = 0.
        const frozen = plan.domain.halfModel ? { frozen: [{ kind: "part", target: "Symmetry" } as const] } : {};
        const opt = await apply(
          model!,
          { op: "remesh", mode: "optimize", hmin: +(plan.sizes.surface / 4).toPrecision(4), hmax: +plan.sizes.far.toPrecision(6), hgrad: 1.3, hausd: +plan.sizes.hausd.toPrecision(4), ...frozen } as OpRecord,
          { signal: opts.signal, onProgress: prog }
        );
        if (!opt.noop) {
          model = opt.model;
          log.push("Snap: size-preserving quality pass before the move.");
        } else {
          log.push(`Snap: quality pass skipped (${opt.message ?? "the mesh is already clean"}).`);
        }
        // The exact move: the full projection, no smoothing.
        let sw = await apply(model!, shrink(), { signal: opts.signal, onProgress: prog });
        if (!sw.noop && cleanOf(model!, sw.model)) {
          model = dropWorking(sw.model);
          snap = { before: carved.max, after: await measure(), fraction: 1, applied: true };
          log.push(`Snap: exact projection applied; wall gap ${(snap.before * 100).toFixed(3)}% → ${(snap.after * 100).toFixed(3)}% of the body length.`);
          break;
        }
        if (!sw.noop) log.push("Snap: the exact projection folds cells — smoothing the displacement instead.");
        // The smoothed moves: the Body displacement through Sobolev
        // smoothing with the far-field and tunnel faces pinned, coarse to
        // fine so the rounding at sharp edges shrinks with the gap.
        const FAR = new Set(["Inlet", "Outlet", "Floor", "Ceiling", "SideLow", "SideHigh", "Symmetry"]);
        const SNAP_VAR = "SNAP_DISPLACEMENT";
        const farIds = new Set<number>();
        for (const q of model!.subModelParts) if (FAR.has(q.name)) for (const id of q.nodeIds) farIds.add(id);
        const farPart = {
          name: "SnapFarField",
          path: "SnapFarField",
          nodeIds: Int32Array.from(farIds),
          elementIds: new Int32Array(),
          conditionIds: new Int32Array(),
          geometryIds: new Int32Array(),
          constraintIds: new Int32Array(),
          children: [],
        };
        for (let pass = 1; pass <= 3; pass++) {
          const lengthScale = [plan.sizes.surface, plan.sizes.surface / 2, plan.sizes.surface / 4][pass - 1];
          // eslint-disable-next-line no-await-in-loop
          sw = await apply(model!, shrink(), { signal: opts.signal, onProgress: prog });
          if (sw.noop) {
            log.push(`Snap pass ${pass}: ${sw.message ?? "the projection changed nothing"}.`);
            break;
          }
          const base: MdpaModel = model!;
          const D = new Float64Array(base.nodeCount * 3);
          let maxD = 0;
          for (let i = 0; i < D.length; i++) {
            D[i] = sw.model.coords[i] - base.coords[i];
            maxD = Math.max(maxD, Math.abs(D[i]));
          }
          if (maxD < 1e-12) break;
          let moved = false;
          for (const f of [1, 0.5, 0.25, 0.125]) {
            const vals = new Float64Array(D.length);
            for (let i = 0; i < D.length; i++) vals[i] = D[i] * f;
            const scaffold: MdpaModel = {
              ...base,
              subModelParts: [...base.subModelParts, farPart],
              fields: [...base.fields, { kind: "Nodal", variable: SNAP_VAR, components: 3, ids: Int32Array.from(base.nodeIds), values: vals }],
            };
            // eslint-disable-next-line no-await-in-loop
            const r = await apply(scaffold, { op: "sobolevDeform", variable: SNAP_VAR, lengthScale, fixedPart: "SnapFarField" } as OpRecord, {
              signal: opts.signal,
              onProgress: prog,
            });
            if (r.noop) {
              log.push(`Snap pass ${pass} sub-step ${f}: ${r.message ?? "no move"}.`);
              continue;
            }
            if (cleanOf(base, r.model)) {
              model = dropWorking(r.model);
              snap = { before: snap!.before, after: snap!.after, fraction: f, applied: true };
              log.push(`Snap pass ${pass}: smoothed sub-step ${f} applied.`);
              moved = true;
              break;
            }
            const inv = invertedCells(base, r.model);
            log.push(`Snap pass ${pass} sub-step ${f}: ${inv.volume} volume and ${inv.surface} surface cells inverted — trying a smaller step.`);
          }
          if (!moved) {
            if (pass === 1 && !snap!.applied) {
              warnings.push(
                `The wall snap is skipped: every sub-step folded cells, so the wall stays at the carve fit (${(carved.max * 100).toFixed(2)}% of the body length). Lower the surface size or the fit.`
              );
            } else {
              warnings.push("The wall snap stopped early: a further pass folds cells; the wall keeps what the clean passes achieved.");
            }
            break;
          }
        }
        // The polish: the residual projection applied raw at the largest
        // clean fraction, so the smoothing rounding does not stand, iterated
        // until the estimated residual is below target or nothing is clean.
        // Raw moves are exact (no rounding); each iteration needs only one
        // projection, and the residual is tracked from the recorded
        // pre-move distances, so no fresh distance run is needed per pass.
        // The smoothed passes stretch cells at the wall, so the quality pass
        // runs again first when they moved anything.
        if (snap!.applied) {
          // eslint-disable-next-line no-await-in-loop
          const opt2 = await apply(
            model!,
            { op: "remesh", mode: "optimize", hmin: +(plan.sizes.surface / 4).toPrecision(4), hmax: +plan.sizes.far.toPrecision(6), hgrad: 1.3, hausd: +plan.sizes.hausd.toPrecision(4), ...frozen } as OpRecord,
            { signal: opts.signal, onProgress: prog }
          );
          if (!opt2.noop) {
            model = opt2.model;
            log.push("Snap: quality pass before the top-up.");
          }
        }
        for (let polish = 1; polish <= 6; polish++) {
          // eslint-disable-next-line no-await-in-loop
          sw = await apply(model!, shrink(), { signal: opts.signal, onProgress: prog });
          if (sw.noop) {
            log.push(`Snap polish ${polish}: ${sw.message ?? "the projection changed nothing"}.`);
            break;
          }
          const base: MdpaModel = model!;
          const D = new Float64Array(base.nodeCount * 3);
          let maxD = 0;
          for (let i = 0; i < D.length; i++) {
            D[i] = sw.model.coords[i] - base.coords[i];
            maxD = Math.max(maxD, Math.abs(D[i]));
          }
          if (maxD < 1e-12) break;
          let moved = false;
          for (const f of [1, 0.5, 0.25, 0.125]) {
            const coords = new Float32Array(base.coords);
            for (let i = 0; i < coords.length; i++) coords[i] += D[i] * f;
            const candidate: MdpaModel = { ...base, coords, bounds: sw.model.bounds };
            if (cleanOf(base, candidate)) {
              model = dropWorking({ ...candidate, fields: candidate.fields.filter((x) => x.variable !== SHRINK_VAR) });
              snap = { before: snap!.before, after: snap!.after, fraction: f, applied: true };
              log.push(`Snap polish ${polish}: raw sub-step ${f} applied (residual about ${(((1 - f) * maxD) / L * 100).toFixed(3)}% of L).`);
              moved = true;
              if ((1 - f) * maxD < 0.002 * L) polish = 7;
              break;
            }
          }
          if (!moved) {
            log.push(`Snap polish ${polish}: no clean raw sub-step; keeping the smoothed result.`);
            break;
          }
        }
        snap = { before: snap!.before, after: await measure(), fraction: snap!.fraction, applied: snap!.applied };
        if (snap.applied) {
          log.push(`Snap: wall gap ${(snap.before * 100).toFixed(3)}% → ${(snap.after * 100).toFixed(3)}% of the body length.`);
        } else {
          log.push(`Snap: no clean sub-step; the wall stays at ${(snap.before * 100).toFixed(3)}% of the body length.`);
        }
        break;
      }
      case "split": {
        // Multi-body only: the merged Body wall becomes one part per body
        // (Body_1…n, matched by nearest centre) plus a Bodies parent holding
        // the whole wall for the RANS wall function.
        if (!plan.bodies) throw new Error("The split step needs bodies.");
        const { model: splitModel, matched, problems } = splitWallByBodies(model!, plan.bodies);
        if (problems.length > 0) throw new Error(`The wall split failed:\n- ${problems.join("\n- ")}`);
        model = splitModel;
        log.push(`Split the wall: ${matched.join(", ")}.`);
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
  // Several bodies: one fit per Body_1…n wall, plus the worst over them.
  const bodiesFit =
    plan.mode === "bodyFitted" && plan.bodies
      ? plan.bodies.map((b, bi) => ({ name: b.name, wallFit: wallFit(model!, `Body_${bi + 1}`, lastDistance, L) }))
      : undefined;
  const fit =
    plan.mode !== "bodyFitted"
      ? undefined
      : bodiesFit !== undefined
        ? {
            max: Math.max(...bodiesFit.map((b) => b.wallFit?.max ?? 0)),
            mean: bodiesFit.reduce((s, b) => s + (b.wallFit?.mean ?? 0) * (b.wallFit?.nodes ?? 0), 0) / Math.max(1, bodiesFit.reduce((s, b) => s + (b.wallFit?.nodes ?? 0), 0)),
            nodes: bodiesFit.reduce((s, b) => s + (b.wallFit?.nodes ?? 0), 0),
          }
        : wallFit(model!, "Body", lastDistance, L);
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
  const prepared = windTunnelCase(plan);
  fs.writeFileSync(files.caseState, serializeCase(prepared.state));
  const report: WindTunnelReport = {
    version: WIND_TUNNEL_VERSION,
    mode: plan.mode,
    tetrahedra: check.tetrahedra,
    nodes: check.nodes,
    estimate: { expectedTetrahedra: plan.estimate.expectedTetrahedra, ratio: check.tetrahedra / Math.max(1, plan.estimate.expectedTetrahedra) },
    check,
    wallFit: fit,
    ...(bodiesFit !== undefined ? { bodies: bodiesFit } : {}),
    ...(snap !== undefined ? { snap } : {}),
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
    JSON.stringify({ version: WIND_TUNNEL_VERSION, params: plan.params, report, caseNotes: prepared.notes, files: { mesh: path.basename(files.mesh), body: path.basename(files.body), caseState: path.basename(files.caseState) } }, null, 2) + "\n"
  );
  stepIndex = total;
  opts.onProgress?.({ stepIndex, steps: total, id: "done", label: "Done" });
  void nodeIndex;
  return { model: model!, report, files, case: prepared };
}

export { Cancelled as WindTunnelCancelled };
