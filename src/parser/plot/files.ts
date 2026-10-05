import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { plotCsvRows, plotManifest } from "./export";
import type { PlotDataset } from "./types";
import { plotRunInputPaths } from "./runs";

/** CSV + companion paths are both checked before either can overwrite a source. */
export async function assertPlotDestination(file: string, dataset: Pick<PlotDataset,"recipe">): Promise<void> {
  const real = async (p: string) => fs.realpath(p).catch(() => path.resolve(p));
  const targets = await Promise.all([real(file), real(file + ".kratosplot.json")]);
  for (const source of dataset.recipe.sources) if (source.type !== "inline") {
    const inputs=[source.path,...(source.run?await plotRunInputPaths(source.run):[])];
    for(const input of inputs)if(targets.includes(await real(input)))throw new Error("A plot export cannot overwrite its source, run record, input or companion file.");
  }
}

/** Bounded chunks, not one write syscall per point. Full-resolution only. */
export async function writePlotCsv(file: string, dataset: PlotDataset, signal?: AbortSignal): Promise<void> {
  await assertPlotDestination(file,dataset);
  const temp = file + `.${randomUUID()}.tmp`, companion = file + ".kratosplot.json", meta = temp + ".json";
  try {
    const handle = await fs.open(temp,"wx");
    try {
      let chunk = "";
      for (const row of plotCsvRows(dataset)) {
        chunk += row;
        if (chunk.length >= 65536) { signal?.throwIfAborted(); await handle.write(chunk); chunk = ""; }
      }
      signal?.throwIfAborted(); if (chunk) await handle.write(chunk);
    } finally { await handle.close(); }
    await fs.writeFile(meta,JSON.stringify(plotManifest(dataset),null,2)+"\n",{flag:"wx"});
    signal?.throwIfAborted();
    await fs.rename(temp,file); await fs.rename(meta,companion);
  } finally { await fs.rm(temp,{force:true}); await fs.rm(meta,{force:true}); }
}
