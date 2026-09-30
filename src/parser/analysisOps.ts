import { MESHIO_ID_KEY, MESHIO_KIND_KEY } from "./meshioFormats";
/** Shared meshio++ 16.27 analysis adapters. Reports never mutate their input. */
import { loadMeshio } from './meshio';
import { modelToMeshio, meshioToModel } from './meshioConvert';
import type { MdpaModel } from './types';
import { extractSubModelPart } from './subModelPartExtract';

export interface FeatureEdgeOptions {
  featureAngle?: number;
  feature?: boolean;
  boundary?: boolean;
  nonManifold?: boolean;
  inconsistent?: boolean;
}
export async function featureEdges(model: MdpaModel, options: FeatureEdgeOptions = {}) {
  const m = await loadMeshio();
  const angle = options.featureAngle ?? 30;
  if (!Number.isFinite(angle) || angle < 0 || angle > 180) throw new Error('Feature angle must be between 0 and 180 degrees.');
  const report = m.featureEdges(modelToMeshio({ ...model, is3D: true }, []), angle, options.feature ?? true, options.boundary ?? true, options.nonManifold ?? true, options.inconsistent ?? true);
  return { model: meshioToModel(report.mesh, []), counts: { feature: report.numFeature, boundary: report.numBoundary, nonManifold: report.numNonManifold, inconsistent: report.numInconsistent } };
}
export async function qualityGate(model: MdpaModel, require = '', maxInverted = 0, maxDegenerate = 0) {
  if (![maxInverted, maxDegenerate].every(Number.isInteger)) throw new Error('Quality count limits must be integers.');
  const m = await loadMeshio();
  const raw = modelToMeshio({ ...model, is3D: true }, [], { carriers: true });
  const report = m.checkQuality(raw, require, maxInverted, maxDegenerate);
  const ids = raw.cell_data?.[MESHIO_ID_KEY]?.flatMap(a => Array.from(a,Number)) ?? [];
  const kinds = raw.cell_data?.[MESHIO_KIND_KEY]?.flatMap(a => Array.from(a,Number)) ?? [];
  const cells = ids.map((id,i) => ({ id, kind: ["Elements","Conditions","Geometries"][kinds[i]] }));
  return { ...report, checks: report.checks.map(c => ({ ...c, worstEntity: cells[c.worstCell] ?? null })) };
}
export async function hausdorff(model: MdpaModel, other: MdpaModel, faceSamples = 0) {
  if (!Number.isInteger(faceSamples) || faceSamples < 0) throw new Error('faceSamples must be a nonnegative integer.');
  const m = await loadMeshio();
  const r = m.hausdorffDistance(modelToMeshio({ ...model, is3D: true }, []), modelToMeshio({ ...other, is3D: true }, []), faceSamples);
  return { ...r, sampled: true, faceSamples, worstPointA: Array.from(r.worstPointA), worstPointB: Array.from(r.worstPointB) };
}
export interface PeriodicOptions {
  slave: string;
  master: string;
  matrix?: number[];
  translate?: number[];
  rotate?: { axis: number[]; angle: number; center?: number[] };
  atol?: number;
  requireComplete?: boolean;
}
export function periodicMatrix(options: PeriodicOptions): number[] {
  if ([options.matrix, options.translate, options.rotate].filter(Boolean).length !== 1) throw new Error('Specify exactly one of matrix, translate or rotate.');
  if (options.matrix) {
    const a = options.matrix;
    if (a.length !== 16 || !a.every(Number.isFinite) || a[12] !== 0 || a[13] !== 0 || a[14] !== 0 || a[15] !== 1) throw new Error('matrix must be a finite row-major affine 4×4 matrix.');
    return [...a];
  }
  const m = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  if (options.translate) {
    if (options.translate.length !== 3 || !options.translate.every(Number.isFinite)) throw new Error('translate must contain three finite values.');
    options.translate.forEach((v,i) => m[i*4+3] = v);
  } else {
    const { axis, angle, center = [0,0,0] } = options.rotate!;
    if (axis.length !== 3 || center.length !== 3 || ![...axis,...center,angle].every(Number.isFinite) || !Math.hypot(...axis)) throw new Error('Rotation requires a nonzero axis, finite angle and center.');
    const [x,y,z] = axis.map(v => v/Math.hypot(...axis));
    const c = Math.cos(angle*Math.PI/180), s = Math.sin(angle*Math.PI/180), t=1-c;
    const r=[t*x*x+c,t*x*y-s*z,t*x*z+s*y,t*x*y+s*z,t*y*y+c,t*y*z-s*x,t*x*z-s*y,t*y*z+s*x,t*z*z+c];
    for(let i=0;i<3;i++) { for(let j=0;j<3;j++) m[i*4+j]=r[i*3+j]; m[i*4+3]=center[i]-r.slice(i*3,i*3+3).reduce((sum,v,j)=>sum+v*center[j],0); }
  }
  return m;
}
export async function periodicNodes(model: MdpaModel, options: PeriodicOptions) {
  const mesh = modelToMeshio({ ...model, is3D: true }, []);
  const indices = new Map(Array.from(model.nodeIds, (id,i) => [id,i]));
  // SubModelParts may have both point and cell carrier regions. Supply explicit
  // point regions assembled from their actual nodes to avoid ambiguous names.
  mesh.regions = ['slave','master'].map((role,i) => {
    const name = i ? options.master : options.slave;
    const part = extractSubModelPart(model, name);
    if (!part) throw new Error(`SubModelPart "${name}" not found.`);
    return { name: role, kind: 'point' as const, dim: 0, tag: i, entries: Int32Array.from(part.nodeIds, id => indices.get(id)!) };
  });
  const tolerance = options.atol ?? 1e-8;
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('atol must be finite and nonnegative.');
  const m = await loadMeshio();
  const r = m.matchPeriodicNodes(mesh, 'slave', 'master', periodicMatrix(options), tolerance, options.requireComplete ?? true);
  return { pairs: Array.from(r.slave, (index,i) => ({ slave: model.nodeIds[index], master: model.nodeIds[r.master[i]] })), unmatched: Array.from(r.unmatched, i => model.nodeIds[i]), numFixed: r.numFixed, maxResidual: r.maxResidual };
}
