/**
 * The meshio++ 18.1.0 in-place operations: `untangle`, `morph`, `registerRigid`
 * (coordinate-only) and `geodesicDistance`, `laplacianEigenmodes`,
 * `convertCoordinates`, `prepareMetric` (they attach ordinary Nodal fields).
 *
 * Pure module (no vscode / DOM). ORACLES in the smoothMesh.ts sense: the kernel
 * computes something whose shape survives losslessly (moved points, one value
 * per existing node, a 4x4 matrix) and it is applied onto OUR model; meshio++'s
 * returned mesh is never adopted, so node and entity ids, blocks, Properties,
 * SubModelParts and every other field keep their identity.
 *
 * One module for seven small operations: each is a record `{op, ...options}`
 * validated by the `SPECS` table (the parse used by the webview/MCP and the
 * recipe loader is the same code), with its own `apply` below.
 */

import type { FieldData, MdpaDiagnostic, MdpaModel } from "./types";
import { modelToMeshio, MeshioMesh } from "./meshioConvert";
import { loadMeshio } from "./meshio";
import { attachNodalField, expectCount } from "./meshioAdapter";
import { meshioDataToNumbers, MeshioDataArray } from "./meshioConvert";

const flat1 = (a: unknown): ArrayLike<number> => (a ? meshioDataToNumbers(a as MeshioDataArray) : new Float64Array(0));
import { findSubModelPart } from "./subModelPartExtract";
import { movedModel, partNodeIds } from "./deform";
import { invertedCells, describeInverted } from "./cellInversion";
import { cellCategory } from "./writers/writerCommon";
import { isValidFieldName } from "./fieldManage";

export const OPS_181 = ["untangle", "morph", "registerRigid", "geodesicDistance", "laplacianEigenmodes", "convertCoordinates", "prepareMetric"] as const;
export type Op181Name = (typeof OPS_181)[number];

export const is181Op = (op: unknown): op is Op181Name => (OPS_181 as readonly unknown[]).includes(op);

/** The record of any of the seven: `{op}` plus the options its spec lists (all optional unless required). */
export type Op181Record = { op: Op181Name } & Record<string, unknown>;

type KeyKind = "num" | "pos" | "int" | "bool" | "str" | "name" | "nums3" | "strs" | "ids" | { enum: readonly string[] };
interface Spec { keys: Record<string, KeyKind>; required?: string[] }

const SPECS: Record<Op181Name, Spec> = {
  untangle: { keys: { fixBoundary: "bool", frozenPart: "str", rings: "int", smooth: "bool", maxSweeps: "int" } },
  morph: { keys: { variable: "name", fixBoundary: "bool", constrainedPart: "str", stiffening: "num", steps: "int", allowInverted: "bool", tolerance: "pos", maxIterations: "int" }, required: ["variable"] },
  registerRigid: { keys: { path: "str", method: { enum: ["point_to_point", "point_to_plane"] }, maxIterations: "int", tolerance: "pos", maxDistance: "pos", part: "str", autoInit: "bool", symmetricCheck: "bool", symmetricTolerance: "pos", adaptiveTrim: "pos" }, required: ["path"] },
  geodesicDistance: { keys: { sourceNodes: "ids", sourcePart: "str", timeFactor: "pos", tolerance: "pos", maxIterations: "int", output: "name" } },
  laplacianEigenmodes: { keys: { numModes: "int", tolerance: "pos", maxIterations: "int", output: "name" } },
  convertCoordinates: { keys: { system: { enum: ["cylindrical", "spherical"] }, axis: "nums3", origin: "nums3", reference: "nums3", arrays: "strs", inverse: "bool", recordCoordinates: "bool" }, required: ["arrays"] },
  prepareMetric: { keys: { arrays: "strs", output: "name", targetVertices: "pos", norm: "pos", hmin: "pos", hmax: "pos", gradation: "pos", maxSweeps: "int" }, required: ["arrays"] },
};

const asList = (v: unknown): unknown[] | undefined =>
  Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,;]+/).filter(Boolean) : undefined;

/** Coerces one value by its kind; `undefined` means refused. */
function coerce(kind: KeyKind, v: unknown): unknown {
  if (typeof kind === "object") return typeof v === "string" && kind.enum.includes(v) ? v : undefined;
  switch (kind) {
    case "bool": return typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : undefined;
    case "num": { const x = Number(v); return Number.isFinite(x) ? x : undefined; }
    case "pos": { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : undefined; }
    case "int": { const x = Number(v); return Number.isInteger(x) && x >= 0 ? x : undefined; }
    case "str": return typeof v === "string" && v.trim() ? v.trim() : undefined;
    case "name": return typeof v === "string" && isValidFieldName(v.trim()) ? v.trim() : undefined;
    case "nums3": { const l = asList(v)?.map(Number); return l && l.length === 3 && l.every(Number.isFinite) ? l : undefined; }
    case "strs": { const l = asList(v)?.map(String); return l && l.length > 0 && l.every((s) => isValidFieldName(s)) ? l : undefined; }
    case "ids": { const l = asList(v)?.map(Number); return l && l.length > 0 && l.every((x) => Number.isInteger(x) && x > 0) ? l : undefined; }
  }
}

/** Builds a validated record from a raw message / recipe entry, or undefined when any given value is invalid. */
export function parse181(op: Op181Name, msg: Record<string, unknown>): Op181Record | undefined {
  const spec = SPECS[op];
  const rec: Op181Record = { op };
  for (const [key, kind] of Object.entries(spec.keys)) {
    const raw = msg[key];
    if (raw === undefined || raw === null || raw === "") continue;
    const v = coerce(kind, raw);
    if (v === undefined) return undefined;
    rec[key] = v;
  }
  for (const r of spec.required ?? []) if (rec[r] === undefined) return undefined;
  if (op === "geodesicDistance" && rec.sourceNodes === undefined && rec.sourcePart === undefined) return undefined;
  return rec;
}

export interface Op181Outcome { model: MdpaModel; noop?: boolean; message: string }
const noop = (model: MdpaModel, message: string): Op181Outcome => ({ model, noop: true, message });
const g = (x: number) => (Number.isFinite(x) ? String(+x.toPrecision(4)) : "n/a");

/** A mesh the kernel can take with only what the operation needs on it. */
function bare(model: MdpaModel, diagnostics: MdpaDiagnostic[], pointData: Record<string, { data: ArrayLike<number>; width: number }> = {}): MeshioMesh {
  const mesh = modelToMeshio(model, diagnostics, { dim: 3 });
  mesh.point_data = Object.fromEntries(Object.entries(pointData).map(([k, v]) => [k, Float64Array.from(v.data)])) as unknown as MeshioMesh["point_data"];
  mesh.point_data_components = Object.fromEntries(Object.entries(pointData).filter(([, v]) => v.width > 1).map(([k, v]) => [k, v.width]));
  mesh.cell_data = {};
  mesh.cell_data_components = {};
  mesh.regions = [];
  return mesh;
}

/** True when every surface block is a linear triangle one and there is at least one (lines and points ride along). */
function trianglesOnly(model: MdpaModel): boolean {
  const surf = model.blocks.filter((b) => b.count > 0 && cellCategory(b.vtkCellType) === "surface");
  return surf.length > 0 && surf.every((b) => b.vtkCellType === 5) && !model.blocks.some((b) => b.count > 0 && cellCategory(b.vtkCellType) === "volume");
}

const nodeIndexOf = (model: MdpaModel): Map<number, number> => new Map(Array.from(model.nodeIds, (id, i) => [id, i] as [number, number]));

/** 0-based indices of the nodes of a SubModelPart subtree, or a failure sentence. */
function partIndices(model: MdpaModel, path: string, what: string): number[] | string {
  const part = findSubModelPart(model, path);
  if (!part) return `SubModelPart "${path}" (${what}) was not found.`;
  const idx = nodeIndexOf(model);
  return [...partNodeIds(part)].map((id) => idx.get(id)).filter((i): i is number => i !== undefined);
}

/** A Nodal field's `width`-component rows in nodeIds order (0 where it has no record); `uncovered` counts those. */
function nodalRows(model: MdpaModel, f: FieldData, width: number): { data: Float64Array; uncovered: number } {
  const at = nodeIndexOf(model);
  const data = new Float64Array(model.nodeCount * width);
  let seen = 0;
  for (let r = 0; r < f.ids.length; r++) {
    const i = at.get(f.ids[r]);
    if (i === undefined) continue;
    seen++;
    for (let k = 0; k < Math.min(width, f.components); k++) data[i * width + k] = f.values[r * f.components + k];
  }
  return { data, uncovered: model.nodeCount - seen };
}

/** Fields written by an op: one value per kernel point, NaN a gap. */
function writeNodal(model: MdpaModel, variable: string, width: number, raw: ArrayLike<number | bigint> | undefined): { model: MdpaModel; gaps: number } | undefined {
  if (!raw) return undefined;
  const flat = flat1(raw);
  expectCount(variable, "node", flat.length / width, model.nodeCount);
  const ids: number[] = [];
  const values: number[] = [];
  let gaps = 0;
  for (let i = 0; i < model.nodeCount; i++) {
    let ok = true;
    for (let k = 0; k < width; k++) if (!Number.isFinite(flat[i * width + k])) ok = false;
    if (!ok) { gaps++; continue; }
    ids.push(model.nodeIds[i]);
    for (let k = 0; k < width; k++) values.push(flat[i * width + k]);
  }
  if (ids.length === 0) return undefined;
  return { model: attachNodalField(model, { variable, components: width, ids: Int32Array.from(ids), values: Float64Array.from(values) }).model, gaps };
}

/** Rotates the 3- and 9-component fields of the model by the 3x3 `R` (row-major); reports the widths it cannot rotate. */
function rotateFields(model: MdpaModel, R: number[]): { fields: FieldData[]; rotated: string[]; skipped: string[] } {
  const rotated: string[] = [];
  const skipped: string[] = [];
  const fields = model.fields.map((f) => {
    if (f.components !== 3 && f.components !== 9) {
      if (f.components > 1) skipped.push(f.variable);
      return f;
    }
    const values = Float64Array.from(f.values);
    for (let r = 0; r < f.ids.length; r++) {
      const o = r * f.components;
      if (f.components === 3) {
        const v = [values[o], values[o + 1], values[o + 2]];
        for (let i = 0; i < 3; i++) values[o + i] = R[i * 3] * v[0] + R[i * 3 + 1] * v[1] + R[i * 3 + 2] * v[2];
      } else {
        const A = Array.from(values.subarray(o, o + 9));
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
          let s = 0;
          for (let k = 0; k < 3; k++) for (let l = 0; l < 3; l++) s += R[i * 3 + k] * A[k * 3 + l] * R[j * 3 + l];
          values[o + i * 3 + j] = s;
        }
      }
    }
    rotated.push(f.variable);
    return { ...f, values };
  });
  return { fields, rotated, skipped };
}

/** Everything the second mesh of `registerRigid` needs from the caller (a file read stays out of this pure module). */
export interface Op181Deps { loadTarget?: (path: string) => Promise<MdpaModel> }

export async function apply181(model: MdpaModel, rec: Op181Record, deps: Op181Deps = {}, diagnostics: MdpaDiagnostic[] = []): Promise<Op181Outcome> {
  if (model.nodeCount === 0) return noop(model, "The mesh has no nodes.");
  try {
    return await run181(model, rec, deps, diagnostics);
  } catch (err) {
    // The kernel names what it refuses (a mesh with no tetrahedron, an array of the wrong width, …).
    return noop(model, `${rec.op}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function run181(model: MdpaModel, rec: Op181Record, deps: Op181Deps, diagnostics: MdpaDiagnostic[]): Promise<Op181Outcome> {
  const m = await loadMeshio();
  switch (rec.op) {
    case "untangle": {
      const options: Record<string, unknown> = {};
      for (const k of ["fixBoundary", "rings", "smooth", "maxSweeps"]) if (rec[k] !== undefined) options[k] = rec[k];
      if (typeof rec.frozenPart === "string") {
        const idx = partIndices(model, rec.frozenPart, "the nodes to hold fixed");
        if (typeof idx === "string") return noop(model, idx);
        options.frozen = Int32Array.from(idx);
      }
      const r = m.untangle(bare(model, diagnostics), options);
      expectCount("untangle", "node", Math.floor(r.mesh.points.length / 3), model.nodeCount);
      if (r.moves === 0 && r.numInvertedBefore === 0) return noop(model, "No tetrahedron or hexahedron has an inverted corner; nothing was moved.");
      const next = movedModel(model, r.mesh.points);
      const tail = r.numInvertedAfter > 0 ? ` ${r.numInvertedAfter} corner(s) are still inverted (a frozen or boundary node may be what blocks them).` : "";
      return { model: next, message: `Untangled: ${r.numInvertedBefore} → ${r.numInvertedAfter} inverted element(s), worst quality ${g(r.minQualityBefore)} → ${g(r.minQualityAfter)}, ${r.moves} move(s) in ${r.sweeps} sweep(s). Connectivity, ids and fields are unchanged.${tail}` };
    }
    case "morph": {
      const f = model.fields.find((x) => x.kind === "Nodal" && x.variable === rec.variable);
      if (!f) return noop(model, `No nodal field named "${rec.variable}".`);
      if (f.components < 2 || f.components > 3) return noop(model, `"${rec.variable}" has ${f.components} component(s); a displacement needs 2 or 3.`);
      const d = nodalRows(model, f, 3);
      const options: Record<string, unknown> = { array: "morph_d" };
      for (const k of ["fixBoundary", "stiffening", "steps", "allowInverted", "tolerance", "maxIterations"]) if (rec[k] !== undefined) options[k] = rec[k];
      if (typeof rec.constrainedPart === "string") {
        const idx = partIndices(model, rec.constrainedPart, "the nodes that follow the displacement");
        if (typeof idx === "string") return noop(model, idx);
        options.constrained = Int32Array.from(idx);
      }
      const r = m.morph(bare(model, diagnostics, { morph_d: { data: d.data, width: 3 } }), options) as unknown as {
        mesh: MeshioMesh; numConstrained: number; numFree: number; numInverted: number; iterations: number; maxDisplacement: number; converged: boolean;
      };
      expectCount("morph", "node", Math.floor(r.mesh.points.length / 3), model.nodeCount);
      if (r.numConstrained === 0) return noop(model, "No node is constrained, so nothing drives the morph (the boundary is free and no part was named).");
      const next = movedModel(model, r.mesh.points);
      const inv = describeInverted(invertedCells(model, next));
      return { model: next, message: `Morphed: ${r.numConstrained} constrained / ${r.numFree} free node(s), max displacement ${g(r.maxDisplacement)}, ${r.iterations} iteration(s)${r.converged ? "" : " (NOT converged)"}.${d.uncovered > 0 ? ` ${d.uncovered} node(s) without a value in "${rec.variable}" were driven by 0.` : ""}${inv ? ` ${inv}` : ""}` };
    }
    case "registerRigid": {
      if (!deps.loadTarget) return noop(model, "Reading the target mesh needs the file reader, which this runner does not have.");
      let target: MdpaModel;
      try { target = await deps.loadTarget(String(rec.path)); } catch (err) { return noop(model, `Could not read "${rec.path}": ${err instanceof Error ? err.message : String(err)}`); }
      let moving: number[] | undefined;
      if (typeof rec.part === "string") {
        const idx = partIndices(model, rec.part, "the nodes to register");
        if (typeof idx === "string") return noop(model, idx);
        moving = idx;
      }
      const sourcePoints = new Float64Array((moving ?? Array.from({ length: model.nodeCount }, (_, i) => i)).length * 3);
      (moving ?? Array.from({ length: model.nodeCount }, (_, i) => i)).forEach((n, j) => { for (let k = 0; k < 3; k++) sourcePoints[j * 3 + k] = model.coords[n * 3 + k]; });
      const source = { dim: 3, points: sourcePoints, cells: [], point_data: {}, cell_data: {}, field_data: {} } as unknown as MeshioMesh;
      const options: Record<string, unknown> = {};
      for (const k of ["method", "maxIterations", "tolerance", "maxDistance", "symmetricCheck", "symmetricTolerance", "adaptiveTrim"]) if (rec[k] !== undefined) options[k] = rec[k];
      // meshio++ 20.0.0: the best of 24 principal-frame starts instead of the identity.
      if (rec.autoInit === true) options.initial = "auto";
      const r = m.registerRigid(source, modelToMeshio(target, diagnostics, { dim: 3 }), options);
      if (r.numPairs === 0) return noop(model, "No source point found a partner on the target, so there is no transform to apply.");
      const T = r.matrix;
      const coords = new Float32Array(model.coords);
      const moveSet = moving ? new Set(moving) : undefined;
      for (let i = 0; i < model.nodeCount; i++) {
        if (moveSet && !moveSet.has(i)) continue;
        const x = model.coords[i * 3], y = model.coords[i * 3 + 1], z = model.coords[i * 3 + 2];
        for (let a = 0; a < 3; a++) coords[i * 3 + a] = T[a * 4] * x + T[a * 4 + 1] * y + T[a * 4 + 2] * z + T[a * 4 + 3];
      }
      const base = movedModel(model, coords);
      // A rigid motion of the WHOLE mesh turns its vectors and tensors with it; a partial one cannot say which rows to turn.
      let note = "";
      let next = base;
      if (!moving) {
        const rot = rotateFields(base, [T[0], T[1], T[2], T[4], T[5], T[6], T[8], T[9], T[10]]);
        next = { ...base, fields: rot.fields };
        note = (rot.rotated.length ? ` Rotated ${rot.rotated.join(", ")} with the mesh.` : "") + (rot.skipped.length ? ` Not rotated (width is neither 3 nor 9): ${rot.skipped.join(", ")}.` : "");
      } else note = " Vector and tensor fields were left as they are (only part of the mesh moved).";
      return { model: next, message: `Registered rigidly: rms ${g(r.initialRms)} → ${g(r.rms)} over ${r.numPairs} pair(s), ${r.iterations} iteration(s)${r.converged ? "" : " (NOT converged)"}. Matrix ${T.map(g).join(" ")}.${(r.numRejected ?? 0) > 0 ? ` ${r.numRejected} pair(s) rejected by the trim.` : ""}${rec.autoInit === true ? ` Start ${r.chosenCandidate} of ${r.candidateRms?.length ?? 24} principal-frame candidates.` : ""}${r.warnings?.length ? ` ${r.warnings.join(" ")}` : ""}${note}` };
    }
    case "geodesicDistance": {
      const surfaceOnly = trianglesOnly(model);
      if (!surfaceOnly) return noop(model, "Geodesic distance needs a linear triangle surface (use Simplexify / Quadratic → Linear, or export the skin of a solid first).");
      const idx = nodeIndexOf(model);
      const sources = new Set<number>();
      const missing: number[] = [];
      for (const id of (rec.sourceNodes as number[] | undefined) ?? []) { const i = idx.get(id); if (i === undefined) missing.push(id); else sources.add(i); }
      if (typeof rec.sourcePart === "string") {
        const p = partIndices(model, rec.sourcePart, "the source nodes");
        if (typeof p === "string") return noop(model, p);
        p.forEach((i) => sources.add(i));
      }
      if (sources.size === 0) return noop(model, `No source node was found${missing.length ? ` (ids ${missing.slice(0, 5).join(", ")} are not in the mesh)` : ""}.`);
      const options: Record<string, unknown> = {};
      for (const k of ["timeFactor", "tolerance", "maxIterations"]) if (rec[k] !== undefined) options[k] = rec[k];
      const r = m.geodesicDistance(bare(model, diagnostics), Int32Array.from(sources), options);
      const variable = typeof rec.output === "string" ? rec.output : "GEODESIC_DISTANCE";
      const w = writeNodal(model, variable, 1, r.mesh.point_data?.["geodesic:distance"] as never);
      if (!w) return noop(model, "The distance is undefined everywhere (no triangle reaches a source).");
      return { model: w.model, message: `Wrote ${variable}: geodesic distance from ${sources.size} source(s), max ${g(r.maxDistance)}${r.converged ? "" : " (NOT converged)"}.${r.numUnreached > 0 || w.gaps > 0 ? ` ${Math.max(r.numUnreached, w.gaps)} node(s) are unreachable and are gaps, not zeros.` : ""}${missing.length ? ` ${missing.length} source id(s) are not in the mesh.` : ""}` };
    }
    case "laplacianEigenmodes": {
      const surfaceOnly = trianglesOnly(model);
      if (!surfaceOnly) return noop(model, "Laplace-Beltrami modes need a linear triangle surface.");
      const k = typeof rec.numModes === "number" && rec.numModes > 0 ? rec.numModes : 6;
      const options: Record<string, unknown> = { numModes: k };
      for (const key of ["tolerance", "maxIterations"]) if (rec[key] !== undefined) options[key] = rec[key];
      const r = m.laplacianEigenmodes(bare(model, diagnostics), options);
      const flat = flat1(r.mesh.point_data?.["laplacian:modes"]);
      const modes = r.eigenvalues.length;
      if (modes === 0 || flat.length !== modes * model.nodeCount) return noop(model, "The kernel returned no modes of the expected shape; the result was discarded.");
      const prefix = typeof rec.output === "string" ? rec.output : "LAPLACE_MODE";
      let out = model;
      for (let j = 0; j < modes; j++) {
        const col = new Float64Array(model.nodeCount);
        for (let i = 0; i < model.nodeCount; i++) col[i] = flat[i * modes + j];
        out = attachNodalField(out, { variable: `${prefix}_${j}`, components: 1, ids: Int32Array.from(model.nodeIds), values: col }).model;
      }
      return { model: out, message: `Wrote ${prefix}_0…${prefix}_${modes - 1}: eigenvalues ${r.eigenvalues.map(g).join(", ")}${r.converged ? "" : " (NOT converged)"}. Mode 0 is the constant; the modes are mass-orthonormal.` };
    }
    case "convertCoordinates": {
      const names = rec.arrays as string[];
      const pd: Record<string, { data: Float64Array; width: number }> = {};
      for (const name of names) {
        const f = model.fields.find((x) => x.kind === "Nodal" && x.variable === name);
        if (!f) return noop(model, `No nodal field named "${name}".`);
        if (f.components !== 3 && f.components !== 9) return noop(model, `"${name}" has ${f.components} component(s); only 3-D vectors (3) and tensors (9) can be converted.`);
        pd[name] = { data: nodalRows(model, f, f.components).data, width: f.components };
      }
      const options: Record<string, unknown> = { arrays: names, recordCoordinates: rec.recordCoordinates ?? true };
      for (const key of ["system", "axis", "origin", "reference", "inverse"]) if (rec[key] !== undefined) options[key] = rec[key];
      const system = (rec.system as string | undefined) ?? "cylindrical";
      const r = m.convertCoordinates(bare(model, diagnostics, pd), options);
      let out = model;
      const wrote: string[] = [];
      if (options.recordCoordinates) {
        const w = writeNodal(out, system === "spherical" ? "COORDS_SPHERICAL" : "COORDS_CYLINDRICAL", 3, r.mesh.point_data?.[`coords:${system}`] as never);
        if (w) { out = w.model; wrote.push(system === "spherical" ? "COORDS_SPHERICAL" : "COORDS_CYLINDRICAL"); }
      }
      // New names: the Cartesian originals are kept, so the conversion is never destructive.
      const suffix = rec.inverse ? "_CART" : system === "spherical" ? "_SPH" : "_CYL";
      for (const name of names) {
        const w = writeNodal(out, `${name}${suffix}`, pd[name].width, r.mesh.point_data?.[name] as never);
        if (w) { out = w.model; wrote.push(`${name}${suffix}`); }
      }
      if (wrote.length === 0) return noop(model, "The kernel produced no field.");
      return { model: out, message: `Wrote ${wrote.join(", ")} (${system}${rec.inverse ? ", back to Cartesian" : ""}); the original fields are kept.${r.numSingular > 0 ? ` ${r.numSingular} point(s) on the axis have no defined local basis.` : ""}` };
    }
    case "prepareMetric": {
      const names = rec.arrays as string[];
      const is3 = model.is3D;
      const width = is3 ? 6 : 3;
      const pd: Record<string, { data: Float64Array; width: number }> = {};
      for (const name of names) {
        const f = model.fields.find((x) => x.kind === "Nodal" && x.variable === name);
        if (!f) return noop(model, `No nodal field named "${name}".`);
        if (f.components !== width) return noop(model, `"${name}" has ${f.components} component(s); a metric of this ${is3 ? "3-D" : "2-D"} mesh has ${width}.`);
        pd[name] = { data: nodalRows(model, f, width).data, width };
      }
      const mesh = modelToMeshio(model, diagnostics, { dim: is3 ? 3 : 2 });
      mesh.point_data = Object.fromEntries(Object.entries(pd).map(([k, v]) => [k, v.data])) as unknown as MeshioMesh["point_data"];
      mesh.point_data_components = Object.fromEntries(Object.keys(pd).map((k) => [k, width]));
      mesh.cell_data = {}; mesh.cell_data_components = {}; mesh.regions = [];
      const output = typeof rec.output === "string" ? rec.output : "METRIC";
      const options: Record<string, unknown> = { arrays: names, output };
      for (const k of ["targetVertices", "norm", "hmin", "hmax", "gradation", "maxSweeps"]) if (rec[k] !== undefined) options[k] = rec[k];
      const r = m.prepareMetric(mesh, options);
      const w = writeNodal(model, output, width, r.mesh.point_data?.[output] as never);
      if (!w) return noop(model, "The kernel produced no metric.");
      return { model: w.model, message: `Wrote ${output}: complexity ${g(r.complexityBefore)} → ${g(r.complexityAfter)}, ${r.numGraded} node(s) graded in ${r.sweeps} sweep(s). Feed it to an MMG adapt (mesh_derive adapt) as the metric.` };
    }
  }
}
