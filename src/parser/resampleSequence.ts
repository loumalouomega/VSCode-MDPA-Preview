/** Bounded, on-demand temporal interpolation with Kratos metadata preserved. */
import type { MdpaModel } from './types';
export interface SequenceSource { times: number[]; load(index: number): Promise<MdpaModel>; }
export interface ResampleOptions {
  times?: number[];
  range?: { start: number; stop: number; step: number };
  method?: 'linear' | 'nearest' | 'previous';
  extrapolate?: 'error' | 'clamp';
  blendPoints?: boolean;
  continuousFields?: string[];
}
export function validateTimes(times: number[], label = 'Source'): void {
  if (!times.length || times.some((t,i) => !Number.isFinite(t) || (i > 0 && t <= times[i-1]))) throw new Error(`${label} times must be finite and strictly increasing.`);
}
export function targetTimes(options: ResampleOptions): number[] {
  if (Boolean(options.times) === Boolean(options.range)) throw new Error('Specify either target times or start/stop/step.');
  let times = options.times ? [...options.times] : [];
  if (options.range) {
    const { start, stop, step } = options.range;
    if (![start,stop,step].every(Number.isFinite) || step <= 0 || stop < start) throw new Error('Range requires finite start ≤ stop and a positive step.');
    const n = Math.floor((stop-start)/step + 1e-10)+1;
    if (n > 1000000) throw new Error('Resampling is limited to one million target times.');
    times = Array.from({length:n}, (_,i) => start+i*step);
    if (Math.abs(times[times.length-1]-stop) <= Math.max(1,Math.abs(stop))*1e-12) times[times.length-1]=stop;
  }
  validateTimes(times, 'Target');
  return times;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function blendModels(a: MdpaModel, b: MdpaModel, weight: number, options: ResampleOptions): MdpaModel {
  if (!same(a.nodeIds,b.nodeIds) || !same(a.blocks,b.blocks)) throw new Error('Cannot interpolate: node IDs or cell topology differ between frames.');
  for (const key of ['subModelParts','properties','constraints','meta','globals'] as const) {
    if (!same(a[key],b[key])) throw new Error(`Cannot interpolate: ${key} differ between frames.`);
  }
  if (a.fields.length !== b.fields.length) throw new Error('Cannot interpolate: field layouts differ between frames.');
  const near = weight <= 0.5 ? a : b;
  const fields = a.fields.map((f,i) => {
    const g = b.fields[i];
    if (f.kind !== g.kind || f.variable !== g.variable || f.components !== g.components || f.numericType !== g.numericType || !same(f.ids,g.ids) || !same(f.fixed,g.fixed) || f.values.length !== g.values.length) throw new Error(`Cannot interpolate: layout or fixity differs for ${f.variable}.`);
    const continuous = f.numericType === 'float' || (f.numericType !== 'integer' && options.continuousFields?.includes(`${f.kind}:${f.variable}`));
    return continuous ? { ...f, values: Float64Array.from(f.values, (v,j) => (1-weight)*v+weight*g.values[j]) } : near.fields[i];
  });
  const coords = options.blendPoints ? Float32Array.from(a.coords, (v,i) => (1-weight)*v+weight*b.coords[i]) : a.coords;
  const min: [number,number,number] = [Infinity,Infinity,Infinity], max: [number,number,number] = [-Infinity,-Infinity,-Infinity];
  for(let i=0;i<coords.length;i++) { const k=i%3; min[k]=Math.min(min[k],coords[i]); max[k]=Math.max(max[k],coords[i]); }
  return { ...a, fields, coords, bounds: { min,max } };
}
export class SequenceResampler {
  readonly times: number[];
  private cache = new Map<number, MdpaModel>();
  constructor(readonly source: SequenceSource, readonly options: ResampleOptions) {
    validateTimes(source.times);
    if (options.method && !['linear','nearest','previous'].includes(options.method)) throw new Error('Unknown resampling method.');
    if (options.extrapolate && !['error','clamp'].includes(options.extrapolate)) throw new Error('Unknown extrapolation policy.');
    this.times = targetTimes(options);
  }
  clear(): void { this.cache.clear(); }
  private async load(index: number): Promise<MdpaModel> {
    const hit = this.cache.get(index); if (hit) return hit;
    // Evict before loading, so the cache never retains a third source frame.
    if (this.cache.size >= 2) this.cache.delete(this.cache.keys().next().value!);
    const frame = await this.source.load(index); this.cache.set(index,frame); return frame;
  }
  async frame(index: number): Promise<MdpaModel> {
    if (!Number.isInteger(index) || index < 0 || index >= this.times.length) throw new Error('Requested resampled frame is unavailable.');
    const times=this.source.times;
    let t=this.times[index];
    if (t<times[0] || t>times[times.length-1]) {
      if (this.options.extrapolate !== 'clamp') throw new Error(`Target time ${t} is outside the source range.`);
      t=Math.max(times[0],Math.min(times[times.length-1],t));
    }
    let hi=times.findIndex(v => v>=t);
    if (times[hi] === t) return this.load(hi);
    const lo=hi-1, w=(t-times[lo])/(times[hi]-times[lo]);
    if (this.options.method === 'previous') return this.load(lo);
    if (this.options.method === 'nearest') return this.load(w<=0.5?lo:hi);
    const a=await this.load(lo), b=await this.load(hi);
    return blendModels(a,b,w,this.options);
  }
}
