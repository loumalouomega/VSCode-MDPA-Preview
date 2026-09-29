import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { discoverSeriesSteps } from './fieldSeriesScan';
import { SequenceResampler, ResampleOptions, SequenceSource, validateTimes } from './resampleSequence';
import { writeMeshFileAsync } from './writers/meshWriter';
import { pvdIndexText } from './packPvd';
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
    const rows: { timestep: number; file: string }[] = [];
    for(let i=0;i<sampler.times.length;i++) {
      signal?.throwIfAborted();
      const model = await sampler.frame(i);
      signal?.throwIfAborted();
      const name = `frame_${String(i).padStart(6,'0')}.vtu`;
      const result = await writeMeshFileAsync(model,'.vtu');
      await fs.writeFile(path.join(staging,name),result.data);
      // pvdIndexText escapes the attribute itself, so the path goes in raw.
      rows.push({ timestep: sampler.times[i], file: stem+'/'+name });
    }
    signal?.throwIfAborted();
    await fs.rename(staging,path.join(parent,stem)); published=true;
    // The index text is packPvd.ts's, so a resampled series and a packed one are
    // byte-identical in shape and this file never grows a second writer.
    try { await fs.writeFile(absolute, pvdIndexText(rows), {flag:'wx'}); }
    catch(e) { await fs.rm(path.join(parent,stem),{recursive:true,force:true}); throw e; }
    return { outputPath: absolute, frames: sampler.times.length };
  } finally { sampler.clear(); if (!published) await fs.rm(staging,{recursive:true,force:true}); }
}
