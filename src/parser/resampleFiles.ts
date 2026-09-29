import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { discoverSeriesSteps } from './fieldSeriesScan';
import { SequenceResampler, ResampleOptions, SequenceSource, validateTimes } from './resampleSequence';
import { writeMeshFileAsync } from './writers/meshWriter';
export interface ResampleSourceOptions { sourceTimes?: number[]; useStepLabels?: boolean; }
export async function sequenceSource(file: string, options: ResampleSourceOptions = {}): Promise<SequenceSource> {
  const { steps, source } = await discoverSeriesSteps(file);
  if (source === 'single') throw new Error('Resampling requires a sequence with at least two frames.');
  if (source === 'files' && !options.sourceTimes && !options.useStepLabels) throw new Error('Filename sequences require sourceTimes or explicit useStepLabels.');
  const times = options.sourceTimes ?? steps.map(s => Number(s.label));
  if (times.length !== steps.length) throw new Error('sourceTimes must have one time per source frame.');
  validateTimes(times);
  return { times, load: i => steps[i].load() };
}
const xml = (s: string) => s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
/** Writes to a private staging directory, publishing only after every frame succeeds. */
export async function exportResampled(source: SequenceSource, options: ResampleOptions, output: string, signal?: AbortSignal): Promise<{ outputPath: string; frames: number }> {
  if (path.extname(output).toLowerCase() !== '.pvd') throw new Error('Resampled series output must be a .pvd file.');
  const sampler = new SequenceResampler(source, options);
  const absolute = path.resolve(output), parent = path.dirname(absolute), stem = path.basename(absolute,'.pvd');
  await fs.mkdir(parent,{recursive:true});
  const exists = async (p: string) => fs.stat(p).then(()=>true, (e: NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return false;throw e;});
  if (await exists(absolute) || await exists(path.join(parent,stem))) throw new Error('Resampling output and its companion directory must be new.');
  const staging = await fs.mkdtemp(path.join(parent,'.resample-'));
  let published = false;
  try {
    const rows: string[] = [];
    for(let i=0;i<sampler.times.length;i++) {
      signal?.throwIfAborted();
      const model = await sampler.frame(i);
      signal?.throwIfAborted();
      const name = `frame_${String(i).padStart(6,'0')}.vtu`;
      const result = await writeMeshFileAsync(model,'.vtu');
      await fs.writeFile(path.join(staging,name),result.data);
      rows.push(`    <DataSet timestep="${sampler.times[i]}" group="" part="0" file="${xml(stem+'/'+name)}"/>`);
    }
    signal?.throwIfAborted();
    await fs.rename(staging,path.join(parent,stem)); published=true;
    try { await fs.writeFile(absolute, `<?xml version="1.0"?>\n<VTKFile type="Collection" version="0.1" byte_order="LittleEndian"><Collection>\n${rows.join('\n')}\n</Collection></VTKFile>\n`, {flag:'wx'}); }
    catch(e) { await fs.rm(path.join(parent,stem),{recursive:true,force:true}); throw e; }
    return { outputPath: absolute, frames: sampler.times.length };
  } finally { sampler.clear(); if (!published) await fs.rm(staging,{recursive:true,force:true}); }
}
